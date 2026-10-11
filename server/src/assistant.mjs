// R2.1 全局 AI 助手意图引擎：NL →（LLM 判定意图）→ 白名单校验 → 计划/确认 → 确定性执行
// 规则/执行分离（AGENTS.md 约束2）：LLM 只做意图识别与自由问答；写库与计算全部是本文件的纯代码
import { randomUUID } from 'node:crypto';
import { db, getProfile } from './db.mjs';
import { assistantChat } from './agent.mjs';
import { generateWeekly, secondOrder, actionCompletionRate } from './workbench.mjs';
import { computeScores } from './growth.mjs';
import { dueQueue } from './drill.mjs';
import { feishuConfigured, exportDoc } from './feishu.mjs';
import { loadStandard } from './standard.mjs';
import { badRequest, notFound, conflict } from './errors.mjs';   // R6.4/R6.6b 错误风格

// ---------- 意图注册表（服务端白名单：LLM 判定结果必须在此注册才受理；desc 供 LLM 提示词） ----------
export const INTENTS = {
  'risk.create': {
    type: 'write', usesProject: true,
    desc: '登记/新建项目风险｜参数：title(必填,风险标题)、project(项目名)、probability(概率0-1)、impact(影响0-1)、strategy(应对策略)',
    required: ['title'], asks: { title: '风险标题是什么？' },
  },
  'risk.escalate': {
    type: 'write', usesProject: true,
    desc: '把某条风险升级上报 sponsor｜参数：risk(必填,风险标题或编号)、project(项目名)',
    required: ['risk'], asks: { risk: '要升级哪条风险？（风险标题或编号）' },
  },
  'risk.second_order': {
    type: 'write', usesProject: true,
    desc: '对某条风险做二阶效应推演｜参数：risk(必填,风险标题或编号)、project(项目名)',
    required: ['risk'], asks: { risk: '要推演哪条风险？（风险标题或编号）' },
  },
  'risk.delete': {
    type: 'write', usesProject: true, danger: true,
    desc: '删除风险登记（不可恢复，需输入风险标题二次确认）｜参数：risk(必填,风险标题或编号)、project(项目名)',
    required: ['risk'], asks: { risk: '要删除哪条风险？（风险标题或编号）' },
  },
  'weekly.generate': {
    type: 'write', usesProject: true, numeric: ['pv', 'ev', 'ac'],
    desc: '生成项目周报（需本周 EVM 三值）｜参数：pv(必填,本周计划值数字)、ev(必填,本周挣值数字)、ac(必填,本周实际成本数字)、project(项目名)',
    required: ['pv', 'ev', 'ac'],
    asks: { pv: '本周 PV（计划值）是多少？', ev: '本周 EV（挣值）是多少？', ac: '本周 AC（实际成本）是多少？' },
  },
  'weekly.export': {
    type: 'write', usesProject: true,
    desc: '导出最新周报（写回飞书云文档；未配置飞书则返回 Markdown 供下载）｜参数：project(项目名)',
    required: [],
  },
  'coach.start': {
    type: 'action',
    desc: '进入 GROW 教练场景演练（如向上汇报/资源谈判/团队冲突/风险决策/例外应对等）｜参数：scenario(场景名或id，缺省 report)',
    required: [],
  },
  'task.add': {
    type: 'write', usesProject: true,
    desc: '新增行动项/待办｜参数：title(必填,任务内容)、owner(负责人)、due_date(截止日期YYYY-MM-DD)、project(项目名)',
    required: ['title'], asks: { title: '任务内容是什么？' },
  },
  'task.done': {
    type: 'write', usesProject: true,
    desc: '完成/勾掉一条行动项｜参数：task(必填,任务标题或编号)、project(项目名)',
    required: ['task'], asks: { task: '要完成哪个任务？（任务标题或编号）' },
  },
  'stats.query': {
    type: 'read', usesProject: true, projectOptional: true,
    desc: '查询统计：成长差距/三维分数、项目风险数、容差预警、行动项完成率等｜参数：topic(查询主题)、project(项目名)',
    required: [],
  },
  'card.search': {
    type: 'read',
    desc: '搜索强化营知识卡片｜参数：q(必填,关键词)',
    required: ['q'], asks: { q: '想查哪个知识点？给个关键词。' },
  },
};

// ---------- 待确认计划（内存态，5 分钟有效） ----------
const pending = new Map();   // confirm_token → { intent, params, target_name?, exp }
const TTL_MS = 5 * 60 * 1000;

