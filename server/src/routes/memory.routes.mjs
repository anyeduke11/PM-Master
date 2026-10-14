// 记忆与画像域路由（R7.0 P4，F/H 区）
import { listMemories, addMemory, updateMemory, deleteMemory, distillProfile, contextPreview, runMemoryMaintenance } from '../memory.mjs';

export function register(app) {
  app.get('/api/v2/settings/memories', async (req) => listMemories(req.query?.limit, req.query ?? {}));
  app.post('/api/v2/settings/memories', async (req) => addMemory(req.body ?? {}));
  app.put('/api/v2/settings/memories/:id', async (req) => updateMemory(req.params.id, req.body ?? {}));
  app.delete('/api/v2/settings/memories/:id', async (req) => deleteMemory(req.params.id));
  app.post('/api/v2/profile/distill', async () => distillProfile());
  app.get('/api/v2/context/preview', async () => contextPreview());
  // R7.1 P2：晋升/衰减维护（真实注入路径已自动触发；此处供手动/观测调用）
  app.post('/api/v2/memories/maintenance', async () => runMemoryMaintenance());
}