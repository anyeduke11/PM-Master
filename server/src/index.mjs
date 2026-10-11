// PM-Master 服务层 P0：Fastify + SQLite + SSE 首条对话流
import Fastify from 'fastify';
import { loadStandard, levelRequirements, gapAnalysis } from './standard.mjs';
import { db, getProfile, updateProfile } from './db.mjs';
import { streamChat, buildSystemPrompt, llmStats } from './agent.mjs';
import { cfg, allSettings, setSettings, systemCore } from './settings.mjs';   // R7.0 P1 设置中心
import { importKinds, importPreview, importCommit, importLogs } from './import-flow.mjs';   // R7.0 P2 数据流入
import { toolUsage, assignToolTask } from './tools-usage.mjs';                              // R7.0 P2 工具频率
import { patrolRun, patrolReports } from './patrol.mjs';                                    // R7.0 P3 每日巡检
import { listPrompts, createPrompt, updatePrompt, deletePrompt } from './prompts.mjs';      // R7.0 P3 提示词库
import { listScenarios, createSession, loadSession, handleMessage, control, closeSession, phasePlan } from './coach.mjs';

const app = Fastify({ logger: { transport: undefined } });
export { app };   // R6.3 全站测试：test/api.boundary.test.mjs 以 app.inject 作 HTTP seam（不起端口）
app.log.level = 'warn';

// R6.4 错误风格：errors.mjs 显式标注的 4xx 透传（body 形态与 fastify 默认一致，前端按 out.statusCode 判错）；
// 未标注错误按内部错误保持 500——机制只升降级显式标记，不误伤
import { badRequest, notFound, conflict } from './errors.mjs';
const STATUS_NAMES = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict' };
app.setErrorHandler((err, req, reply) => {
  const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  if (sc >= 500) req.log.error(err);
  reply.code(sc).send({ statusCode: sc, error: STATUS_NAMES[sc] ?? 'Internal Server Error', message: String(err?.message ?? err) });
});

// ---------- 标准库 ----------
app.get('/api/standard/:name', async (req) => loadStandard(req.params.name));

// R6.3 全站测试 J6：等级须为 1-5 整数（国标 L1-L5），非法值 400 清晰文案（原：兜底 L4 或裸类型错 500）
app.get('/api/requirements/:level', async (req, reply) => {
  const lv = Number(req.params.level);
  if (!Number.isInteger(lv) || lv < 1 || lv > 5) {
    return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: `等级须为 1-5 的整数（对应国标 L1-L5），收到：${req.params.level}` });
  }
  return levelRequirements(lv, req.query?.track ?? 'project');
});

app.post('/api/gap-analysis', async (req) => {
  const { achieved = [], level = getProfile().target_level, track } = req.body ?? {};
  return gapAnalysis(achieved, Number(level), track ?? getProfile().track);
});

// ---------- 档案 ----------
app.get('/api/profile', async () => {
  const p = getProfile();
  return { ...p, system_prompt_preview: buildSystemPrompt(p).slice(0, 200) };
});
app.put('/api/profile', async (req) => updateProfile(req.body ?? {}));

// ---------- 首条对话流（SSE，pi/LLM 经适配层） ----------
app.post('/api/chat', (req, reply) => {
  const profile = getProfile();
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20) : [];
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('meta', { provider: cfg('llm.provider'), level: profile.current_level });
  streamChat({ messages, profile }, (delta) => send('delta', { delta }))
    .then((full) => {
      send('done', { chars: full.length });
      reply.raw.end();
    })
    .catch((err) => { send('error', { message: String(err.message ?? err) }); reply.raw.end(); });
});

// ---------- 教练会话（GROW 状态机，P1） ----------
app.get('/api/coach/scenarios', async () => listScenarios());

// 会话列表（未关闭可恢复优先；含评定摘要）
app.get('/api/coach/sessions', async () => {
  const rows = db.prepare(`SELECT id, scenario, mode, rating, closed_at, started_at, grow_data
                           FROM coach_sessions ORDER BY (closed_at IS NULL) DESC, id DESC LIMIT 50`).all();
  return rows.map((r) => {
    const d = JSON.parse(r.grow_data ?? '{}');
    return {
      id: r.id, scenario: r.scenario, mode: r.mode,
      phase: d.phase ?? '?', step: d.step ?? 0,
      open: !r.closed_at,
      started_at: r.started_at,
      rating: r.rating ? JSON.parse(r.rating) : null,
      artifact: d.collected?.will?.slice(0, 80) ?? '',
    };
  });
});

