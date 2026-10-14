// P3 成长路径：F3 月度重算（三维聚合+min 合成）+ grow-planner 任务 + 成长曲线数据
// R2.3 评分精调：情景题分数真实写入素质 40% 层；ITTO 实操计入知识维；经验硬指标自动核算
import { db, getProfile } from './db.mjs';
import { loadStandard, levelRequirements } from './standard.mjs';
import { syncLinks, linkStats, kaToDomain } from './growth-links.mjs';

// ---------- 三维评分聚合 ----------
// 知识K：卡片掌握度覆盖(60%) + ITTO 实操均分(40%)；素质C：自评20/情景40/行为40 三层信号；经验E：硬指标现值
// R3.1 情景层按指标细分：近 90 天强化营判分 → 按出题知识域聚合 → 经 YAML 映射到素质指标
// 无域数据的指标回退中性基线 0.45（cDetails.scenario_fallback 标注），全局均值仅作展示指标——
// 若回退用全局均值，训练单域会经均值抬升全部指标，达不到隔离目标
const NO_SCENARIO = 0.45;   // 无情景数据时的中性基线（与自评/行为层基线一致）
const SINCE90 = () => new Date(Date.now() - 90 * 86400000).toISOString().replace('T', ' ').slice(0, 19);

function scenarioScore() {
  const r = db.prepare(`SELECT AVG(CASE grade WHEN 'good' THEN 1 WHEN 'ok' THEN 0.7 ELSE 0.4 END) v
                        FROM drill_records WHERE grade IS NOT NULL AND created_at >= ?`).get(SINCE90());
  return r?.v ?? null;
}

// 域分：{domain: 0..1}（存量记录 domain 为空则忽略，该指标走全局回退）
function scenarioDomainScores() {
  const rows = db.prepare(`SELECT domain, AVG(CASE grade WHEN 'good' THEN 1 WHEN 'ok' THEN 0.7 ELSE 0.4 END) v
                           FROM drill_records
                           WHERE grade IS NOT NULL AND domain IS NOT NULL AND created_at >= ?
                           GROUP BY domain`).all(SINCE90());
  return Object.fromEntries(rows.map((r) => [r.domain, +r.v.toFixed(3)]));
}

// 指标情景分：多个域命中同一指标时取均值；映射读 indicator-training-map.yaml（零硬编码）
function scenarioScoreByIndicator(domainScores) {
  const map = loadStandard('indicator-training-map').domain_indicators ?? {};
  const byInd = {};
  for (const [dom, inds] of Object.entries(map)) {
    const v = domainScores[dom];
    if (v == null) continue;
    for (const ind of inds ?? []) (byInd[ind] ??= []).push(v);
  }
  return Object.fromEntries(
    Object.entries(byInd).map(([ind, vs]) => [ind, +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(3)]),
  );
}

// ITTO 实操层：知识域均分（itto_practice join 过程取知识域）
// R3.5 口径修复：过程 ka 为 PMBOK 中文域（整合/范围…），须经 pmbok_ka_domain 归一到国标 17 域 key，
// 否则与 kDetails 键永不匹配（实操 40% 层此前实际未并入，属既有缺陷）
function ittoDomainScores() {
  const rows = db.prepare(`SELECT p.ka ka, AVG(pr.score/100.0) v FROM itto_practice pr
                           JOIN itto_processes p ON p.id = pr.process_id
                           WHERE pr.score IS NOT NULL GROUP BY p.ka`).all();
  const out = {};
  for (const r of rows) {
    const dom = kaToDomain(r.ka);
    if (dom) out[dom] = +(out[dom] != null ? (out[dom] + r.v) / 2 : r.v).toFixed(2);
  }
  return out;
}

// 起止时间容错解析："2018" / "2021-06" / "2026-10-08" 三种写法（缺失 end 视为进行中）
function toMs(s, end = false) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  if (/^\d{4}$/.test(t)) return Date.UTC(+t, end ? 11 : 0, end ? 31 : 1);
  if (/^\d{4}-\d{2}$/.test(t)) return Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, end ? 28 : 1);
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

// 合并重叠区间求真实管理年限（项目并行不重复计年）
function unionYears(intervals) {
  const iv = intervals.filter(Boolean)
    .map(([s, e]) => [Math.min(s, e), Math.max(s, e)])
    .sort((a, b) => a[0] - b[0]);
  let total = 0, s0 = null, e0 = null;
  for (const [s, e] of iv) {
    if (s0 == null) { s0 = s; e0 = e; continue; }
    if (s <= e0) e0 = Math.max(e0, e);
    else { total += e0 - s0; s0 = s; e0 = e; }
  }
  if (s0 != null) total += e0 - s0;
  return total / (365.25 * 86400000);
}

