// R2.2 ITTO 知识库 + 工具实操题：种子装载（幂等，可重复调用）+ 查询 + 出题/判分
// 静态数据唯一来源 itto-data.mjs（PMBOK 49 过程 / PRINCE2 管理产品 / GBT 打标）
import { randomUUID } from 'node:crypto';
import { db, getProfile } from './db.mjs';
import { PROCESSES, CATEGORY, PRINCE2_PRODUCTS, GBT_TAGS, TOOL_ALIASES } from './itto-data.mjs';
import { ittoQuestionChat, ittoGradeChat } from './agent.mjs';
import { notFound, conflict } from './errors.mjs';   // R6.4 错误风格
import { markTrained, kaToDomain } from './growth-links.mjs';

// ---------- 种子装载（幂等：过程按 code upsert、工具按 name ensure 并并标、链接去重后写入） ----------
export function seedItto() {
  const upProc = db.prepare(`INSERT INTO itto_processes (code, ka, name) VALUES (?,?,?)
                             ON CONFLICT(code) DO UPDATE SET ka=excluded.ka, name=excluded.name`);
  const procIdByCode = db.prepare('SELECT id FROM itto_processes WHERE code=?');
  const findTool = db.prepare('SELECT id, sources, category FROM itto_tools WHERE name=?');
  const insTool = db.prepare('INSERT INTO itto_tools (name, category, sources) VALUES (?,?,?)');
  const updSources = db.prepare('UPDATE itto_tools SET sources=? WHERE id=?');
  const insLink = db.prepare('INSERT INTO itto_links (process_id, tool_id, kind) VALUES (?,?,?)');
  const hasLink = db.prepare('SELECT 1 FROM itto_links WHERE process_id=? AND tool_id=? AND kind=?');
  const linksOf = db.prepare('SELECT process_id, kind FROM itto_links WHERE tool_id=?');

  // R3.4 校订①：一条目多源命中时合并来源标签（原 INSERT OR IGNORE 会吞掉 prince2 标签，如「商业论证」）
  const ensureTool = (name, category, sources) => {
    const row = findTool.get(name);
    if (row) {
      const merged = [...new Set([...(row.sources || '').split(','), ...String(sources).split(',')]
        .map((s) => s.trim()).filter(Boolean))].join(',');
      if (merged !== (row.sources || '')) updSources.run(merged, row.id);
      return row.id;
    }
    return Number(insTool.run(name, category, sources).lastInsertRowid);
  };
  const link = (pid, tid, kind) => { if (pid && tid && !hasLink.get(pid, tid, kind)) insLink.run(pid, tid, kind); };

  // R3.4 校订②：同义别名归一（PMBOK 英文同名 Document Analysis，中文口径统一为「文件分析」）
  // 迁移幂等：别名不存在即跳过；引用（链接/实操/教学）先改挂规范条目，再删除别名行
  for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
    const a = findTool.get(alias);
    if (!a) continue;
    const cid = ensureTool(canonical, a.category, a.sources);
    for (const l of linksOf.all(a.id)) link(l.process_id, cid, l.kind);   // 链接改挂规范条目（去重由 link 保证）
    db.prepare('DELETE FROM itto_links WHERE tool_id=?').run(a.id);
    db.prepare('UPDATE itto_tutor SET tool_id=? WHERE tool_id=?').run(cid, a.id);
    db.prepare('UPDATE itto_practice SET tool_id=? WHERE tool_id=?').run(cid, a.id);
    db.prepare('DELETE FROM itto_tools WHERE id=?').run(a.id);
  }
  // 链接去重兜底（同过程同条目同类型仅保留最早一条；修正别名归一可能留下的重复挂接）
  db.prepare('DELETE FROM itto_links WHERE id NOT IN (SELECT MIN(id) FROM itto_links GROUP BY process_id, tool_id, kind)').run();

  // R3.5 WP7 校订：静态数据为唯一真相，链接全量重建（幂等自愈）——伞形项展开/错挂移除后，
  // 旧「只增不删」逻辑会残留失效挂接（如 5.2 工具位的「需求跟踪矩阵」、6.4 的「迭代燃尽图」）。
  // itto_links 无外部引用（实践/教学表只引用 tool_id），全量重建安全；条目 id 不变，mastery 证据标签不受影响。
  db.prepare('DELETE FROM itto_links').run();

  for (const p of PROCESSES) {
    // 注意：upsert 走 UPDATE 分支时 lastInsertRowid 是陈旧值，必须回查
    upProc.run(p.code, p.ka, p.name);
    const pid = procIdByCode.get(p.code).id;
    const tag = (name) => (GBT_TAGS.some((t) => name.includes(t)) ? 'pmbok,gbt41831' : 'pmbok');
    for (const [kind, names] of [['input', p.in], ['tool', p.t], ['output', p.out]]) {
      for (const name of names) link(pid, ensureTool(name, CATEGORY[name] ?? '通用方法', tag(name)), kind);
    }
  }

  // PRINCE2 管理产品：category/sources 独立打标；link 到映射过程的 kind 沿用其字段
  for (const prod of PRINCE2_PRODUCTS) {
    const tid = ensureTool(prod.name, 'PRINCE2 管理产品', 'prince2');
    link(procIdByCode.get(prod.code)?.id, tid, prod.kind);
  }

  // R3.5 WP7 退役条目孤儿清理：重建后无任何挂接、且无实操/教学引用的工具行删除
  // （「数据分析/数据收集」两个伞形项退役；有引用的历史行保留，不破坏既有记录语义）
  db.prepare(`DELETE FROM itto_tools WHERE id NOT IN (SELECT DISTINCT tool_id FROM itto_links)
              AND id NOT IN (SELECT DISTINCT tool_id FROM itto_practice WHERE tool_id IS NOT NULL)
              AND id NOT IN (SELECT DISTINCT tool_id FROM itto_tutor WHERE tool_id IS NOT NULL)`).run();

  return {
    processes: db.prepare('SELECT COUNT(*) c FROM itto_processes').get().c,
    tools: db.prepare('SELECT COUNT(*) c FROM itto_tools').get().c,
    links: db.prepare('SELECT COUNT(*) c FROM itto_links').get().c,
  };
}