app.post('/api/coach/sessions', async (req) => createSession(req.body ?? {}));

app.get('/api/coach/sessions/:id', async (req) => {
  const s = loadSession(Number(req.params.id));
  return { ...view_of(s) };
});
function view_of(s) {
  // 轻量视图（含 steps 供前端恢复进度条）
  const v = s.data;
  const plan = phasePlan(v.mode ?? 'standard');
  return {
    id: s.id, scenario: s.row.scenario, mode: v.mode, phase: v.phase, step: v.step,
    steps: plan[v.phase]?.steps ?? [], collected: v.collected,
    history: v.history ?? [], closed: !!s.row.closed_at,
    rating: s.row.rating ? JSON.parse(s.row.rating) : null,
    last_reply: '',
  };
}

app.post('/api/coach/sessions/:id/messages', async (req) => handleMessage(Number(req.params.id), String(req.body?.content ?? '')));

app.post('/api/coach/sessions/:id/control', async (req) => control(Number(req.params.id), req.body?.cmd));

app.post('/api/coach/sessions/:id/close', async (req) => closeSession(Number(req.params.id), req.body ?? {}));

// 行为证据流水查询（雷达数据源）
app.get('/api/scores/behavior', async () =>
  db.prepare(`SELECT indicator_id, behavior_score, evidence_refs, assessed_at FROM competency_scores WHERE behavior_score IS NOT NULL ORDER BY assessed_at DESC LIMIT 50`).all());

// ---------- P2 实战线：项目工作台 ----------
import {
  evm as calcEvm, checkTolerances, generateWeekly, secondOrder, riskToIssue, actionCompletionRate,
  portfolioOverview,
} from './workbench.mjs';

app.get('/api/projects', async () =>
  db.prepare('SELECT * FROM projects ORDER BY id DESC').all());
app.post('/api/projects', async (req) => {
  const b = req.body ?? {};
  // R6.3 全站测试 J3：项目名必填非空（原空名兜底会建出空名脏行）
  const name = String(b.name ?? '').trim();
  if (!name) throw badRequest('项目名称必填');
  const info = db.prepare('INSERT INTO projects (name, complexity, role, start_date, tolerances) VALUES (?,?,?,?,?)')
    .run(name, b.complexity ?? 'normal', b.role ?? '项目经理',
      b.start_date ?? new Date().toISOString().slice(0, 10),
      JSON.stringify(b.tolerances ?? { cost: 0.1, time: 0.1 }));
  return db.prepare('SELECT * FROM projects WHERE id=?').get(info.lastInsertRowid);
});

// R3.3 收益填写（组合视图真值来源）：body {benefit_target, benefit_actual}，可传 null 清空
app.post('/api/projects/:id/benefit', async (req) => {
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const t = num(req.body?.benefit_target);
  const a = num(req.body?.benefit_actual);
  if (t != null && !Number.isFinite(t)) throw badRequest('benefit_target 须为数字或 null');
  if (a != null && !Number.isFinite(a)) throw badRequest('benefit_actual 须为数字或 null');
  const info = db.prepare('UPDATE projects SET benefit_target=?, benefit_actual=? WHERE id=?').run(t, a, Number(req.params.id));
  if (!info.changes) throw notFound('project not found');
  return db.prepare('SELECT * FROM projects WHERE id=?').get(Number(req.params.id));
});

// 容差比对（纯代码，可单独调用）：body {pv,ev,ac}
app.post('/api/projects/:id/tolerance-check', async (req) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(Number(req.params.id));
  if (!project) throw notFound('project not found');
  const e = calcEvm(req.body ?? {});
  if (!e) return { evm: null, violations: [], note: '需要 pv/ev/ac > 0' };
  const violations = checkTolerances(project, e);
  return { evm: e, violations };
});

// 周报生成（LLM + 容差引擎联动）
app.post('/api/projects/:id/weekly', async (req) => generateWeekly(Number(req.params.id), req.body ?? {}));

