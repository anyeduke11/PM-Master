// GROW 教练会话状态机（PRD 5.7.4 Flow 2 + 10 迁移方案）
// 服务端规则控制阶段推进（确定性），LLM 负责生成内容与收集（能力层分离）
// 状态: G → R(R1+Why*) → O → W → E(评定) → A(归档/CLOSED)
import { loadStandard } from './standard.mjs';
import { db, getProfile } from './db.mjs';
import { coachChat, ratingChat } from './agent.mjs';
import { markTrained } from './growth-links.mjs';
import { extractFromSession } from './memory.mjs';   // R7.0 P4 归档即提取记忆（失败不反噬归档）
import { badRequest, notFound, conflict, forbidden } from './errors.mjs';   // R6.4 错误风格

// ---------- 场景装载（indicator-training-map.yaml + 等级解锁） ----------
export function listScenarios() {
  const map = loadStandard('indicator-training-map');
  const g = loadStandard('gbt41831');
  const { current_level } = getProfile();
  const unlockMap = { L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 };
  return Object.entries(map.coach_scenarios).map(([id, s]) => {
    const need = s.unlock ? unlockMap[s.unlock] : (current_level >= 2 ? 1 : 2); // 六场景 L2 解锁；L1 仅微训练
    const unlocked = s.unlock ? current_level >= need : current_level >= 2;
    return {
      id, name: s.name, combo: s.combo, indicators: s.indicators,
      unlock_level: s.unlock ?? 'L2',
      unlocked,
      journey: g.product_adaptation.journey[`L${current_level}`],
    };
  });
}
export function getScenario(id) {
  const s = listScenarios().find((x) => x.id === id);
  if (!s) throw notFound(`unknown scenario: ${id}`);
  return s;
}

// ---------- 阶段定义（服务端确定性控制） ----------
const PHASES = ['G', 'R', 'O', 'W', 'E'];
export function phasePlan(mode) {
  const whyLayers = mode === 'fast' ? 3 : 5;
  return {
    G: { title: '目标', steps: ['首要目标', '理想结果', '底线接受'] },
    R: { title: '现状', steps: ['R-1 事实梳理(5W1H)', ...Array.from({ length: whyLayers }, (_, i) => `R-2 第${i + 1}/${whyLayers}个为什么`)] },
    O: { title: '选项', steps: ['O-1 策略选择(评估维度)', 'O-2 二阶推演(二阶思维)'] },
    W: { title: '行动', steps: ['W-1 生成方案(SMART+话术)'] },
    E: { title: '评定', steps: [] }, // E 由 close 流程执行
  };
}

// ---------- 会话存取 ----------
// 场景开场补充语（可选；无则通用开场）
const SCENARIO_NOTE = {
  kickoff: '（本场景将走商业论证三性验证 + S形曲线定位 + 护城河检验）',
  milestone: '（本场景核心练习：继续/转向/终止决策，警惕沉没成本谬误）',
  handover: '（本场景核心练习：验收标准前置核查 + 帕累托聚焦关键交付）',
  incentive: '（本场景组合 C09：需求层次诊断→皮格马利翁效应→社会认同）',
  portfolio: '（L5 核心场景：选择与平衡——系统思考 + 组合权衡）',
  lessons: '（本场景产物可直接沉淀为知识贡献证据——费曼闭环 M3）',
};

export function createSession({ scenario: scenarioId, mode = 'standard' }) {
  const sc = getScenario(scenarioId);
  if (!sc.unlocked) throw forbidden(`场景「${sc.name}」在当前等级未解锁（需 ${sc.unlock_level}）`);
  const info = db.prepare(`INSERT INTO coach_sessions (scenario, mode, grow_data) VALUES (?,?,?)`)
    .run(scenarioId, mode, JSON.stringify({ phase: 'G', step: 0, mode, collected: {}, history: [] }));
  const session = loadSession(info.lastInsertRowid);
  const note = SCENARIO_NOTE[scenarioId] ?? '';
  const opening = `「${sc.name}」场景启动${note}（推荐组合 ${Array.isArray(sc.combo) ? sc.combo.join('+') : sc.combo}，模式：${mode === 'fast' ? '快速' : '标准'}）。\n\n${askNext(session)}`;
  pushMsg(session, 'ai', opening);
  save(session);
  return view(session, opening);
}
export function loadSession(id) {
  const row = db.prepare('SELECT * FROM coach_sessions WHERE id=?').get(id);
  if (!row) throw notFound(`session ${id} not found`);
  return { id: row.id, row, data: JSON.parse(row.grow_data) };
}
function save(s) {
  db.prepare('UPDATE coach_sessions SET grow_data=? WHERE id=?').run(JSON.stringify(s.data), s.id);
}
function pushMsg(s, role, content) { s.data.history.push({ role, content }); }
function view(s, lastReply) {
  const plan = phasePlan(s.data.mode);
  const phase = s.data.phase;
  return {
    id: s.id, scenario: s.row.scenario, mode: s.data.mode,
    phase, phase_title: plan[phase]?.title ?? '已关闭',
    step: s.data.step, steps: plan[phase]?.steps ?? [],
    collected: s.data.collected, closed: !!s.row.closed_at,
    history: s.data.history, last_reply: lastReply,
  };
}

