// 项目实战线路由（P2）：项目/收益/容差/产物/风险/干系人/会议行动项/预警 + 智能关联 + 组合视图
import {
  evm as calcEvm, checkTolerances, generateWeekly, secondOrder, riskToIssue, actionCompletionRate,
  portfolioOverview,
} from '../workbench.mjs';
import { hintsFor } from '../context-hints.mjs';
import { rememberProjectEvent } from '../memory.mjs';
import { badRequest, notFound } from '../errors.mjs';
import {
  listProjects, insertProject, getProject, updateBenefit, listArtifacts,
  listRisks, insertRisk, listStakeholders, insertStakeholder,
  listMeetings, listActionItems, insertMeeting, insertActionItem, getMeeting,
  updateActionStatus, listOpenAlerts, updateAlertStatus,
} from '../repo/project.repo.mjs';

export function register(app) {
  app.get('/api/v2/projects', async () => listProjects());
  app.post('/api/v2/projects', async (req) => {
    const b = req.body ?? {};
    // R6.3 全站测试 J3：项目名必填非空（原空名兜底会建出空名脏行）
    const name = String(b.name ?? '').trim();
    if (!name) throw badRequest('项目名称必填');
    return insertProject(name, b.complexity ?? 'normal', b.role ?? '项目经理',
      b.start_date ?? new Date().toISOString().slice(0, 10),
      JSON.stringify(b.tolerances ?? { cost: 0.1, time: 0.1 }));
  });

  // R3.3 收益填写（组合视图真值来源）：body {benefit_target, benefit_actual}，可传 null 清空
  app.post('/api/v2/projects/:id/benefit', async (req) => {
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const t = num(req.body?.benefit_target);
    const a = num(req.body?.benefit_actual);
    if (t != null && !Number.isFinite(t)) throw badRequest('benefit_target 须为数字或 null');
    if (a != null && !Number.isFinite(a)) throw badRequest('benefit_actual 须为数字或 null');
    const info = updateBenefit(Number(req.params.id), t, a);
    if (!info.changes) throw notFound('project not found');
    return getProject(Number(req.params.id));
  });

  // 容差比对（纯代码，可单独调用）：body {pv,ev,ac}
  app.post('/api/v2/projects/:id/tolerance-check', async (req) => {
    const project = getProject(Number(req.params.id));
    if (!project) throw notFound('project not found');
    const e = calcEvm(req.body ?? {});
    if (!e) return { evm: null, violations: [], note: '需要 pv/ev/ac > 0' };
    const violations = checkTolerances(project, e);
    return { evm: e, violations };
  });

  // 周报生成（LLM + 容差引擎联动）
  app.post('/api/v2/projects/:id/weekly', async (req) => generateWeekly(Number(req.params.id), req.body ?? {}));

  app.get('/api/v2/projects/:id/artifacts', async (req) => listArtifacts(Number(req.params.id)));

  // 风险登记册
  app.get('/api/v2/projects/:id/risks', async (req) => listRisks(Number(req.params.id)));
  app.post('/api/v2/projects/:id/risks', async (req) => {
    const b = req.body ?? {};
    const pid = Number(req.params.id);
    const risk = insertRisk(pid, String(b.title ?? ''), b.probability ?? 0.5, b.impact ?? 0.5, b.strategy ?? null);
    // R7.1 P2：项目事件 → 项目级记忆（复利闭环①；fail-soft，不反噬登记）
    rememberProjectEvent('risk', pid, risk);
    // R2.4 W1.3 智能关联：新风险登记 → 卡片式工具提示（不打断，前端渲染提示条）
    return { risk, hints: hintsFor('risk_new') };
  });
  app.post('/api/v2/projects/risks/:id/second-order', async (req) => secondOrder(Number(req.params.id)));
  app.post('/api/v2/projects/risks/:id/to-issue', async (req) => riskToIssue(Number(req.params.id)));

  // 干系人
  app.get('/api/v2/projects/:id/stakeholders', async (req) => listStakeholders(Number(req.params.id)));
  app.post('/api/v2/projects/:id/stakeholders', async (req) => {
    const b = req.body ?? {};
    const pid = Number(req.params.id);
    const sh = insertStakeholder(pid, String(b.name ?? ''), b.power ?? 5, b.interest ?? 5,
      b.current_engagement ?? '中立', b.desired_engagement ?? '支持', b.notes ?? null);
    // R7.1 P2：项目事件 → 项目级记忆（复利闭环①；fail-soft，不反噬登记）
    rememberProjectEvent('stakeholder', pid, sh);
    return sh;
  });

  // 会议 + 行动项
  app.get('/api/v2/projects/:id/meetings', async (req) => {
    const pid = Number(req.params.id);
    const ms = listMeetings(pid);
    const acts = listActionItems(pid);
    return ms.map((m) => ({ ...m, actions: acts.filter((a) => a.meeting_id === m.id) }));
  });
  app.post('/api/v2/projects/:id/meetings', async (req) => {
    const b = req.body ?? {};
    const pid = Number(req.params.id);
    const mid = insertMeeting(pid, b.title ?? '会议', b.held_at ?? new Date().toISOString().slice(0, 16).replace('T', ' '), b.summary ?? '');
    for (const a of b.actions ?? []) {
      insertActionItem(pid, mid, a.title ?? '', a.owner ?? '', a.due_date ?? null);
    }
    // R7.1 P2：会议纪要承载决策 → 项目级记忆（仅 summary 非空；fail-soft，不反噬归档）
    if (String(b.summary ?? '').trim()) rememberProjectEvent('decision', pid, { title: b.title ?? '会议', summary: b.summary });
    return getMeeting(mid);
  });
  app.post('/api/v2/projects/actions/:id/status', async (req) => {
    const status = req.body?.status === 'done' ? 'done' : 'open';
    // R6.4：不存在行动项不得假成功（v5.9.2 登记项，与 J4 同族）
    // R6.4 K2 抓出存量真缺陷：SQL 双引号字符串字面量在 node:sqlite 严格模式报 no such column（AGENTS.md 已知坑），此路由此前实际不可用
    const info = updateActionStatus(Number(req.params.id), status);
    if (info.changes === 0) throw notFound(`行动项不存在：id=${req.params.id}`);
    return { id: Number(req.params.id), status, completion_rate: actionCompletionRate() };
  });

  // 预警（黄金闭环入口）
  app.get('/api/v2/projects/alerts', async () => listOpenAlerts());
  app.post('/api/v2/projects/alerts/:id/ack', async (req) => {
    // R6.4：不存在预警不得假成功（v5.9.2 登记项②转正）
    const info = updateAlertStatus(Number(req.params.id), req.body?.status ?? 'acknowledged');
    if (info.changes === 0) throw notFound(`预警不存在：id=${req.params.id}`);
    return { ok: true };
  });

  // R2.4 W1.3 智能关联 + W3.3 组合视图
  app.get('/api/v2/projects/hints', async (req) => hintsFor(String(req.query?.event ?? '')));
  app.get('/api/v2/projects/portfolio', async () => portfolioOverview());
}