app.get('/api/projects/:id/artifacts', async (req) =>
  db.prepare('SELECT * FROM project_artifacts WHERE project_id=? ORDER BY id DESC').all(Number(req.params.id)));

// 风险登记册
app.get('/api/projects/:id/risks', async (req) =>
  db.prepare('SELECT * FROM risks WHERE project_id=? ORDER BY id DESC').all(Number(req.params.id)));
app.post('/api/projects/:id/risks', async (req) => {
  const b = req.body ?? {};
  const info = db.prepare('INSERT INTO risks (project_id, title, probability, impact, strategy) VALUES (?,?,?,?,?)')
    .run(Number(req.params.id), String(b.title ?? ''), b.probability ?? 0.5, b.impact ?? 0.5, b.strategy ?? null);
  const risk = db.prepare('SELECT * FROM risks WHERE id=?').get(info.lastInsertRowid);
  // R2.4 W1.3 智能关联：新风险登记 → 卡片式工具提示（不打断，前端渲染提示条）
  return { risk, hints: hintsFor('risk_new') };
});
app.post('/api/risks/:id/second-order', async (req) => secondOrder(Number(req.params.id)));
app.post('/api/risks/:id/to-issue', async (req) => riskToIssue(Number(req.params.id)));

// 干系人
app.get('/api/projects/:id/stakeholders', async (req) =>
  db.prepare('SELECT * FROM stakeholders WHERE project_id=?').all(Number(req.params.id)));
app.post('/api/projects/:id/stakeholders', async (req) => {
  const b = req.body ?? {};
  const info = db.prepare('INSERT INTO stakeholders (project_id, name, power, interest, current_engagement, desired_engagement, notes) VALUES (?,?,?,?,?,?,?)')
    .run(Number(req.params.id), String(b.name ?? ''), b.power ?? 5, b.interest ?? 5,
      b.current_engagement ?? '中立', b.desired_engagement ?? '支持', b.notes ?? null);
  return db.prepare('SELECT * FROM stakeholders WHERE id=?').get(info.lastInsertRowid);
});

// 会议 + 行动项
app.get('/api/projects/:id/meetings', async (req) => {
  const ms = db.prepare('SELECT * FROM meetings WHERE project_id=? ORDER BY id DESC').all(Number(req.params.id));
  const acts = db.prepare('SELECT * FROM action_items WHERE project_id=? ORDER BY due_date').all(Number(req.params.id));
  return ms.map((m) => ({ ...m, actions: acts.filter((a) => a.meeting_id === m.id) }));
});
app.post('/api/projects/:id/meetings', async (req) => {
  const b = req.body ?? {};
  const info = db.prepare('INSERT INTO meetings (project_id, title, held_at, summary) VALUES (?,?,?,?)')
    .run(Number(req.params.id), b.title ?? '会议', b.held_at ?? new Date().toISOString().slice(0, 16).replace('T', ' '), b.summary ?? '');
  for (const a of b.actions ?? []) {
    db.prepare('INSERT INTO action_items (project_id, meeting_id, title, owner, due_date) VALUES (?,?,?,?,?)')
      .run(Number(req.params.id), info.lastInsertRowid, a.title ?? '', a.owner ?? '', a.due_date ?? null);
  }
  return db.prepare('SELECT * FROM meetings WHERE id=?').get(info.lastInsertRowid);
});
app.post('/api/actions/:id/status', async (req) => {
  const status = req.body?.status === 'done' ? 'done' : 'open';
  // R6.4：不存在行动项不得假成功（v5.9.2 登记项，与 J4 同族）
  // R6.4 K2 抓出存量真缺陷：SQL 双引号字符串字面量在 node:sqlite 严格模式报 no such column（AGENTS.md 已知坑），此路由此前实际不可用
  const info = db.prepare(`UPDATE action_items SET status=?, completed_at=CASE WHEN ?='done' THEN datetime('now','localtime') ELSE NULL END WHERE id=?`)
    .run(status, status, Number(req.params.id));
  if (info.changes === 0) throw notFound(`行动项不存在：id=${req.params.id}`);
  return { id: Number(req.params.id), status, completion_rate: actionCompletionRate() };
});

