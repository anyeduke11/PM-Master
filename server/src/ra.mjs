// W4 风险评估专项：三场景模板 + 矩阵法计算（纯代码）+ AI 抽取/报告
import { db } from './db.mjs';
import { raExtractChat, raReportChat } from './agent.mjs';
import { badRequest, notFound } from './errors.mjs';   // R6.4 错误风格

// ---------- 三场景模板 ----------
export const SCENARIOS = {
  gb20984: {
    name: '信息安全风险评估',
    standard: 'GB/T 20984',
    phases: ['prep', 'assets', 'analysis', 'treatment', 'report', 'review'],
    asset_label: '资产（CIA 三性赋值 1-5）',
    finding_extra: {},
  },
  fin_data: {
    name: '金融数据安全风险评估',
    standard: 'JR/T 0223 / JR/T 0197 体系',
    phases: ['prep', 'assets', 'analysis', 'treatment', 'report', 'review'],
    asset_label: '数据资产（分级 1-5 + CIA）',
    finding_extra: { lifecycle: '采集|传输|存储|使用|共享|删除' },
  },
  pia: {
    name: '个人信息保护评估',
    standard: 'PIPL §55-56 / GB/T 35273',
    phases: ['prep', 'assets', 'analysis', 'treatment', 'report', 'review'],
    asset_label: '处理活动（涉及个人信息类型/数量）',
    finding_extra: { lawful: '合法性判断', necessary: '必要性判断', consent: '告知同意情况' },
  },
};

// ---------- 矩阵法计算（规则交给代码；简化矩阵，系数可配置化） ----------
const clamp5 = (v) => Math.max(1, Math.min(5, Math.round(Number(v) || 3)));

export function assetValue(asset, scenario) {
  const cia = Math.max(
    clamp5(asset.confidentiality),
    clamp5(asset.integrity),
    clamp5(asset.availability),
  );
  if (scenario === 'fin_data' && asset.data_level) return Math.max(cia, clamp5(asset.data_level));
  return cia;
}

export function calcRisk({ asset, scenario, threat_freq, vuln_sev }) {
  const f = clamp5(threat_freq), s = clamp5(vuln_sev);
  const av = assetValue(asset, scenario);
  const possibility = Math.ceil((f + s) / 2);       // 可能性 = f(威胁频率, 脆弱性)
  const impact = Math.ceil((av + s) / 2);           // 影响 = f(资产价值, 脆弱性)
  const risk_value = possibility * impact;          // 1-25
  const risk_level = risk_value <= 4 ? '低' : risk_value <= 9 ? '中' : risk_value <= 16 ? '高' : '严重';
  return { possibility, impact, risk_value, risk_level };
}