// ---------- 查询 ----------
export function overview() {
  const like = (s) => db.prepare('SELECT COUNT(*) c FROM itto_tools WHERE sources LIKE ?').get(`%${s}%`).c;
  return {
    process_count: db.prepare('SELECT COUNT(*) c FROM itto_processes').get().c,
    tool_count: db.prepare('SELECT COUNT(*) c FROM itto_tools').get().c,
    by_ka: db.prepare('SELECT ka, COUNT(*) count FROM itto_processes GROUP BY ka ORDER BY MIN(code)').all(),
    sources: { pmbok: like('pmbok'), prince2: like('prince2'), gbt41831: like('gbt41831') },
    // R3.4 工具口径审计：去重后的「工具与技术」清单数（PRD 估算口径约 120）
    techniques: {
      distinct: db.prepare(`SELECT COUNT(DISTINCT tool_id) c FROM itto_links WHERE kind='tool'`).get().c,
      prd_baseline: 120,
      by_category: db.prepare(`SELECT t.category, COUNT(DISTINCT t.id) count FROM itto_links l
                               JOIN itto_tools t ON t.id=l.tool_id WHERE l.kind='tool'
                               GROUP BY t.category ORDER BY count DESC, t.category`).all(),
    },
  };
}

export function listProcesses(ka) {
  return ka
    ? db.prepare('SELECT * FROM itto_processes WHERE ka=? ORDER BY code').all(String(ka))
    : db.prepare('SELECT * FROM itto_processes ORDER BY code').all();
}

export function processDetail(id) {
  const process = db.prepare('SELECT * FROM itto_processes WHERE id=?').get(Number(id));
  if (!process) throw notFound('process not found');
  const byKind = (kind) => db.prepare(`SELECT t.name, t.category, t.sources FROM itto_links l
                                      JOIN itto_tools t ON t.id=l.tool_id WHERE l.process_id=? AND l.kind=? ORDER BY t.id`)
    .all(process.id, kind);
  return { process, inputs: byKind('input'), tools: byKind('tool'), outputs: byKind('output') };
}

export function searchTools(q) {
  const like = `%${String(q ?? '').trim()}%`;
  const tools = db.prepare('SELECT * FROM itto_tools WHERE name LIKE ? OR category LIKE ? ORDER BY name LIMIT 30').all(like, like);
  const usedBy = db.prepare(`SELECT p.code, p.name, p.ka FROM itto_links l JOIN itto_processes p ON p.id=l.process_id
                             WHERE l.tool_id=? ORDER BY p.code LIMIT 8`);
  return tools.map((t) => ({ ...t, used_by: usedBy.all(t.id) }));
}