// 预警（黄金闭环入口）
app.get('/api/alerts', async () =>
  db.prepare(`SELECT a.*, p.name project_name FROM alerts a JOIN projects p ON p.id=a.project_id WHERE a.status='open' ORDER BY a.id DESC`).all());
app.post('/api/alerts/:id/ack', async (req) => {
  // R6.4：不存在预警不得假成功（v5.9.2 登记项②转正）
  const info = db.prepare('UPDATE alerts SET status=? WHERE id=?').run(req.body?.status ?? 'acknowledged', Number(req.params.id));
  if (info.changes === 0) throw notFound(`预警不存在：id=${req.params.id}`);
  return { ok: true };
});

// ---------- 成长记录（原证据银行） ----------
app.get('/api/evidence', async () =>
  db.prepare('SELECT * FROM evidence ORDER BY id DESC LIMIT 100').all());
app.post('/api/evidence', async (req) => {
  const b = req.body ?? {};
  const info = db.prepare('INSERT INTO evidence (type, title, description, tags) VALUES (?,?,?,?)')
    .run(b.type ?? 'case', String(b.title ?? ''), b.description ?? '', JSON.stringify(b.tags ?? ['CSPM 经验记录']));
  return db.prepare('SELECT * FROM evidence WHERE id=?').get(info.lastInsertRowid);
});

// 经验硬指标现值（成长记录页进度条）
app.get('/api/experience-stats', async () => {
  const rows = db.prepare('SELECT key, value FROM experience_stats').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
});
app.put('/api/experience-stats', async (req) => {
  for (const [k, v] of Object.entries(req.body ?? {})) {
    // R6.3 全站测试 J5：现值须为非负数字（原 NaN→null、负数直接入库毁进度条）
    const n = Number(v);
    if (v === null || v === '' || !Number.isFinite(n) || n < 0) throw badRequest(`经验值须为非负数字：${k}=${JSON.stringify(v)}`);
    db.prepare(`INSERT INTO experience_stats (key, value) VALUES (?,?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')`)
      .run(k, n);
  }
  return Object.fromEntries(db.prepare('SELECT key, value FROM experience_stats').all().map((r) => [r.key, r.value]));
});

// ---------- 飞书（P2 读 + P3 写回；凭据未配置时明确降级） ----------
import { feishuConfigured, exportDoc } from './feishu.mjs';
app.get('/api/feishu/status', async () => {
  const configured = feishuConfigured();
  return { configured, mode: configured ? 'ready' : 'manual', note: configured ? '' : '在 server/.env 配置 FEISHU_APP_ID/SECRET 后启用拉取；当前为手动粘贴模式' };
});
// 周报/报告写回飞书云文档：body {title, markdown}；未配置时返回可识别错误（前端降级下载）
app.post('/api/feishu/export-doc', async (req, reply) => {
  const { title, markdown } = req.body ?? {};
  if (!markdown) throw badRequest('markdown 必填');
  try {
    return await exportDoc({ title, markdown });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') return reply.code(400).send({ code: 'NOT_CONFIGURED', message: e.message });
    throw e;
  }
});

// ---------- R5.3 C1 数据导出（Markdown 人读汇总 / JSON 全库包，附件下载） ----------
import { exportJSON, exportMarkdown } from './export.mjs';