// ---------- 实体查找（支持名称或编号；node:sqlite SQL 字符串字面量必须单引号） ----------
function findProject(ref) {
  if (ref == null || String(ref).trim() === '') return null;
  if (/^\d+$/.test(String(ref))) {
    const byId = db.prepare('SELECT * FROM projects WHERE id=?').get(Number(ref));
    if (byId) return byId;
  }
  return db.prepare('SELECT * FROM projects WHERE name LIKE ? ORDER BY id DESC LIMIT 1').get(`%${String(ref).trim()}%`);
}
function findRisk(projectId, ref) {
  if (/^\d+$/.test(String(ref))) {
    const byId = db.prepare('SELECT * FROM risks WHERE id=?').get(Number(ref));
    if (byId && byId.project_id === projectId) return byId;
  }
  return db.prepare('SELECT * FROM risks WHERE project_id=? AND title LIKE ? ORDER BY id DESC LIMIT 1')
    .get(projectId, `%${String(ref).trim()}%`);
}
function findTask(projectId, ref) {
  if (/^\d+$/.test(String(ref))) {
    const byId = db.prepare('SELECT * FROM action_items WHERE id=?').get(Number(ref));
    if (byId && byId.project_id === projectId) return byId;
  }
  return db.prepare('SELECT * FROM action_items WHERE project_id=? AND title LIKE ? ORDER BY id DESC LIMIT 1')
    .get(projectId, `%${String(ref).trim()}%`);
}

// coach 场景归一：命中 indicator-training-map 的 coach_scenarios id/名称，否则默认 report
function resolveScenario(ref) {
  const scen = loadStandard('indicator-training-map').coach_scenarios;
  const s = String(ref ?? '').trim();
  if (!s) return 'report';
  if (Object.hasOwn(scen, s)) return s;
  const hit = Object.entries(scen).find(([, v]) => v.name === s || v.name.includes(s) || s.includes(v.name));
  return hit ? hit[0] : 'report';
}

