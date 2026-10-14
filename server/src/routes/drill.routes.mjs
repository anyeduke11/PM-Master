// 强化营域路由（P3 闭环）：卡片播种/到期队列/SM-2 复习/费曼/情景题
import { seedCards, dueQueue, dueSummary, cardStats, review, genScenario, gradeScenario, cardFeynman } from '../drill.mjs';

export function register(app) {
  app.post('/api/v2/drill/seed', async () => seedCards());
  app.get('/api/v2/drill/queue', async () => { seedCards(); return dueQueue(); });
  app.get('/api/v2/drill/due-summary', async () => { seedCards(); return dueSummary(); });   // R4.3 WP7
  app.get('/api/v2/drill/stats', async () => cardStats());
  app.post('/api/v2/drill/cards/:id/review', async (req) => review(Number(req.params.id), req.body?.grade));
  app.post('/api/v2/drill/cards/:id/feynman', async (req) => cardFeynman(Number(req.params.id), String(req.body?.explanation ?? '')));   // R5.1 WP1
  app.post('/api/v2/drill/scenario/:domain', async (req) => genScenario(req.params.domain));
  app.post('/api/v2/drill/scenario/:id/answer', async (req) => gradeScenario(Number(req.params.id), String(req.body?.answer ?? '')));
}