app.get('/api/export/markdown', async (req, reply) => {
  const { markdown } = exportMarkdown();
  reply.header('Content-Type', 'text/markdown; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="pm-master-export-${new Date().toISOString().slice(0, 10)}.md"`);
  return markdown;
});
app.get('/api/export/json', async (req, reply) => {
  reply.header('Content-Disposition', `attachment; filename="pm-master-export-${new Date().toISOString().slice(0, 10)}.json"`);
  // R6.5 C3：?tables=a,b 白名单过滤（exportJSON 内校验，未知表 400）
  return exportJSON(req.query?.tables != null ? { tables: req.query.tables } : {});
});

// ---------- R6.1 C1 使用反馈（R6.3 使用期数据地基；删除双确认） ----------
import { addFeedback, listFeedback, feedbackStats, resolveFeedback, deleteFeedback } from './feedback.mjs';

app.post('/api/feedback', async (req) => addFeedback(req.body ?? {}));
app.get('/api/feedback', async (req) => listFeedback({ status: req.query?.status, limit: req.query?.limit }));
app.get('/api/feedback/stats', async () => feedbackStats());
app.post('/api/feedback/:id/resolve', async (req) => resolveFeedback(req.params.id));
app.delete('/api/feedback/:id', async (req) => deleteFeedback(req.params.id, req.query?.confirm));

// ---------- P3 闭环：强化营 / 成长路径 / 定时任务 ----------
import { seedCards, dueQueue, dueSummary, cardStats, review, genScenario, gradeScenario, cardFeynman } from './drill.mjs';
import { monthlyRecalc, history as growthHistory, computeScores, monthlyReport } from './growth.mjs';
import { linkStats } from './growth-links.mjs';
import { notify, listNotifications, markRead, markAllRead, deliverReport } from './notify.mjs';

app.post('/api/drill/seed', async () => seedCards());
app.get('/api/drill/queue', async () => { seedCards(); return dueQueue(); });
app.get('/api/drill/due-summary', async () => { seedCards(); return dueSummary(); });   // R4.3 WP7
app.get('/api/drill/stats', async () => cardStats());
app.post('/api/drill/cards/:id/review', async (req) => review(Number(req.params.id), req.body?.grade));
app.post('/api/drill/cards/:id/feynman', async (req) => cardFeynman(Number(req.params.id), String(req.body?.explanation ?? '')));   // R5.1 WP1
app.post('/api/drill/scenario/:domain', async (req) => genScenario(req.params.domain));
app.post('/api/drill/scenario/:id/answer', async (req) => gradeScenario(Number(req.params.id), String(req.body?.answer ?? '')));

app.get('/api/growth/scores', async () => computeScores());
app.get('/api/growth/history', async () => growthHistory());
app.post('/api/growth/recalc', async () => monthlyRecalc());   // F3 手动触发=定时器同款
app.get('/api/growth/links', async () => linkStats());
app.get('/api/llm/stats', async (req) => llmStats({
  days: req.query?.days, purpose: req.query?.purpose ?? null, limit: req.query?.limit,
}));                                        // R4.3 WP8 LLM 调用观测（R7.0 P1：加 days/purpose/limit 参数）

// ---------- R7.0 P1 设置中心 ----------
app.get('/api/settings', async () => allSettings());
app.put('/api/settings', async (req) => setSettings(req.body));   // 白名单校验失败 400；value=null 恢复 env/默认
app.get('/api/settings/system', async () => ({
  ...systemCore(),
  feishu_configured: feishuConfigured(),   // 飞书凭据状态（同样仅布尔，不回显）
}));

// ---------- R7.0 P2 数据流入 + 工具频率 ----------
app.get('/api/import/kinds', async () => importKinds());
app.post('/api/import/preview', async (req) => importPreview({ kind: req.body?.kind, text: req.body?.text, source: req.body?.source }));
app.post('/api/import/commit', async (req) => importCommit({ kind: req.body?.kind, rows: req.body?.rows, source: req.body?.source }));
app.get('/api/import/logs', async (req) => importLogs(req.query?.limit));
app.get('/api/tools/usage', async () => toolUsage());
app.post('/api/tools/usage/task', async (req) => {
  if (req.body?.tool_id == null) throw badRequest('tool_id 必填');
  return assignToolTask(req.body.tool_id);
});

// ---------- R7.0 P3 巡检简报 + 提示词库 ----------
app.get('/api/patrol/reports', async (req) => patrolReports(req.query?.limit));
app.get('/api/prompts', async (req) => listPrompts({ enabledOnly: req.query?.enabled === '1' }));
app.post('/api/prompts', async (req) => createPrompt(req.body ?? {}));
app.put('/api/prompts/:id', async (req) => updatePrompt(req.params.id, req.body ?? {}));
app.delete('/api/prompts/:id', async (req) => deletePrompt(req.params.id));
app.post('/api/growth/monthly-report', async () => {
  try { return { report: monthlyReport() }; }
  catch (e) { return { error: String(e.message) }; }
});
app.get('/api/tasks', async () => db.prepare('SELECT * FROM training_tasks ORDER BY status, id DESC LIMIT 20').all());
app.post('/api/tasks/:id/status', async (req) => {
  // R6.3 全站测试 J4a：不存在任务不得假成功（原 UPDATE 0 行仍返回 ok:true）
  const info = db.prepare('UPDATE training_tasks SET status=? WHERE id=?').run(req.body?.status ?? 'done', Number(req.params.id));
  if (info.changes === 0) throw notFound(`任务不存在：id=${req.params.id}`);
  return { ok: true };
});

// 定时任务（AI native：agent 主动工作；R3.2 加固：注册表统一 cron，调度循环遍历全部 job）
// cron 为简化式「分 时 日 月 周」，支持 * 与具体数字（单用户本地足够；多实例需替换 node-cron）
const JOBS = {
  daily_review: {
    cron: '0 9 * * *', label: '每日 09:00 复习提醒',
    // R5.3 C3：到期/逾期数进通知中心（0 张不打扰不落通知）；诚实标注：进程内 job 只在服务运行时的触发点投递
    fn: () => {
      const s = dueSummary();
      if (s.due_today > 0) {
        notify({
          kind: 'info',
          title: s.overdue > 0 ? `复习提醒：今日 ${s.due_today} 张（含逾期 ${s.overdue}）` : `复习提醒：今日 ${s.due_today} 张到期`,
          body: `强化营今日应复习 ${s.due_today} 张${s.overdue > 0 ? `，其中逾期 ${s.overdue} 张` : ''}；未来 7 天还有 ${s.upcoming_total} 张。`,
          payload: { job: 'daily_review', ...s },
        });
      }
      return { due_today: s.due_today, overdue: s.overdue, notified: s.due_today > 0 };
    },
  },
  monthly_recalc: {
    cron: '0 8 1 * *', label: '每月 1 日 08:00 月度重算',
    fn: () => monthlyRecalc(),
  },
  monthly_report: {
    cron: '5 8 1 * *', label: '每月 1 日 08:05 月报生成与推送',
    fn: async () => {
      const { markdown, stats } = monthlyReport();
      const d = await deliverReport({ title: `PM-Master 成长月报 ${new Date().toISOString().slice(0, 10)}`, markdown });
      return { chars: markdown.length, closure_rate: stats.closure_rate, feishu: d.feishu };
    },
  },
  // R7.0 P3 每日巡检（08:00 错开 09:00 复习提醒；同日重跑 upsert 幂等，手动触发与 cron 撞车安全）
  patrol: {
    cron: '0 8 * * *', label: '每日 08:00 项目与成长巡检',
    fn: () => patrolRun(),
  },
};

function cronMatch(expr, d) {
  const [mi, ho, dom, mo, dow] = String(expr).split(/\s+/);
  const hit = (f, v) => f === '*' || Number(f) === v;
  return hit(mi, d.getMinutes()) && hit(ho, d.getHours()) && hit(dom, d.getDate())
    && hit(mo, d.getMonth() + 1) && hit(dow, d.getDay());
}

const jobState = {};          // {job: {cron,label,last_run,last_result,last_error}}
const running = new Set();

// 执行单个 job：记录 last_run/last_result；失败落 error 通知后抛回（调用方决定如何暴露，不静默）
export async function runJob(name) {
  const j = JOBS[name];
  if (!j) throw badRequest(`unknown job: ${name}`);
  if (running.has(name)) throw conflict(`job 正在执行中：${name}`);
  running.add(name);
  const startedAt = new Date().toISOString();
  try {
    const result = await j.fn();
    jobState[name] = { cron: j.cron, label: j.label, last_run: startedAt, last_result: 'ok', last_error: null };
    return { job: name, cron: j.cron, label: j.label, result };
  } catch (e) {
    const message = String(e?.message ?? e);
    notify({ kind: 'error', title: `定时任务失败：${j.label}`, body: message, payload: { job: name } });
    jobState[name] = { cron: j.cron, label: j.label, last_run: startedAt, last_result: 'error', last_error: message };
    throw e;
  } finally {
    running.delete(name);
  }
}

app.get('/api/scheduler', async () =>
  Object.fromEntries(Object.entries(JOBS).map(([k, j]) => [k, { cron: j.cron, label: j.label, ...(jobState[k] ?? {}) }])));
app.post('/api/scheduler/run/:job', async (req) => runJob(req.params.job));

// 进程内调度：每分钟检查全部 job（命中 cron 且本分钟未执行过 → 触发）
setInterval(() => {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16);
  for (const [name, j] of Object.entries(JOBS)) {
    if (!cronMatch(j.cron, now)) continue;
    if (jobState[name]?.last_run?.slice(0, 16) === stamp) continue;   // 同分钟防重
    runJob(name).catch((e) => console.warn(`[scheduler] ${name} 失败：${e.message}`));
  }
}, 60_000).unref();