// ---------- parse：NL → 五种 kind 之一（result / plan / action / clarify / chat） ----------
export async function parse(text, pageContext = {}) {
  // R6.3 全站测试 J7：空输入本地短路，不打 LLM（省配额，友好提示代替错误透传）
  if (!String(text ?? '').trim()) {
    return { kind: 'chat', reply: '请输入想说的话，例如：「登记风险：核心工程师离职」「生成本周周报 PV120 EV100 AC110」「我的成长差距有哪些」。' };
  }
  try {
    const profile = getProfile();
    // 当前页项目优先，否则最新项目（注入 LLM 上下文 + 参数补全兜底）
    const ctxProject = pageContext.project_id
      ? db.prepare('SELECT * FROM projects WHERE id=?').get(Number(pageContext.project_id)) : null;
    const latest = ctxProject ?? db.prepare('SELECT * FROM projects ORDER BY id DESC LIMIT 1').get() ?? null;

    const out = (await assistantChat({
      text, profile,
      pageContext: { tab: pageContext.tab ?? null, project_id: pageContext.project_id ?? null, project_name: latest?.name ?? null },
    })) ?? {};
    const params = out.params && typeof out.params === 'object' && !Array.isArray(out.params) ? { ...out.params } : {};

    // 白名单校验：未注册意图一律按自由问答处理
    if (!(typeof out.intent === 'string' && Object.hasOwn(INTENTS, out.intent))) {
      const reply = String(out.reply ?? '').trim();
      return { kind: 'chat', reply: reply || '这个我还没学会。可以试试：「登记风险：核心工程师离职」「生成本周周报 PV120 EV100 AC110」「我的成长差距有哪些」。' };
    }
    const intent = out.intent;
    const def = INTENTS[intent];

    // 项目补全：显式名 > 当前页项目 > 最新项目
    let project = null;
    if (def.usesProject) {
      if (params.project != null && String(params.project).trim() !== '') {
        project = findProject(params.project);
        if (!project) return { kind: 'clarify', intent, reply: `没有找到名为「${params.project}」的项目，请确认项目名称。` };
      } else {
        project = latest;
      }
      if (!project && !def.projectOptional) {
        return { kind: 'clarify', intent, reply: '当前还没有项目，请先在项目工作台创建项目后再试。' };
      }
    }

    // 数值参数规整（weekly EVM 三值）
    if (def.numeric) for (const k of def.numeric) params[k] = Number(params[k]);

    // 必填参数校验 → 追问
    const missing = def.required.filter((k) => (def.numeric?.includes(k)
      ? !(Number.isFinite(params[k]) && params[k] > 0)
      : params[k] == null || String(params[k]).trim() === ''));
    if (missing.length) {
      return { kind: 'clarify', intent, reply: `${missing.map((k) => def.asks?.[k] ?? `请补充 ${k}`).join('；')}。` };
    }

    // 读类立即执行；coach 立即返回入口；写类生成计划待确认
    if (intent === 'stats.query') return execStatsQuery(params, project);
    if (intent === 'card.search') return execCardSearch(params);
    if (intent === 'coach.start') {
      const scenario = resolveScenario(params.scenario);
      const name = loadStandard('indicator-training-map').coach_scenarios[scenario].name;
      return { kind: 'action', intent, params: { scenario }, reply: `好，进入「${name}」教练场景，点击入口即可开始演练。` };
    }

    // 写类：解析目标实体（风险/任务支持名称或编号；匹配不到按追问处理）
    let risk = null, task = null;
    if (intent.startsWith('risk.') && intent !== 'risk.create') {
      risk = findRisk(project.id, params.risk);
      if (!risk) return { kind: 'clarify', intent, reply: `在项目「${project.name}」中没有找到风险「${params.risk}」，请确认标题或编号。` };
      params.risk = risk.title;
    }
    if (intent === 'task.done') {
      task = findTask(project.id, params.task);
      if (!task) return { kind: 'clarify', intent, reply: `在项目「${project.name}」中没有找到行动项「${params.task}」，请确认标题或编号。` };
      params.task = task.title;
    }
    if (project) params.project = project.name;

    const plan = buildPlan(intent, params, project, risk, task);
    const confirm_token = randomUUID();
    pending.set(confirm_token, {
      intent,
      params: { ...params, project_id: project?.id ?? null, risk_id: risk?.id ?? null, task_id: task?.id ?? null },
      target_name: def.danger ? risk?.title : undefined,
      exp: Date.now() + TTL_MS,
    });
    return { kind: 'plan', intent, params, plan, confirm_token, expires_in: 300 };
  } catch (e) {
    return { kind: 'chat', reply: `助手暂时不可用：${String(e?.message ?? e).slice(0, 160)}` };
  }
}

// 计划预览（人类可读步骤；danger 意图附 target_name 供双确认）
function buildPlan(intent, params, project, risk, task) {
  const pn = project ? `项目「${project.name}」` : '当前项目';
  switch (intent) {
    case 'risk.create':
      return { title: `在${pn}创建风险`, steps: [
        `新建风险「${params.title}」（概率 ${params.probability ?? 0.5} / 影响 ${params.impact ?? 0.7}${params.strategy ? `，应对策略：${params.strategy}` : ''}）`,
        '登记后可在风险登记册查看，并可发起二阶效应推演',
      ] };
    case 'risk.escalate':
      return { title: '升级风险至 sponsor', steps: [
        `将${pn}的风险 #${risk.id}「${risk.title}」标记为已升级 sponsor`,
        '同步生成一条 escalation 预警记录',
      ] };
    case 'risk.second_order':
      return { title: '风险二阶效应推演', steps: [
        `对${pn}的风险 #${risk.id}「${risk.title}」做一/二/三阶效应推演`,
        '推演结果回写风险条目',
      ] };
    case 'risk.delete':
      return { title: '删除风险（不可恢复）', steps: [
        `删除${pn}的风险 #${risk.id}「${risk.title}」`,
        `该操作不可恢复：确认时需输入风险标题「${risk.title}」二次确认`,
      ], danger: true, target_name: risk.title };
    case 'weekly.generate':
      return { title: `生成${pn}周报`, steps: [
        `录入本周 EVM：PV ${params.pv} / EV ${params.ev} / AC ${params.ac}`,
        '计算 SPI/CPI 并执行容差检查（超差将生成预警）',
        '生成周报 Markdown 并存档到项目工件',
      ] };
    case 'weekly.export':
      return { title: `导出${pn}最新周报`, steps: [
        `取${pn}最新一份周报`,
        feishuConfigured() ? '写回飞书云文档并返回链接' : '飞书未配置：返回 Markdown 供本地下载',
      ] };
    case 'task.add':
      return { title: `在${pn}添加行动项`, steps: [
        `新增行动项「${params.title}」${params.owner ? `（负责人：${params.owner}）` : ''}${params.due_date ? `，截止 ${params.due_date}` : ''}`,
      ] };
    case 'task.done':
      return { title: '完成行动项', steps: [
        `将${pn}的行动项 #${task.id}「${task.title}」标记为完成（记录完成时间）`,
      ] };
    default:
      return { title: intent, steps: [intent] };
  }
}