// ---------- 项目/资产/风险项 CRUD（含计算落库） ----------
export function listRaProjects() {
  const rows = db.prepare('SELECT * FROM ra_projects ORDER BY id DESC').all();
  return rows.map((p) => {
    const assets = db.prepare('SELECT COUNT(*) c FROM ra_assets WHERE project_id=?').get(p.id).c;
    const findings = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN risk_level IN ('高','严重') THEN 1 ELSE 0 END) high FROM ra_findings WHERE project_id=?`).get(p.id);
    return { ...p, asset_count: assets, finding_count: findings.c, high_count: findings.high ?? 0,
             scenario_name: SCENARIOS[p.scenario]?.name ?? p.scenario };
  });
}

export function createRaProject(b) {
  const sc = SCENARIOS[b.scenario];
  if (!sc) throw badRequest(`未知场景: ${b.scenario}（可选 gb20984|fin_data|pia）`);
  const info = db.prepare('INSERT INTO ra_projects (name, scenario, org, scope, period) VALUES (?,?,?,?,?)')
    .run(String(b.name ?? '未命名评估'), b.scenario, b.org ?? null, b.scope ?? null, b.period ?? null);
  return db.prepare('SELECT * FROM ra_projects WHERE id=?').get(info.lastInsertRowid);
}

export function raDetail(id) {
  const project = db.prepare('SELECT * FROM ra_projects WHERE id=?').get(id);
  if (!project) throw notFound('评估项目不存在');
  const assets = db.prepare('SELECT * FROM ra_assets WHERE project_id=? ORDER BY id').all(id);
  const findings = db.prepare(`SELECT f.*, a.name asset_name FROM ra_findings f
                               LEFT JOIN ra_assets a ON a.id=f.asset_id
                               WHERE f.project_id=? ORDER BY f.risk_value DESC NULLS LAST, f.id DESC`).all(id);
  // 风险分布
  const dist = { 低: 0, 中: 0, 高: 0, 严重: 0 };
  for (const f of findings) if (f.risk_level) dist[f.risk_level] += 1;
  return { project, assets, findings, dist, scenario: SCENARIOS[project.scenario] };
}

export function addAsset(projectId, b) {
  const info = db.prepare(`INSERT INTO ra_assets (project_id, name, type, confidentiality, integrity, availability, data_level, owner, notes)
                           VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(projectId, String(b.name ?? ''), b.type ?? null, clamp5(b.confidentiality), clamp5(b.integrity),
      clamp5(b.availability), b.data_level ? clamp5(b.data_level) : null, b.owner ?? null, b.notes ?? null);
  return db.prepare('SELECT * FROM ra_assets WHERE id=?').get(info.lastInsertRowid);
}

export function addFinding(projectId, b) {
  const project = db.prepare('SELECT * FROM ra_projects WHERE id=?').get(projectId);
  const asset = b.asset_id ? db.prepare('SELECT * FROM ra_assets WHERE id=?').get(b.asset_id) : null;
  const calc = calcRisk({
    asset: asset ?? { confidentiality: 3, integrity: 3, availability: 3, data_level: null },
    scenario: project.scenario,
    threat_freq: b.threat_freq, vuln_sev: b.vuln_sev,
  });
  const info = db.prepare(`INSERT INTO ra_findings
    (project_id, asset_id, threat_desc, threat_freq, vuln_desc, vuln_sev, measures_existing,
     possibility, impact, risk_value, risk_level, treatment, owner, due_date, extra)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(projectId, b.asset_id ?? null, String(b.threat_desc ?? ''), clamp5(b.threat_freq),
      b.vuln_desc ?? null, clamp5(b.vuln_sev), b.measures_existing ?? null,
      calc.possibility, calc.impact, calc.risk_value, calc.risk_level,
      b.treatment ?? null, b.owner ?? null, b.due_date ?? null,
      b.extra ? JSON.stringify(b.extra) : null);
  return db.prepare('SELECT * FROM ra_findings WHERE id=?').get(info.lastInsertRowid);
}

export function updateFinding(id, b) {
  const f = db.prepare('SELECT * FROM ra_findings WHERE id=?').get(id);
  if (!f) throw notFound('风险项不存在');
  const next = { ...f, ...b, extra: b.extra ? JSON.stringify(b.extra) : f.extra };
  // 输入变化则重算
  const project = db.prepare('SELECT scenario FROM ra_projects WHERE id=?').get(f.project_id);
  const asset = f.asset_id ? db.prepare('SELECT * FROM ra_assets WHERE id=?').get(f.asset_id) : null;
  const calc = calcRisk({
    asset: asset ?? { confidentiality: 3, integrity: 3, availability: 3 },
    scenario: project.scenario, threat_freq: next.threat_freq, vuln_sev: next.vuln_sev,
  });
  db.prepare(`UPDATE ra_findings SET threat_desc=?, threat_freq=?, vuln_desc=?, vuln_sev=?, measures_existing=?,
              treatment=?, owner=?, due_date=?, status=?, extra=?, possibility=?, impact=?, risk_value=?, risk_level=? WHERE id=?`)
    .run(next.threat_desc, clamp5(next.threat_freq), next.vuln_desc, clamp5(next.vuln_sev), next.measures_existing,
      next.treatment, next.owner, next.due_date, next.status ?? f.status, next.extra,
      calc.possibility, calc.impact, calc.risk_value, calc.risk_level, id);
  return db.prepare('SELECT * FROM ra_findings WHERE id=?').get(id);
}

export function setRaPhase(id, phase) {
  db.prepare('UPDATE ra_projects SET phase=? WHERE id=?').run(phase, id);
  return db.prepare('SELECT * FROM ra_projects WHERE id=?').get(id);
}

// ---------- AI：识别抽取（粘贴文档→资产/风险候选） ----------
export async function raExtract(projectId, text) {
  const project = db.prepare('SELECT * FROM ra_projects WHERE id=?').get(projectId);
  const sc = SCENARIOS[project.scenario];
  const out = await raExtractChat({
    scenario: project.scenario, standard: sc.standard, asset_label: sc.asset_label,
    extra_fields: sc.finding_extra, text,
  });
  return out ?? {};
}

// ---------- AI：评估报告生成 ----------
export async function raReport(projectId) {
  const d = raDetail(projectId);
  const out = await raReportChat({ detail: {
    project: { name: d.project.name, scenario: d.scenario.name, standard: d.scenario.standard, org: d.project.org, scope: d.project.scope, period: d.project.period },
    assets: d.assets.map((a) => ({ name: a.name, type: a.type, cia: [a.confidentiality, a.integrity, a.availability], data_level: a.data_level })),
    findings: d.findings.map((f) => ({ asset: f.asset_name, threat: f.threat_desc, vuln: f.vuln_desc, p: f.possibility, i: f.impact, risk: f.risk_value, level: f.risk_level, treatment: f.treatment })),
    dist: d.dist,
  }});
  return out ?? {};
}