// ---------- R3.2 通知中心 ----------
app.get('/api/notifications', async (req) => listNotifications(Number(req.query?.limit) || 30));
app.post('/api/notifications/:id/read', async (req) => markRead(req.params.id));
app.post('/api/notifications/read-all', async () => markAllRead());

// ---------- 冷启动向导（F0 · PRD 6.4：导入式/问答式/跳过） ----------
import { onboardChat } from './agent.mjs';

// 履历结构化（仅预览，不落库；用户确认后走 commit）
app.post('/api/onboard/import', async (req) => {
  const text = String(req.body?.text ?? '').trim();
  if (text.length < 30) throw badRequest('文本太短，请粘贴简历或项目经历（≥30字）');
  const draft = await onboardChat({ text });
  if (!draft?.suggested_level) throw new Error('结构化失败，请补充更多项目细节后重试');
  return draft;
});

// 确认落库：档案 + 项目 + 经验现值 原子写入（等价 F0 ②③④⑧步）
app.post('/api/onboard/commit', async (req) => {
  const b = req.body ?? {};
  const level = Math.max(1, Math.min(5, Number(b.level) || 1));
  const track = b.track === 'pmo' ? 'pmo' : 'project';
  db.prepare(`UPDATE user_profile SET current_level=?, target_level=?, track=?, initialized=1, updated_at=datetime('now','localtime') WHERE id=1`)
    .run(level, Math.min(level + 1, 5), track);
  const insP = db.prepare('INSERT INTO projects (name, complexity, role, start_date, end_date, tolerances) VALUES (?,?,?,?,?,?)');
  for (const p of (b.projects ?? []).slice(0, 10)) {
    insP.run(String(p.name ?? '未命名'), ['normal', 'complex', 'program', 'portfolio'].includes(p.complexity) ? p.complexity : 'normal',
      p.role ?? '项目经理', p.start || null, p.end || null, JSON.stringify({ cost: 0.1, time: 0.1 }));
  }
  if (b.experience_stats && typeof b.experience_stats === 'object') {
    for (const [k, v] of Object.entries(b.experience_stats)) {
      if (v == null || Number.isNaN(Number(v))) continue;
      db.prepare(`INSERT INTO experience_stats (key, value) VALUES (?,?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')`).run(k, Number(v));
    }
  }
  return getProfile();
});

