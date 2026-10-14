// 提示词库域路由（R7.0 P3）
import { listPrompts, createPrompt, updatePrompt, deletePrompt } from '../prompts.mjs';

export function register(app) {
  app.get('/api/v2/settings/prompts', async (req) => listPrompts({ enabledOnly: req.query?.enabled === '1' }));
  app.post('/api/v2/settings/prompts', async (req) => createPrompt(req.body ?? {}));
  app.put('/api/v2/settings/prompts/:id', async (req) => updatePrompt(req.params.id, req.body ?? {}));
  app.delete('/api/v2/settings/prompts/:id', async (req) => deletePrompt(req.params.id));
}