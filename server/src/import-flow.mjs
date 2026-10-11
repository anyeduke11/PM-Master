// R7.0 P2 数据流入：粘贴/文本文件 → LLM 抽取（preview 瞬态）→ 人工确认 → commit 入库
// 规则/判断分离：类型由用户先选（确定性路由），LLM 只抽字段（import-flow 的 kind 即白名单）；
// 校验/去重/入库全部纯代码，服务端以 commit 侧重校验为权威（preview 结果可被前端编辑）。
import { db } from './db.mjs';
import { importExtractChat } from './agent.mjs';
import { badRequest } from './errors.mjs';

// 项目名归一（与 workbench.normName 同式：NFKC 全半角 + 大小写 + 空白折叠）
const norm = (raw) => String(raw ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- kind 白名单 schema（字段校验器返回归一值或抛错文案） ----------
const num = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) return null; return n; };
const str = (v, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

const KINDS = {
  evm: {
    label: 'EVM 度量（PV/EV/AC）',
    validate(row) {
      const pv = num(row.pv, 0.001, 1e9), ev = num(row.ev, 0.001, 1e9), ac = num(row.ac, 0.001, 1e9);
      if (pv == null || ev == null || ac == null) return { error: 'PV/EV/AC 须为正数' };
      return { ok: { pv, ev, ac } };
    },
  },
  risks: {
    label: '风险登记册',
    validate(row) {
      const title = str(row.title, 200);
      if (!title) return { error: '风险标题为空' };
      const probability = row.probability == null ? 0.5 : num(row.probability, 0, 1);
      const impact = row.impact == null ? 0.7 : num(row.impact, 0, 1);
      if (probability == null || impact == null) return { error: '概率/影响须在 0-1' };
      return { ok: { title, probability, impact, strategy: str(row.strategy, 200) } };
    },
  },
  meetings: {
    label: '会议与行动项',
    validate(row) {
      const title = str(row.title, 200);
      if (!title) return { error: '会议主题为空' };
      const held_at = str(row.held_at, 40);   // 宽松：LLM 给的日期串直接用（可空）
      const actions = (Array.isArray(row.actions) ? row.actions : []).slice(0, 20)
        .map((a) => ({ title: str(a?.title, 200), owner: str(a?.owner, 60) ?? '我', due_date: str(a?.due_date, 40) }))
        .filter((a) => a.title);
      return { ok: { title, held_at, actions } };
    },
  },
  stakeholders: {
    label: '干系人登记',
    validate(row) {
      const name = str(row.name, 100);
      if (!name) return { error: '姓名为空' };
      const power = row.power == null ? 5 : num(row.power, 0, 10);
      const interest = row.interest == null ? 5 : num(row.interest, 0, 10);
      if (power == null || interest == null) return { error: '权力/利益须在 0-10' };
      return { ok: { name, power, interest, current_engagement: str(row.current_engagement, 40), desired_engagement: str(row.desired_engagement, 40) } };
    },
  },
};
export const importKinds = () => Object.entries(KINDS).map(([key, v]) => ({ key, label: v.label }));

// 项目名 → id（norm 匹配；未命中返回 null，由调用方标记）
function matchProject(name) {
  const key = norm(name);
  if (!key) return null;
  return db.prepare('SELECT id, name FROM projects').all().find((p) => norm(p.name) === key) ?? null;
}

// 行级富化：挂 project_id + 去重标记（preview 展示用；commit 重算为权威）
function enrich(kind, rows) {
  return rows.map((row) => {
    const v = KINDS[kind].validate(row ?? {});
    const out = { ...row, ...(v.ok ?? {}) };
    if (v.error) { out._err = v.error; return out; }
    const proj = matchProject(row?.project_name);
    if (!proj) { out._err = `项目「${str(row?.project_name, 40) ?? '?'}」不存在`; return out; }
    out.project_id = proj.id;
    out.project_name = proj.name;   // 显示名归一（防全半角差异）
    // 去重检测（evm 为时序数据不去重）
    if (kind === 'risks' && db.prepare(`SELECT title FROM risks WHERE project_id=? AND status='open'`).all(proj.id).some((r) => norm(r.title) === norm(out.title))) out._dup = true;
    if (kind === 'stakeholders' && db.prepare('SELECT name FROM stakeholders WHERE project_id=?').all(proj.id).some((r) => norm(r.name) === norm(out.name))) out._dup = true;
    if (kind === 'meetings' && db.prepare('SELECT title FROM meetings WHERE project_id=?').all(proj.id).some((r) => norm(r.title) === norm(out.title))) out._dup = true;
    return out;
  });
}

// ---------- preview：文本 → LLM 抽取 → 富化（瞬态不落库） ----------
export async function importPreview({ kind, text, source = 'paste' }) {
  if (!KINDS[kind]) throw badRequest(`未知导入类型：${kind}（可选 ${Object.keys(KINDS).join('/')}）`);
  const t = String(text ?? '');
  if (t.trim().length < 10) throw badRequest('资料太短（至少 10 字），无法抽取');
  if (t.length > 50_000) throw badRequest('资料超长（上限 5 万字符），请分批导入');
  if (source !== 'file') source = 'paste';
  const { rows, warnings } = await importExtractChat({ kind, text: t });
  const enriched = enrich(kind, rows);
  return {
    kind,
    rows: enriched,
    warnings,
    stats: { total: enriched.length, valid: enriched.filter((r) => !r._err && !r._dup).length, err: enriched.filter((r) => r._err).length, dup: enriched.filter((r) => r._dup && !r._err).length },
  };
}

// ---------- commit：服务端重校验 → 逐行入库（失败行不阻塞）→ 落 import_logs ----------
export function importCommit({ kind, rows, source = 'paste' }) {
  if (!KINDS[kind]) throw badRequest(`未知导入类型：${kind}`);
  if (!Array.isArray(rows) || !rows.length) throw badRequest('无可入库行');
  if (rows.length > 100) throw badRequest('单次入库上限 100 行');
  const results = [];
  let inserted = 0;
  for (const [i, row] of rows.entries()) {
    try {
      const [enr] = enrich(kind, [row]);   // 重算：project 匹配 + 校验 + 去重（以此刻库为准）
      if (enr._err) throw new Error(enr._err);
      if (enr._dup) throw new Error('重复（库内已存在同名）');
      const id = writeRow(kind, enr);
      inserted += 1;
      results.push({ i, ok: true, id, project_id: enr.project_id });
    } catch (e) {
      results.push({ i, ok: false, reason: String(e.message ?? e) });
    }
  }
  const skipped = results.length - inserted;
  const status = inserted === 0 ? 'failed' : (skipped ? 'partial' : 'ok');
  if (inserted > 0) {
    db.prepare('INSERT INTO import_logs (kind, source, items, skipped, status) VALUES (?,?,?,?,?)')
      .run(kind, source, inserted, skipped, status);
  }
  if (!inserted) throw badRequest(`全部 ${results.length} 行均未通过校验：${results[0]?.reason ?? ''}`);
  return { inserted, skipped, status, results };
}

// 单行入库（enrich 已保证字段合法 + project_id 存在）
function writeRow(kind, r) {
  if (kind === 'evm') {
    const info = db.prepare(`INSERT INTO project_artifacts (project_id, type, title, content, evm, status) VALUES (?,?,?,?,?,?)`)
      .run(r.project_id, 'evm_import', `导入 EVM · ${new Date().toISOString().slice(0, 10)}`,
        `由数据流入导入（未生成周报）。PV ${r.pv} / EV ${r.ev} / AC ${r.ac}。`, JSON.stringify({ pv: r.pv, ev: r.ev, ac: r.ac }), 'imported');
    return Number(info.lastInsertRowid);
  }
  if (kind === 'risks') {
    const info = db.prepare('INSERT INTO risks (project_id, title, probability, impact, strategy) VALUES (?,?,?,?,?)')
      .run(r.project_id, r.title, r.probability, r.impact, r.strategy ?? null);
    return Number(info.lastInsertRowid);
  }
  if (kind === 'meetings') {
    const info = db.prepare('INSERT INTO meetings (project_id, title, held_at) VALUES (?,?,?)')
      .run(r.project_id, r.title, r.held_at ?? null);
    const mid = Number(info.lastInsertRowid);
    for (const a of r.actions ?? []) {
      db.prepare('INSERT INTO action_items (project_id, meeting_id, title, owner, due_date) VALUES (?,?,?,?,?)')
        .run(r.project_id, mid, a.title, a.owner ?? '我', a.due_date ?? null);
    }
    return mid;
  }
  const info = db.prepare('INSERT INTO stakeholders (project_id, name, power, interest, current_engagement, desired_engagement) VALUES (?,?,?,?,?,?)')
    .run(r.project_id, r.name, r.power, r.interest, r.current_engagement ?? null, r.desired_engagement ?? null);
  return Number(info.lastInsertRowid);
}

// ---------- 导入历史（设置中心 K 区） ----------
export function importLogs(limit = 20) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  return db.prepare('SELECT * FROM import_logs ORDER BY id DESC LIMIT ?').all(n);
}