// ---------- exec：确认令牌校验 + 确定性执行（不经过 LLM） ----------
const HANDLERS = {
  'risk.create': (p) => {
    const info = db.prepare('INSERT INTO risks (project_id, title, probability, impact, strategy) VALUES (?,?,?,?,?)')
      .run(p.project_id, String(p.title), num01(p.probability, 0.5), num01(p.impact, 0.7), p.strategy ?? null);
    const risk = db.prepare('SELECT * FROM risks WHERE id=?').get(info.lastInsertRowid);
    return { result: `已在项目「${p.project}」创建风险 #${risk.id}「${risk.title}」（概率 ${risk.probability} / 影响 ${risk.impact}）。`, payload: { risk } };
  },
  'risk.escalate': (p) => {
    db.prepare(`UPDATE risks SET strategy=COALESCE(strategy,'') || ' [已升级sponsor]' WHERE id=?`).run(p.risk_id);
    const risk = db.prepare('SELECT * FROM risks WHERE id=?').get(p.risk_id);
    db.prepare('INSERT INTO alerts (project_id, dimension, message) VALUES (?,?,?)')
      .run(risk.project_id, 'escalation', `风险 #${risk.id}「${risk.title}」已升级至 sponsor 处理`);
    return { result: `风险 #${risk.id}「${risk.title}」已升级至 sponsor，并生成 escalation 预警。`, payload: { risk_id: risk.id } };
  },
  'risk.second_order': async (p) => {
    const out = await secondOrder(p.risk_id);
    const chain = ['first', 'second', 'third'].map((k) => out?.[k]).filter(Boolean).join(' → ');
    return { result: `风险「${p.risk}」二阶推演：${chain || out?.reply || '（无输出，可重试）'}${out?.question ? `\n思考提问：${out.question}` : ''}`, payload: { risk_id: p.risk_id, second_order: out } };
  },
  'risk.delete': (p) => {
    db.prepare('DELETE FROM risks WHERE id=?').run(p.risk_id);
    return { result: `已删除风险 #${p.risk_id}「${p.risk}」。` };
  },
  'weekly.generate': async (p) => {
    const r = await generateWeekly(p.project_id, { pv: p.pv, ev: p.ev, ac: p.ac });
    const evm = r.evm ? `SPI ${r.evm.spi} / CPI ${r.evm.cpi}（SV ${r.evm.sv}、CV ${r.evm.cv}）` : 'EVM 三值无效';
    const alerts = r.alerts?.length ? `；⚠️ 容差预警 ${r.alerts.length} 条：${r.alerts.map((a) => a.message).join('；')}` : '；容差检查通过';
    return { result: `周报已生成并存档 #${r.id}（${evm}${alerts}）。`, payload: { artifact_id: r.id, evm: r.evm, markdown: r.markdown, alerts: r.alerts } };
  },
  'weekly.export': async (p) => {
    const art = db.prepare(`SELECT * FROM project_artifacts WHERE project_id=? AND type='weekly' ORDER BY id DESC LIMIT 1`).get(p.project_id);
    if (!art) throw new Error(`项目「${p.project}」还没有周报，请先生成（如：生成本周周报 PV120 EV100 AC110）。`);
    if (feishuConfigured()) {
      const r = await exportDoc({ title: art.title, markdown: art.content });
      return { result: `《${art.title}》已写回飞书云文档：${r.url}`, payload: { url: r.url, title: art.title } };
    }
    return { result: `飞书未配置：《${art.title}》已转为 Markdown 下载（在 server/.env 配置 FEISHU_APP_ID/SECRET 后可直接写回云文档）。`, payload: { title: art.title, markdown: art.content } };
  },
  'task.add': (p) => {
    const info = db.prepare('INSERT INTO action_items (project_id, meeting_id, title, owner, due_date) VALUES (?,?,?,?,?)')
      .run(p.project_id, null, String(p.title), p.owner ?? '', p.due_date ?? null);
    return { result: `已添加行动项 #${info.lastInsertRowid}「${p.title}」${p.owner ? `（负责人 ${p.owner}）` : ''}${p.due_date ? `，截止 ${p.due_date}` : ''}。`, payload: { id: info.lastInsertRowid } };
  },
  'task.done': (p) => {
    db.prepare(`UPDATE action_items SET status='done', completed_at=datetime('now','localtime') WHERE id=?`).run(p.task_id);
    const rate = actionCompletionRate();
    return { result: `行动项 #${p.task_id}「${p.task}」已完成${rate != null ? `（当前总完成率 ${(rate * 100).toFixed(0)}%）` : ''}。`, payload: { id: p.task_id, completion_rate: rate } };
  },
};