// ---------- 下一问生成（LLM 内容层） ----------
function askNext(s) {
  const plan = phasePlan(s.data.mode);
  const { phase, step } = s.data;
  const topic = plan[phase]?.steps?.[step];
  if (topic === undefined) return '';
  const ask = ASK_TEMPLATES[phase](topic, s);
  return ask;
}
const ASK_TEMPLATES = {
  G: (t) => `【G · ${t}】这次你最想达成的${t === '首要目标' ? '首要目标是什么？（一次沟通只推动一个目标）' : t === '理想结果' ? '理想结果是什么？请用一两句话描述' : '底线是什么？最差能接受什么'}`,
  R: (t) => `【R · ${t}】${t.startsWith('R-1') ? '请用5W1H梳理事实：发生了什么/何时开始/涉及谁/已做措施及效果？（不确定可标"待确认"）' : `追问根因：为什么会有上一层的原因？（${t}）`}`,
  O: (t) => `【O · ${t}】${t.startsWith('O-1') ? '基于根因，列出2-3条策略并按建设性/风险可控/速度评估，你倾向哪条？' : '对你选的路线做二阶推演：做了X之后会发生什么？之后又会怎样？'}`,
  W: () => `【W · 生成方案】我将为你生成 SMART 行动方案+关键话术，你有什么必须包含的要求吗？（没有则回复"直接生成"）`,
  E: () => '',
};

// ---------- 用户消息推进 ----------
export async function handleMessage(id, content) {
  const s = loadSession(id);
  if (s.row.closed_at) throw conflict('会话已关闭');
  const plan = phasePlan(s.data.mode);
  let phase = s.data.phase, step = s.data.step;

  pushMsg(s, 'user', content);

  // LLM：生成对本轮回答的教练回应 + 提炼收集数据（结构化）
  const { reply, collected } = await coachChat({
    profile: getProfile(),
    scenario: getScenario(s.row.scenario),
    phase, stepInfo: plan[phase]?.steps?.[step] ?? '',
    history: s.data.history.slice(-16),
    userContent: content,
  });
  Object.assign(s.data.collected, collected ?? {});

  // 规则层：W 首步确认后直接产出方案；其余按步推进
  const steps = plan[phase]?.steps ?? [];
  step += 1;
  let generated = null;
  if (step >= steps.length) { // 阶段完成
    if (phase === 'W') {
      generated = await generateWill(s); // W 产物
      pushMsg(s, 'ai', generated);
      phase = 'E'; step = 0;
    } else {
      const next = PHASES[PHASES.indexOf(phase) + 1];
      phase = next; step = 0;
    }
  }
  s.data.phase = phase; s.data.step = step;

  const ask = askNext(s);
  const full = [reply, generated, ask].filter(Boolean).join('\n\n');
  if (full) pushMsg(s, 'ai', full);
  save(s);
  return view(s, full);
}

// W 产物生成（GROW W 阶段大输出）
async function generateWill(s) {
  const { will } = await coachChat({
    profile: getProfile(),
    scenario: getScenario(s.row.scenario),
    phase: 'W-OUT', stepInfo: '生成完整方案',
    history: s.data.history.slice(-30),
    userContent: '__GENERATE_WILL__',
  });
  s.data.collected.will = will ?? '';
  return `【W · 行动方案】\n${will ?? '（方案生成中，可重试）'}`;
}

