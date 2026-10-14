// 使用反馈域路由（R6.1 C1；R6.3 使用期数据地基；删除双确认）
import { addFeedback, listFeedback, feedbackStats, resolveFeedback, deleteFeedback } from '../feedback.mjs';

export function register(app) {
  app.post('/api/v2/feedback', async (req) => addFeedback(req.body ?? {}));
  app.get('/api/v2/feedback', async (req) => listFeedback({ status: req.query?.status, limit: req.query?.limit }));
  app.get('/api/v2/feedback/stats', async () => feedbackStats());
  app.post('/api/v2/feedback/:id/resolve', async (req) => resolveFeedback(req.params.id));
  app.delete('/api/v2/feedback/:id', async (req) => deleteFeedback(req.params.id, req.query?.confirm));
}