function num01(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
}

export async function exec(confirm_token, typed_name) {
  try {
    const t = typeof confirm_token === 'string' ? pending.get(confirm_token) : null;
    if (!t) return { ok: false, message: '确认令牌无效或已使用，请重新发起操作。' };
    if (Date.now() > t.exp) {
      pending.delete(confirm_token);
      return { ok: false, message: '确认已超时（5 分钟有效），请重新发起操作。' };
    }
    // 危险操作双确认：输入的目标名必须与计划完全一致
    if (INTENTS[t.intent].danger && typed_name !== t.target_name) {
      return { ok: false, message: `危险操作需二次确认：请输入「${t.target_name}」后再次执行。` };
    }
    const r = await HANDLERS[t.intent](t.params);
    pending.delete(confirm_token);   // 成功才消费令牌（失败可原令牌重试）
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, message: String(e?.message ?? e).slice(0, 300) };
  }
}

// ---------- 读类：立即执行（纯代码聚合） ----------
function execStatsQuery(params, project) {
  const p = getProfile();
  const s = computeScores();
  const gaps = Object.entries(s.cDetails).filter(([, v]) => v.required && v.score < 0.7);
  const lines = [
    `成长三维（目标 L${p.target_level}，通道 ${p.track === 'pmo' ? 'PMO' : '项目/项目群组'}）：知识 K=${s.K} / 素质 C=${s.C} / 经验 E=${s.E}，短板合成等级 L${s.composite}。`,
    gaps.length
      ? `素质差距（<0.7，共 ${gaps.length} 项）：${gaps.slice(0, 6).map(([, v]) => `${v.name} ${v.score}`).join('、')}${gaps.length > 6 ? ' 等' : ''}。`
      : '目标级素质项当前均 ≥0.7，无明显短板。',
    `经验硬指标：${s.met}/${s.total_reqs} 项达标。`,
  ];
  const payload = {
    growth: { K: s.K, C: s.C, E: s.E, composite: s.composite, met: s.met, total_reqs: s.total_reqs },
    gaps: gaps.map(([id, v]) => ({ id, name: v.name, score: v.score })),
  };
  if (project) {
    const risks = db.prepare(`SELECT COUNT(*) c FROM risks WHERE project_id=? AND status='open'`).get(project.id).c;
    const alerts = db.prepare(`SELECT dimension, message FROM alerts WHERE project_id=? AND status='open'`).all(project.id);
    const act = db.prepare(`SELECT COUNT(*) t, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) d FROM action_items WHERE project_id=?`).get(project.id);
    lines.push(`项目「${project.name}」：开放风险 ${risks} 条；行动项完成 ${act.d ?? 0}/${act.t}；未处理预警 ${alerts.length} 条${alerts.length ? `（${alerts.map((a) => a.message).join('；')}）` : ''}。`);
    payload.project = { id: project.id, name: project.name, risks_open: risks, actions_done: act.d ?? 0, actions_total: act.t, alerts };
  }
  return { kind: 'result', intent: 'stats.query', result: lines.join('\n'), payload };
}

function execCardSearch(params) {
  const q = String(params.q ?? '').trim();
  const like = `%${q}%`;
  const cards = db.prepare(`SELECT id, domain, front, level_tag FROM knowledge_cards
                            WHERE front LIKE ? OR back LIKE ? OR domain LIKE ? ORDER BY id LIMIT 5`).all(like, like, like);
  if (!cards.length) {
    return { kind: 'result', intent: 'card.search', result: `没有找到与「${q}」相关的知识卡片（可在强化营播种题库后再试）。`, payload: { cards: [] } };
  }
  return { kind: 'result', intent: 'card.search',
    result: `找到 ${cards.length} 张相关卡片：\n${cards.map((c) => `· #${c.id} [${c.domain}${c.level_tag ? '·' + c.level_tag : ''}] ${c.front}`).join('\n')}`,
    payload: { cards } };
}