// 经验硬指标自动核算（只增不减：自动值超过现值才上调，手改的高值不被覆盖）
// R3.1 口径修正：项目按名称去重（重复登记不重复计数）；年限由起止时间自动推算（下限，不覆盖手填高值）
export function refreshExperienceStats() {
  const cur = Object.fromEntries(db.prepare('SELECT key, value FROM experience_stats').all().map((r) => [r.key, r.value]));
  const raised = {};
  const put = (k, v) => {
    if (v == null) return;
    if (cur[k] == null || Number(v) > Number(cur[k])) {
      db.prepare(`INSERT INTO experience_stats (key, value) VALUES (?,?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, String(v));
      raised[k] = { from: cur[k] ?? null, to: v };
    }
  };
  // 项目去重（同名只计一次）
  const seen = new Set(); const uniq = [];
  for (const r of db.prepare('SELECT name, complexity, role, start_date, end_date FROM projects').all()) {
    const key = String(r.name ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key); uniq.push(r);
  }
  const nowMs = Date.now();
  const span = (r) => { const s = toMs(r.start_date); return s == null ? null : [s, toMs(r.end_date, true) ?? nowMs]; };
  const isComplex = (r) => /complex/i.test(r.complexity ?? '');
  const isProgram = (r) => /program|portfolio/i.test(r.complexity ?? '');
  const isPm = (r) => /经理|PM\b/i.test(r.role ?? '') || !r.role;   // 项目经理/高级项目经理/群组经理/PM 均为管理角色

  put('managed_projects', uniq.length);                                    // 保留展示口径（成长记录页兼容）
  put('complex_projects', uniq.filter((r) => isComplex(r) || isProgram(r)).length);
  // 国标 experience_requirements 指标名口径（可直接参与 E 维满足率）
  put('projects_achieved', uniq.filter((r) => !isComplex(r) && !isProgram(r)).length);
  put('complex_projects_as_lead', uniq.filter(isComplex).length);
  put('programs_as_lead', uniq.filter(isProgram).length);
  const pmYears = +unionYears(uniq.filter(isPm).map(span)).toFixed(1);
  const domainYears = +unionYears(uniq.map(span)).toFixed(1);
  if (domainYears > 0) put('pm_domain_years', domainYears);
  if (pmYears > 0) put('pm_years', pmYears);
  // 知识贡献：案例/培训类证据 + 有来源会话的去重计数
  put('knowledge_contributions',
    db.prepare(`SELECT (SELECT COUNT(*) FROM evidence WHERE type IN ('case','training')) + (SELECT COUNT(DISTINCT source_session) FROM evidence WHERE source_session IS NOT NULL) c`).get().c);
  return raised;
}

export function computeScores() {
  const p = getProfile();
  const g = loadStandard('gbt41831');
  const target = `L${p.target_level}`;

  // K：目标级深度矩阵覆盖（卡片 reps≥2 记掌握；无卡片领域按 0.4 基线）×60% + ITTO 实操域均分 ×40%
  const cards = db.prepare('SELECT domain, SUM(CASE WHEN reps>=2 THEN 1 ELSE 0 END) mastered, COUNT(*) total FROM knowledge_cards GROUP BY domain').all();
  const cardMap = Object.fromEntries(cards.map((c) => [c.domain, c]));
  const ittoMap = ittoDomainScores();
  const depthRank = { know: 1, apply: 2, integrate: 3 };
  let kSum = 0; const kDetails = {};
  for (const [dom, d] of Object.entries(g.knowledge_domains)) {
    const need = depthRank[d.depth[target]];
    const m = cardMap[dom];
    const cov = m && m.total ? m.mastered / m.total : 0;
    let score = Math.min(1, 0.35 + cov * 0.65) * (need <= 2 ? 1 : 0.95);  // 简化覆盖模型
    if (ittoMap[dom] != null) score = score * 0.6 + ittoMap[dom] * 0.4;   // 实操成绩并入（R2.3）
    kDetails[dom] = +score.toFixed(2); kSum += score;
  }
  const K = +(kSum / 17).toFixed(2);

  // C：29 指标三层信号（自评 0.2 / 情景 0.4 / 行为 0.4；情景=近90天强化营综合表现 R2.3）
  const rows = db.prepare(`SELECT indicator_id,
    AVG(behavior_score) behavior FROM competency_scores WHERE behavior_score IS NOT NULL GROUP BY indicator_id`).all();
  const beh = Object.fromEntries(rows.map((r) => [r.indicator_id, r.behavior]));
  const scen = scenarioScore();                       // 全局均值：仅作展示指标（不参与指标级回退）
  const scenByInd = scenarioScoreByIndicator(scenarioDomainScores());   // R3.1：指标级情景分
  const req = levelRequirements(p.target_level, p.track);
  const required = [...req.competency.environmental_personal, ...req.competency.technical];
  let cSum = 0; const cDetails = {};
  for (const [id, def] of Object.entries(g.competencies)) {
    const selfV = 0.6;                                        // 自评层基线（结构位保留）
    const behV = beh[id] != null ? beh[id] : 0.45;            // 行为层：证据或基线
    const indScen = scenByInd[id];                            // 该指标对应知识域的情景分
    const scenV = indScen != null ? indScen : NO_SCENARIO;    // 无域数据 → 中性基线（不回退全局均值）
    let s = 0.2 * selfV + 0.4 * scenV + 0.4 * behV;
    if (beh[id] != null) s = Math.max(s, 0.3 + beh[id] * 0.7); // 有行为证据时取两者较优（鼓励实证）
    s = Math.max(0, Math.min(1, s));
    cDetails[id] = {
      score: +s.toFixed(2), name: def.name, category: def.category, required: required.includes(id),
      scenario: indScen ?? null,                              // 指标级情景分（无则 null）
      scenario_fallback: indScen == null,                     // 诚实标注：该指标无域数据，取全局回退
    };
    if (required.includes(id)) cSum += s;
  }
  const C = required.length ? +(cSum / required.length).toFixed(2) : 0;

  // E：硬指标满足率（重算前先自动核算现值，只增不减；experience_raised 记录本次自动上调项供审计）
  const expRaised = refreshExperienceStats();
  const stats = Object.fromEntries(db.prepare('SELECT key, value FROM experience_stats').all().map((r) => [r.key, r.value]));
  const expReqs = req.experience;
  let met = 0;
  for (const e of expReqs) {
    const v = stats[e.metric];
    const altV = e.alt ? stats[e.alt.metric] : null;      // R3.1 修正：备选须比对备选指标自身的值
    if (v != null && v >= e.value) met += 1;
    else if (altV != null && e.alt && altV >= e.alt.value) met += 1;
  }
  const E = expReqs.length ? +(met / expReqs.length).toFixed(2) : 0;

  // 合成：短板原则 min，映射到等级（0.85+达标该级）
  const lvlOf = (x) => Math.max(1, Math.min(5, Math.floor(x / 0.2)));   // 0.2/级近似
  const kL = lvlOf(K), cL = lvlOf(C), eL = lvlOf(E);
  const composite = Math.min(kL, cL, eL);

  return {
    K, C, E, k_level: kL, c_level: cL, e_level: eL, composite,
    kDetails, cDetails, met, total_reqs: expReqs.length,
    scenario: scen, scenario_by_indicator: scenByInd, experience_raised: expRaised,
  };
}

// ---------- F3 月度重算（写 assessments + 差距报告 + 生成/调整任务） ----------
export function monthlyRecalc() {
  const p = getProfile();
  const s = computeScores();
  const req = levelRequirements(p.target_level, p.track);
  // 差距：素质未达标项（无行为证据）+ 经验未满足硬指标
  const gap = {
    level: p.current_level, target: p.target_level,
    composite: s.composite,
    dims: { knowledge: s.K, competency: s.C, experience: s.E },
    competency_gaps: Object.entries(s.cDetails).filter(([, v]) => v.required && v.score < 0.7).map(([k]) => k).slice(0, 8),
    experience_gaps: req.experience.filter((e) => {
      const v = db.prepare('SELECT value FROM experience_stats WHERE key=?').get(e.metric)?.value;
      const av = e.alt ? db.prepare('SELECT value FROM experience_stats WHERE key=?').get(e.alt.metric)?.value : null;
      return !((v != null && v >= e.value) || (av != null && av >= e.alt.value));
    }).map((e) => e.metric),
  };
  db.prepare('INSERT INTO assessments (k_level, c_level, e_level, composite_level, gap_report) VALUES (?,?,?,?,?)')
    .run(s.k_level, s.c_level, s.e_level, s.composite, JSON.stringify(gap));

  // R2.3 闭环链：建新差距链接 + 关闭达标链接（分数变化可追溯）
  const links = syncLinks(s);

  // grow-planner：给 top 素质差距生成训练任务（幂等：同类 open 不重复）
  for (const ind of gap.competency_gaps.slice(0, 3)) {
    const dup = db.prepare(`SELECT id FROM training_tasks WHERE indicator_id=? AND status='open'`).get(ind);
    if (!dup) {
      db.prepare(`INSERT INTO training_tasks (title, type, indicator_id, source) VALUES (?,?,?,?)`)
        .run(`弱项训练：${ind}（教练场景实战 + 专项卡复习）`, '教练训练', ind, '月度重算');
    }
  }
  return { ...s, gap, links, tasks: db.prepare(`SELECT * FROM training_tasks ORDER BY status, id DESC LIMIT 10`).all() };
}

// ---------- R2.3 成长月报（Markdown）：三维变化 + 闭环率 + 差距与训练 + 下月任务 ----------
export function monthlyReport() {
  const p = getProfile();
  const prev = db.prepare('SELECT * FROM assessments ORDER BY id DESC LIMIT 1').get();      // 最近一次（含本次）
  const before = db.prepare('SELECT * FROM assessments ORDER BY id DESC LIMIT 2 OFFSET 0').all()[1];
  if (!prev) throw new Error('还没有月度重算记录，请先执行一次月度重算。');
  const cur = JSON.parse(prev.gap_report ?? '{}');
  const d = (a, b) => (a != null && b != null ? +(a - b).toFixed(2) : null);
  const delta = before ? {
    knowledge: d(cur.dims?.knowledge, JSON.parse(before.gap_report || '{}')?.dims?.knowledge),
    competency: d(cur.dims?.competency, JSON.parse(before.gap_report || '{}')?.dims?.competency),
    experience: d(cur.dims?.experience, JSON.parse(before.gap_report || '{}')?.dims?.experience),
  } : null;
  const stats = linkStats();
  const fmt = (v) => (v == null ? '—' : v > 0 ? `+${v}` : `${v}`);
  const arrow = (v) => (v == null ? '' : v > 0 ? ' ↑' : v < 0 ? ' ↓' : ' →');
  const md = [
    `# PM-Master 成长月报（${new Date().toISOString().slice(0, 10)}）`,
    '',
    `**档案**：当前 L${p.current_level} → 目标 L${p.target_level}（${p.track === 'pmo' ? 'PMO' : '项目/项目群组'}通道）`,
    '',
    '## 一、本月三维变化',
    '',
    `| 维度 | 本月 | 较上月 |`,
    `|---|---|---|`,
    `| 知识 K | ${cur.dims?.knowledge ?? '—'} | ${delta ? fmt(delta.knowledge) + arrow(delta.knowledge) : '—'} |`,
    `| 素质 C | ${cur.dims?.competency ?? '—'} | ${delta ? fmt(delta.competency) + arrow(delta.competency) : '—'} |`,
    `| 经验 E | ${cur.dims?.experience ?? '—'} | ${delta ? fmt(delta.experience) + arrow(delta.experience) : '—'} |`,
    `| 合成等级 | L${prev.composite_level} | 短板原则 |`,
    '',
    '## 二、成长闭环',
    '',
    `- 差距链接：共 ${stats.total} 条（open ${stats.open} / trained ${stats.trained} / closed ${stats.closed}）`,
    `- 闭环率：${stats.closure_rate != null ? (stats.closure_rate * 100).toFixed(0) + '%' : '—'}（closed / 全部链接）`,
    stats.trained ? `- 训练中：${stats.items.filter((x) => x.status === 'trained').slice(0, 5).map((x) => x.label).join('、')}` : '',
    '',
    '## 三、当前差距与训练建议',
    '',
    ...(cur.competency_gaps?.length ? [`- 素质差距：${cur.competency_gaps.join('、')}`] : []),
    ...(cur.experience_gaps?.length ? [`- 经验缺口：${cur.experience_gaps.join('、')}`] : []),
    '- 建议：差距项对应教练场景实战（演练场）+ 知识域工具实操（知识库）+ 情景题保持手感（强化营）。',
    '',
    '## 四、下月训练任务',
    '',
    ...db.prepare(`SELECT title, status FROM training_tasks ORDER BY status, id DESC LIMIT 5`).all()
      .map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`),
    '',
    '---',
    '由 PM-Master F3 月度重算自动生成。',
  ].filter((l) => l !== '').join('\n');
  return { markdown: md, stats };
}

export function history() {
  // R5.1 WP3：同日多次重算只留最后一条（趋势图 x 轴同日并列问题清偿）
  return db.prepare(`SELECT id, k_level, c_level, e_level, composite_level, created_at FROM assessments
                     WHERE id IN (SELECT MAX(id) FROM assessments GROUP BY date(created_at))
                     ORDER BY id`).all();
}
