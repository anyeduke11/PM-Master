// P2 实战线核心：EVM 计算 + 容差引擎（纯代码规则，PRD 4.6.5 度量→例外管线）
// 规则交给代码，判断交给 AI：超容差 → 生成 alerts → 前端建议进入 C13 例外应对教练场景
import { db } from './db.mjs';
import { weeklyChat, riskChat } from './agent.mjs';
import { getProfile } from './db.mjs';
import { hintsFor } from './context-hints.mjs';
import { notFound } from './errors.mjs';   // R6.4 错误风格
import { loadStandard } from './standard.mjs';

// ---------- EVM（PMP 度量域公式，代码计算） ----------
export function evm({ pv, ev, ac }) {
  if (![pv, ev, ac].every((x) => typeof x === 'number' && x > 0)) return null;
  const sv = ev - pv, cv = ev - ac;
  const spi = +(ev / pv).toFixed(3), cpi = +(ev / ac).toFixed(3);
  // EAC 三公式取常用：BAC/CPI（按当前成本效率延续）；BAC 从项目容差配置或传参
  return { pv, ev, ac, sv, cv, spi, cpi, eac: null };
}

// ---------- 容差引擎（PRINCE2 六维；P1 先落 cost/time 两维量化） ----------
export function checkTolerances(project, evmResult) {
  const tol = JSON.parse(project.tolerances ?? '{}');
  const violations = [];
  if (evmResult && tol.cost) {
    // 成本容差：CPI 下限 = 1 - cost（如 ±10% → CPI<0.9 预警）
    const floor = +(1 - tol.cost).toFixed(3);
    if (evmResult.cpi < floor) {
      violations.push({
        dimension: 'cost', value: evmResult.cpi, threshold: floor,
        message: `成本偏差超容差：CPI ${evmResult.cpi} < 下限 ${floor}（容差 ±${tol.cost * 100}%）`,
      });
    }
  }
  if (evmResult && tol.time) {
    const floor = +(1 - tol.time).toFixed(3);
    if (evmResult.spi < floor) {
      violations.push({
        dimension: 'time', value: evmResult.spi, threshold: floor,
        message: `进度偏差超容差：SPI ${evmResult.spi} < 下限 ${floor}（容差 ±${tol.time * 100}%）`,
      });
    }
  }
  // 写 alerts（幂等：同项目同维度 open 状态不重复）
  for (const v of violations) {
    const dup = db.prepare(`SELECT id FROM alerts WHERE project_id=? AND dimension=? AND status='open'`).get(project.id, v.dimension);
    if (!dup) {
      db.prepare(`INSERT INTO alerts (project_id, dimension, value, threshold, message) VALUES (?,?,?,?,?)`)
        .run(project.id, v.dimension, v.value, v.threshold, v.message);
    }
  }
  return violations;
}

// ---------- 周报生成（LLM 内容层；数据由代码装配） ----------
export async function generateWeekly(projectId, { pv, ev, ac }) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!project) throw notFound('project not found');
  const e = evm({ pv, ev, ac });
  checkTolerances(project, e);   // 生成同时跑容差（黄金闭环入口）

  const risks = db.prepare(`SELECT title, probability, impact, strategy, is_issue FROM risks WHERE project_id=? AND status='open' LIMIT 5`).all(projectId);
  const actions = db.prepare('SELECT title, owner, due_date, status FROM action_items WHERE project_id=? ORDER BY due_date LIMIT 6').all(projectId);
  const stakeholders = db.prepare('SELECT name, current_engagement, desired_engagement FROM stakeholders WHERE project_id=? LIMIT 5').all(projectId);

  const { markdown } = await weeklyChat({
    profile: getProfile(),
    context: {
      project: { name: project.name, complexity: project.complexity },
      evm: e, risks, actions, stakeholders,
      openAlerts: db.prepare(`SELECT dimension, message FROM alerts WHERE project_id=? AND status='open'`).all(projectId),
    },
  });
  const week = `W${Math.ceil(((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 86400000 + 1) / 7)}`;
  const info = db.prepare(`INSERT INTO project_artifacts (project_id, type, title, content, evm) VALUES (?,?,?,?,?)`)
    .run(projectId, 'weekly', `${project.name} · ${new Date().getFullYear()}-${week} 周报`, markdown ?? '（生成失败，可重试）', JSON.stringify({ pv, ev, ac }));
  // R2.4 W1.3 智能关联：超容差 → 根因分析工具提示卡（卡片式，不打断）
  const hints = violations.length ? hintsFor('cpi_anomaly') : [];
  return { id: info.lastInsertRowid, evm: e, markdown, hints, alerts: db.prepare(`SELECT * FROM alerts WHERE project_id=? AND status='open'`).all(projectId) };
}

