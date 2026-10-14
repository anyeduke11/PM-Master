// 巡检简报域路由（R7.0 P3）
import { patrolReports } from '../patrol.mjs';

export function register(app) {
  app.get('/api/v2/patrol/reports', async (req) => patrolReports(req.query?.limit));
}