// ---------- 工具实操题（生成 + 判分；题目暂存内存 10 分钟，参考 assistant.mjs pending 模式） ----------
const pending = new Map();   // token → { question, context, reference, process_id, tool_id, process_name, depth, exp }
const TTL_MS = 10 * 60 * 1000;

// 深度随档案目标级派生（零硬编码：等级来自 user_profile）：<3 识别、3-4 应用、≥5 整合
function depthOf(target) {
  if (target < 3) return 'recognize';
  if (target < 5) return 'apply';
  return 'integrate';
}

export async function genPractice({ process_id, tool_id } = {}) {
  const profile = getProfile();
  const depth = depthOf(Number(profile.target_level) || 1);
  let process = null, tool = null;
  if (tool_id != null) {
    tool = db.prepare('SELECT * FROM itto_tools WHERE id=?').get(Number(tool_id));
    if (!tool) throw notFound('tool not found');
    // 取首个使用该工具的过程；纯 PRINCE2 输入等无挂靠时仅传工具名
    process = db.prepare(`SELECT p.* FROM itto_links l JOIN itto_processes p ON p.id=l.process_id
                          WHERE l.tool_id=? ORDER BY p.code LIMIT 1`).get(tool.id) ?? null;
  } else {
    process = db.prepare('SELECT * FROM itto_processes WHERE id=?').get(Number(process_id));
    if (!process) throw notFound('process not found');
  }
  const procTools = process
    ? db.prepare(`SELECT t.name FROM itto_links l JOIN itto_tools t ON t.id=l.tool_id
                  WHERE l.process_id=? AND l.kind='tool' ORDER BY t.id`).all(process.id).map((r) => r.name)
    : [];
  const procInfo = process
    ? { name: process.name, ka: process.ka, tools: procTools }
    : { name: tool.name, ka: '', tools: [tool.name] };

  const out = await ittoQuestionChat({ process: procInfo, depth, profile });
  if (!out.question) throw new Error('出题失败（LLM 返回为空），请重试');
  const token = randomUUID();
  const process_name = process?.name ?? tool.name;
  pending.set(token, {
    question: out.question, context: out.context, reference: out.reference,
    process_id: process?.id ?? null, tool_id: tool?.id ?? null, process_name, depth,
    exp: Date.now() + TTL_MS,
  });
  return { token, question: out.question, context: out.context, process_name, depth };
}

export async function submitPractice(token, answer) {
  const t = typeof token === 'string' ? pending.get(token) : null;
  if (!t) throw conflict('练习令牌无效或已使用，请重新生成');
  if (Date.now() > t.exp) {
    pending.delete(token);
    throw conflict('练习已超时（10 分钟有效），请重新生成');
  }
  const out = await ittoGradeChat({
    question: t.question, context: t.context, reference: t.reference, answer: String(answer ?? ''), profile: getProfile(),
  });
  db.prepare('INSERT INTO itto_practice (process_id, tool_id, question, context, answer, score, verdict, comment) VALUES (?,?,?,?,?,?,?,?)')
    .run(t.process_id, t.tool_id, t.question, t.context, String(answer ?? ''), out.score, out.verdict, out.comment);
  pending.delete(token);
  // R2.3 闭环链：实操合格（≥60）→ 命中该知识域 open 链接置 trained（R3.5：ka 中文域归一到国标域 key）
  if (t.process_id && Number(out.score) >= 60) {
    const proc = db.prepare('SELECT ka FROM itto_processes WHERE id=?').get(t.process_id);
    const dom = proc ? kaToDomain(proc.ka) : null;
    if (dom) markTrained({ domain: dom });
  }
  return { score: out.score, verdict: out.verdict, comment: out.comment, reference: t.reference };
}

export function practiceHistory(limit = 10) {
  return db.prepare(`SELECT pr.id, pr.process_id, pr.tool_id, pr.question, pr.answer, pr.score, pr.verdict, pr.comment,
                     pr.created_at, p.name process_name
                     FROM itto_practice pr LEFT JOIN itto_processes p ON p.id=pr.process_id
                     ORDER BY pr.id DESC LIMIT ?`).all(Math.max(1, Math.min(50, Number(limit) || 10)));
}