// ---------- 主动建议：open 容差预警 → 例外教练；否则今日待复习 → 强化营 ----------
export function suggest() {
  const tol = db.prepare(`SELECT a.dimension, a.message, p.name project_name FROM alerts a
                          JOIN projects p ON p.id=a.project_id
                          WHERE a.status='open' AND a.dimension IN ('time','cost') ORDER BY a.id DESC LIMIT 1`).get();
  if (tol) {
    const dim = tol.dimension === 'cost' ? '成本' : '进度';
    return { suggestion: { text: `检测到「${tol.project_name}」${dim}容差预警未处理：${tol.message}。进入例外应对训练？`, action: 'coach:exception' } };
  }
  const due = dueQueue(200).length;
  if (due > 0) return { suggestion: { text: `今日有 ${due} 张知识卡待复习，去强化营练一轮？`, action: 'drill' } };
  return { suggestion: null };
}

// ---------- R6.6 对话日志（侧栏唯一 AI 面：文本消息持久化；错误条为会话内状态不落库） ----------
// R6.6b 计划卡持久化：kind=plan，content 存 {plan, state} 的 JSON——confirm_token 不落库（安全边界），
// 刷新后以冻结态回放（pending 降级为「未确认」，done/canceled 终态原样展示）
const MSG_ROLES = ['me', 'ai'];
const MSG_KINDS = ['text', 'result', 'plan'];
const PLAN_STATES = ['pending', 'done', 'canceled'];

export function addMessage({ role, kind = 'text', content }) {
  const r = String(role ?? '').trim();
  if (!MSG_ROLES.includes(r)) throw badRequest(`role 须为 me|ai：${role}`);
  const k = MSG_KINDS.includes(kind) ? kind : 'text';   // 未知 kind 归 text 容错
  let text = String(content ?? '').trim();
  if (!text) throw badRequest('内容不能为空');
  if (k === 'plan') {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw badRequest('计划卡内容须为合法 JSON'); }
    if (!parsed || typeof parsed.plan !== 'object' || parsed.plan === null) throw badRequest('计划卡内容缺少 plan 对象');
    parsed.state = PLAN_STATES.includes(parsed.state) ? parsed.state : 'pending';
    text = JSON.stringify(parsed);   // 规范化存储（state 显式化）
    if (text.length > 4000) throw badRequest('计划卡内容过长（≤4000 字）');
  } else if (text.length > 2000) {
    throw badRequest('内容过长（≤2000 字）');
  }
  const info = db.prepare('INSERT INTO assistant_messages (role, kind, content) VALUES (?,?,?)').run(r, k, text);
  return db.prepare('SELECT * FROM assistant_messages WHERE id=?').get(info.lastInsertRowid);
}

export function listMessages(limit = 200) {
  const rows = db.prepare('SELECT * FROM assistant_messages ORDER BY id DESC LIMIT ?').all(Number(limit) || 200);
  return rows.reverse();   // 最近 N 条按写入顺序（升序）返回
}

// R6.6b 计划卡终态回写（done|canceled；仅 plan 行可更新——只改记录状态，令牌不落库、不可回退 pending）
export function updatePlanState(id, state) {
  const num = Number(id);
  const row = db.prepare('SELECT * FROM assistant_messages WHERE id=?').get(num);
  if (!row) throw notFound(`消息不存在：id=${id}`);
  if (row.kind !== 'plan') throw conflict('该消息不是计划卡，不能更新状态');
  if (!['done', 'canceled'].includes(state)) throw badRequest(`state 须为 done|canceled：${state}`);
  const data = JSON.parse(row.content);
  data.state = state;
  db.prepare('UPDATE assistant_messages SET content=? WHERE id=?').run(JSON.stringify(data), num);
  return db.prepare('SELECT * FROM assistant_messages WHERE id=?').get(num);
}

export function clearMessages(confirm) {
  if (String(confirm ?? '') !== 'clear') throw badRequest('清空需二次确认：confirm 必须为 clear');
  const info = db.prepare('DELETE FROM assistant_messages').run();
  return { cleared: info.changes };
}