// 跳过（保留现有档案，仅标记已完成）
app.post('/api/onboard/skip', async () => {
  db.prepare('UPDATE user_profile SET initialized=1 WHERE id=1').run();
  return getProfile();
});

// ---------- R2.1 全局 AI 助手 ----------
import {
  parse as assistantParse, exec as assistantExec, suggest as assistantSuggest,
  addMessage, listMessages, clearMessages, updatePlanState,
} from './assistant.mjs';

app.post('/api/assistant/parse', async (req) => assistantParse(String(req.body?.text ?? ''), req.body?.pageContext ?? {}));
app.post('/api/assistant/exec', async (req) => assistantExec(req.body?.confirm_token, req.body?.typed_name));
app.get('/api/assistant/suggest', async () => assistantSuggest());

// R6.6 对话日志（侧栏唯一 AI 面：文本消息持久化；清空双确认）+ R6.6b 计划卡状态流转
app.get('/api/assistant/messages', async (req) => listMessages(req.query?.limit));
app.post('/api/assistant/messages', async (req) => addMessage(req.body ?? {}));
app.delete('/api/assistant/messages', async (req) => clearMessages(req.query?.confirm));
app.post('/api/assistant/messages/:id/plan-state', async (req) => updatePlanState(req.params.id, req.body?.state));