// ---------- W3.3 多项目组合视图（纯代码聚合；供 portfolio 场景训练与 L4/L5 组合治理） ----------
// R3.3：收益填真值（projects.benefit_target/actual，无值回退产物量+EVM 近似并前端标注）+ 资源冲突矩阵
export function portfolioOverview() {
  const projects = db.prepare('SELECT id, name, complexity, tolerances, benefit_target, benefit_actual FROM projects ORDER BY id').all();
  const tier = (v) => (v >= 0.67 ? 2 : v >= 0.34 ? 1 : 0);   // 低/中/高 三档

  // 跨项目风险热力：3×3（可能性×影响），每格放 风险条目（含项目名）
  const cells = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => []));
  const riskRows = db.prepare(`SELECT r.title, r.probability, r.impact, r.is_issue, p.name project_name
                               FROM risks r JOIN projects p ON p.id=r.project_id WHERE r.status='open'`).all();
  for (const r of riskRows) cells[tier(r.impact)][tier(r.probability)].push(r);

  // 各项目卡：风险计数 / 越界预警 / 产物量 / 最近 EVM / 收益（R3.3）
  const items = projects.map((p) => {
    const rc = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN probability*impact >= 0.49 THEN 1 ELSE 0 END) high
                           FROM risks WHERE project_id=? AND status='open'`).get(p.id);
    const openAlerts = db.prepare(`SELECT dimension, message FROM alerts WHERE project_id=? AND status='open'`).all(p.id);
    const artifactCount = db.prepare(`SELECT COUNT(*) c FROM project_artifacts WHERE project_id=?`).get(p.id).c;
    const lastEvm = db.prepare(`SELECT evm FROM project_artifacts WHERE project_id=? AND type='weekly' AND evm IS NOT NULL ORDER BY id DESC LIMIT 1`).get(p.id);
    return {
      id: p.id, name: p.name, complexity: p.complexity,
      risk_total: rc.total, risk_high: rc.high ?? 0, alert_count: openAlerts.length,
      artifact_count: artifactCount, cpi: lastEvm ? JSON.parse(lastEvm.evm).cpi ?? null : null,
      alerts: openAlerts,
      benefit: p.benefit_target != null
        ? { target: p.benefit_target, actual: p.benefit_actual,
            rate: p.benefit_actual != null && p.benefit_target ? +(p.benefit_actual / p.benefit_target).toFixed(2) : null }
        : null,                                    // null = 未填，前端回退近似并标注
    };
  });

  const rc = resourceConflicts();
  return {
    items,
    heat: cells,                                  // heat[impactTier][probTier] = [risk...]
    benefit: {
      filled: items.filter((p) => p.benefit).length,
      total: items.length,
      note: '未填收益的项目回退「产物量+EVM 现值」近似（前端标注）',
    },
    resource_conflicts: rc,
    summary: {
      projects: projects.length,
      open_risks: riskRows.length,
      open_alerts: items.reduce((a, b) => a + b.alert_count, 0),
      high_risks: riskRows.filter((r) => r.probability * r.impact >= 0.49).length,
      resource_conflicts: rc.conflict_count,
    },
  };
}

// R3.3 资源冲突矩阵：同一资源（action_items.owner / stakeholders.name）跨项目聚合
// R4.1 WP2：资源名归一后匹配（NFKC 全半角折叠 + 大小写 + 连续空白收缩 + trim）；显示名保留首见原文
// R4.1 WP3：高权力阈值出硬编码，读 indicator-training-map.yaml workbench 段（1-10 分制，PMP 方格三档近似）
// 冲突定义：同一资源出现在 ≥2 个项目（有开放行动项或有干系人角色）
const HIGH_POWER = Number(loadStandard('indicator-training-map').workbench?.high_power_threshold ?? 7);
const normName = (raw) => String(raw).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function resourceConflicts() {
  const by = new Map();
  const get = (raw) => {
    const key = normName(raw);
    let r = by.get(key);
    if (!r) { r = { name: String(raw).trim(), projects: new Set(), open_actions: 0, done_actions: 0, high_power: 0, stakeholder_in: 0 }; by.set(key, r); }
    return r;
  };
  for (const a of db.prepare(`SELECT a.owner owner, p.name project_name, a.status
                              FROM action_items a JOIN projects p ON p.id=a.project_id
                              WHERE a.owner IS NOT NULL AND TRIM(a.owner) <> ''`).all()) {
    if (!normName(a.owner)) continue;   // 全角空白等归一后为空名 → 在建档前跳过
    const r = get(a.owner);
    r.projects.add(a.project_name);
    if (a.status === 'done') r.done_actions += 1; else r.open_actions += 1;
  }
  for (const s of db.prepare(`SELECT s.name name, s.power power, p.name project_name
                              FROM stakeholders s JOIN projects p ON p.id=s.project_id
                              WHERE s.name IS NOT NULL AND TRIM(s.name) <> ''`).all()) {
    if (!normName(s.name)) continue;
    const r = get(s.name);
    r.projects.add(s.project_name);
    if (s.power >= HIGH_POWER) r.high_power += 1;
  }
  const resources = [...by.values()].map((r) => ({ ...r, project_count: r.projects.size, projects: [...r.projects] }));
  const conflicts = resources.filter((r) => r.project_count >= 2);
  // 3×3 热力：纵 = 涉及项目数（1 / 2 / ≥3），横 = 开放行动项（≤1 / 2-4 / ≥5）；越靠右上越热
  const tierOf = (n, mid, hi) => (n >= hi ? 2 : n >= mid ? 1 : 0);
  const heat = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => []));
  for (const r of resources) heat[tierOf(r.project_count, 2, 3)][tierOf(r.open_actions, 2, 5)].push(r);
  return {
    conflict_count: conflicts.length,
    conflicts,
    resources,
    heat,
    note: 'v2：资源名经全半角/大小写/空白归一后匹配（NFKC）；高权力=权力≥配置阈值（indicator-training-map.workbench，当前 ' + HIGH_POWER + '）；冲突=同一资源跨 ≥2 个项目',
  };
}

// ---------- 风险二阶推演（微训练入口，指标=风险与机会） ----------
export async function secondOrder(riskId) {
  const risk = db.prepare('SELECT * FROM risks WHERE id=?').get(riskId);
  if (!risk) throw notFound('risk not found');
  const out = await riskChat({ profile: getProfile(), risk: { title: risk.title, probability: risk.probability, impact: risk.impact } });
  db.prepare('UPDATE risks SET second_order=? WHERE id=?').run(JSON.stringify(out), riskId);
  return out;
}

// ---------- 风险→问题转化（PRINCE2：风险已发生=问题） ----------
export function riskToIssue(riskId) {
  db.prepare('UPDATE risks SET is_issue=1 WHERE id=?').run(riskId);
  return db.prepare('SELECT * FROM risks WHERE id=?').get(riskId);
}

// ---------- 行动项完成率（诚信与可靠 机读分） ----------
export function actionCompletionRate() {
  const r = db.prepare(`SELECT
    SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
    COUNT(*) total FROM action_items WHERE total IS NOT NULL`).get();
  if (!r.total) return null;
  return +(r.done / r.total).toFixed(3);
}
