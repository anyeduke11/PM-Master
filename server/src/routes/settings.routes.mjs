// 设置中心域路由（R7.0 P1）
import { allSettings, setSettings, systemCore } from '../settings.mjs';
import { feishuConfigured } from '../feishu.mjs';

export function register(app) {
  app.get('/api/v2/settings', async () => allSettings());
  app.put('/api/v2/settings', async (req) => setSettings(req.body));   // 白名单校验失败 400；value=null 恢复 env/默认
  app.get('/api/v2/settings/system', async () => ({
    ...systemCore(),
    feishu_configured: feishuConfigured(),   // 飞书凭据状态（同样仅布尔，不回显）
  }));
}