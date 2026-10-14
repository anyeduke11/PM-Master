// 通知中心域路由（R3.2）
import { listNotifications, markRead, markAllRead } from '../notify.mjs';

export function register(app) {
  app.get('/api/v2/notifications', async (req) => listNotifications(Number(req.query?.limit) || 30));
  app.post('/api/v2/notifications/:id/read', async (req) => markRead(req.params.id));
  app.post('/api/v2/notifications/read-all', async () => markAllRead());
}