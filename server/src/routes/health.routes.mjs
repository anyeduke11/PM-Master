// 健康自检域路由
import { tableCount } from '../repo/health.repo.mjs';
import { cfg } from '../settings.mjs';

export function register(app) {
  app.get('/api/health', async () => ({
    ok: true, tables: tableCount(),
    provider: cfg('llm.provider'),
  }));
}