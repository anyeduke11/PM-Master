// MCP 壳域路由（R7.0 P5，M 区）
import { listMcp, createMcp, updateMcp, deleteMcp, checkMcp } from '../mcp.mjs';

export function register(app) {
  app.get('/api/v2/settings/mcp', async () => listMcp());
  app.post('/api/v2/settings/mcp', async (req) => createMcp(req.body ?? {}));
  app.put('/api/v2/settings/mcp/:id', async (req) => updateMcp(req.params.id, req.body ?? {}));
  app.delete('/api/v2/settings/mcp/:id', async (req) => deleteMcp(req.params.id));
  app.post('/api/v2/settings/mcp/:id/check', async (req) => checkMcp(req.params.id));
}