// ---------- 流程控制（/skip /back /fast /status） ----------
export function control(id, cmd) {
  const s = loadSession(id);
  if (s.row.closed_at) throw conflict('会话已关闭');
  const plan = phasePlan(s.data.mode);
  let note = '';
  if (cmd === 'skip') {
    const steps = plan[s.data.phase]?.steps ?? [];
    if (s.data.step + 1 >= steps.length) { const p = PHASES[PHASES.indexOf(s.data.phase) + 1]; s.data.phase = p; s.data.step = 0; }
    else s.data.step += 1;
    note = `已跳过当前步骤 → ${s.data.phase} 第${s.data.step + 1}步`;
    const ask = askNext(s); if (ask) pushMsg(s, 'ai', ask);
  } else if (cmd === 'back') {
    const i = PHASES.indexOf(s.data.phase);
    if (s.data.step > 0) s.data.step -= 1;
    else if (i > 0) { s.data.phase = PHASES[i - 1]; s.data.step = 0; }
    note = `已返回 → ${s.data.phase} 第${s.data.step + 1}步（此前回答保留可修改）`;
    const ask = askNext(s); if (ask) pushMsg(s, 'ai', ask);
  } else if (cmd === 'fast') {
    s.data.mode = 'fast'; note = '已切换快速模式：R 阶段追问缩减为 3 层（当前进度若已超出则直接进入 O）';
    const plan2 = phasePlan('fast'); const r = plan2.R.steps.length;
    if (s.data.phase === 'R' && s.data.step >= r) { s.data.phase = 'O'; s.data.step = 0; }
  } else if (cmd === 'status') {
    note = `当前 ${s.data.phase}（${plan[s.data.phase]?.title}）第${s.data.step + 1}/${(plan[s.data.phase]?.steps ?? []).length}步 · 模式 ${s.data.mode}`;
  } else throw badRequest(`unknown cmd: ${cmd}`);
  pushMsg(s, 'system', note); save(s);
  return { ...view(s, note), note };
}

// ---------- E 评定 + A 归档（关闭钩子，PRD 5.7.4 / 10） ----------
const GRADE_SCORE = { 良好: 0.85, 合格: 0.7, 待提升: 0.5 };
export async function closeSession(id, { projectId = null } = {}) {
  const s = loadSession(id);
  if (s.row.closed_at) return JSON.parse(s.row.grow_data).closing;
  const sc = getScenario(s.row.scenario);

  // E：AI 评定（引用会话依据），指标限定场景映射指标（防泛化）
  const { ratings, artifact_summary } = await ratingChat({
    profile: getProfile(), scenario: sc, history: s.data.history,
  });
  const valid = Array.isArray(ratings) ? ratings.filter((r) => sc.indicators.includes(r.indicator)) : [];

  db.prepare(`UPDATE coach_sessions SET rating=?, rating_evidence=?, project_id=?, closed_at=datetime('now','localtime') WHERE id=?`)
    .run(JSON.stringify(valid), JSON.stringify(ratings), projectId, id);

  // 素质分流水（行为证据层）
  for (const r of valid) {
    db.prepare(`INSERT INTO competency_scores (indicator_id, behavior_score, evidence_refs) VALUES (?,?,?)`)
      .run(r.indicator, GRADE_SCORE[r.grade] ?? 0.6, JSON.stringify([{ session: id, quote: r.evidence }]));
  }
  // 证据归档（W 产物 → 案例/汇报类证据，多体系打标）
  const ev = db.prepare(`INSERT INTO evidence (type, title, description, tags, source_session) VALUES (?,?,?,?,?)`)
    .run('case', `教练产物 · ${sc.name} · ${new Date().toISOString().slice(0, 10)}`,
      artifact_summary || s.data.collected.will || '',
      JSON.stringify(['CSPM 行为证据', 'PMP PDU', 'PRINCE2 CPD', ...sc.indicators]), id);

  // R2.3 闭环链：训练信号（本次评定的指标 → 命中 open 差距链接置 trained）
  for (const r of valid) markTrained({ indicator: r.indicator, evidenceId: ev.lastInsertRowid });

  const closing = { ratings: valid, evidence_id: ev.lastInsertRowid, artifact_summary };
  s.data.closing = closing; save(s);
  // R7.0 P4 记忆自动提取（归档即提取；失败不反噬归档——记忆是增量通道）
  try { await extractFromSession({ ...sc, session_id: id }, closing); } catch { /* 静默降级：无记忆不影响归档 */ }
  return closing;
}
