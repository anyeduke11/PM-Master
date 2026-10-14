// 教练域路由：GROW 会话（P1）+ 行为证据流水
import { listScenarios, createSession, loadSession, handleMessage, control, closeSession, phasePlan } from '../coach.mjs';
import { listSessions, behaviorScores } from '../repo/coach.repo.mjs';

// 轻量视图（含 steps 供前端恢复进度条）
function view_of(s) {
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

export function register(app) {
  app.get('/api/v2/coach/scenarios', async () => listScenarios());

  // 会话列表（未关闭可恢复优先；含评定摘要）
  app.get('/api/v2/coach/sessions', async () => {
    const rows = listSessions();
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

  app.post('/api/v2/coach/sessions', async (req) => createSession(req.body ?? {}));

  app.get('/api/v2/coach/sessions/:id', async (req) => {
    const s = loadSession(Number(req.params.id));
    return { ...view_of(s) };
  });

  app.post('/api/v2/coach/sessions/:id/messages', async (req) => handleMessage(Number(req.params.id), String(req.body?.content ?? '')));

  app.post('/api/v2/coach/sessions/:id/control', async (req) => control(Number(req.params.id), req.body?.cmd));

  app.post('/api/v2/coach/sessions/:id/close', async (req) => closeSession(Number(req.params.id), req.body ?? {}));

  // 行为证据流水查询（雷达数据源）
  app.get('/api/v2/coach/scores/behavior', async () => behaviorScores());
}