// ---------- W4 风险评估专项 ----------
import {
  SCENARIOS, listRaProjects, createRaProject, raDetail, addAsset, addFinding,
  updateFinding, setRaPhase, raExtract, raReport,
} from './ra.mjs';

app.get('/api/ra/scenarios', async () => SCENARIOS);
app.get('/api/ra/projects', async () => listRaProjects());
app.post('/api/ra/projects', async (req) => createRaProject(req.body ?? {}));
app.get('/api/ra/projects/:id', async (req) => raDetail(Number(req.params.id)));
app.post('/api/ra/projects/:id/phase', async (req) => setRaPhase(Number(req.params.id), req.body?.phase));
app.post('/api/ra/projects/:id/assets', async (req) => addAsset(Number(req.params.id), req.body ?? {}));
app.post('/api/ra/projects/:id/findings', async (req) => addFinding(Number(req.params.id), req.body ?? {}));
app.post('/api/ra/findings/:id', async (req) => updateFinding(Number(req.params.id), req.body ?? {}));
app.post('/api/ra/projects/:id/extract', async (req) => raExtract(Number(req.params.id), String(req.body?.text ?? '')));
app.post('/api/ra/projects/:id/report', async (req) => raReport(Number(req.params.id)));

// ---------- R2.2 ITTO 知识库 + 工具实操题（启动时幂等播种） ----------
import { seedItto, overview as ittoOverview, listProcesses, processDetail, searchTools,
         genPractice, submitPractice, practiceHistory } from './itto.mjs';

seedItto();

app.get('/api/itto/overview', async () => ittoOverview());
app.get('/api/itto/processes', async (req) => listProcesses(req.query?.ka));
app.get('/api/itto/processes/:id', async (req) => processDetail(Number(req.params.id)));
app.get('/api/itto/tools', async (req) => searchTools(req.query?.q));
app.get('/api/itto/practice/history', async (req) => practiceHistory(Number(req.query?.limit) || 10));
app.post('/api/itto/practice/generate', async (req) => genPractice(req.body ?? {}));
app.post('/api/itto/practice/submit', async (req) =>
  submitPractice(String(req.body?.token ?? ''), String(req.body?.answer ?? '')));

// ---------- R2.4 W1.2 四步教学 + W1.3 智能关联 + W3.3 组合视图 ----------
import { startTutor, advanceTutor, feynman } from './tutor.mjs';
import { hintsFor } from './context-hints.mjs';

// ---------- R3.4 WP6 掌握度矩阵（工具与卡片并轨 M0-M3；M3 → 知识贡献证据） ----------
import { masteryMatrix, promoteM3Evidence } from './mastery.mjs';

app.get('/api/itto/mastery-matrix', async () => masteryMatrix());
app.post('/api/itto/mastery/evidence', async (req) => promoteM3Evidence(req.body?.tool_id));

app.post('/api/itto/tutor/start', async (req) => startTutor({ tool_id: req.body?.tool_id }));
app.post('/api/itto/tutor/advance', async (req) =>
  advanceTutor(String(req.body?.token ?? ''), { answer: String(req.body?.answer ?? '') }));
app.post('/api/itto/tutor/feynman', async (req) =>
  feynman(String(req.body?.token ?? ''), String(req.body?.explanation ?? '')));
app.get('/api/hints', async (req) => hintsFor(String(req.query?.event ?? '')));
app.get('/api/portfolio', async () => portfolioOverview());

// ---------- 健康 ----------
app.get('/api/health', async () => ({
  ok: true, tables: db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c,
  provider: cfg('llm.provider'),
}));

const PORT = Number(process.env.PORT ?? 8735);
// PM_NO_LISTEN=1 时不监听端口（R5.3：acceptance 直接 import 本模块取 runJob，不与测试抢端口/日志；e2e 隔离 server 正常监听）
if (process.env.PM_NO_LISTEN !== '1') {
  app.listen({ port: PORT, host: '127.0.0.1' }).then(() => {
    console.log(`PM-Master 工作台已就绪 → http://127.0.0.1:${PORT} (provider=${cfg('llm.provider')})`);
  });
}
