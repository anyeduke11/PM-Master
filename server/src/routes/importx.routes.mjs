// 数据流入 + 工具频率域路由（R7.0 P2）
import { importKinds, importPreview, importCommit, importLogs } from '../import-flow.mjs';
import { toolUsage, assignToolTask } from '../tools-usage.mjs';
import { badRequest } from '../errors.mjs';

export function register(app) {
  app.get('/api/v2/import/kinds', async () => importKinds());
  app.post('/api/v2/import/preview', async (req) => importPreview({ kind: req.body?.kind, text: req.body?.text, source: req.body?.source }));
  app.post('/api/v2/import/commit', async (req) => importCommit({ kind: req.body?.kind, rows: req.body?.rows, source: req.body?.source }));
  app.get('/api/v2/import/logs', async (req) => importLogs(req.query?.limit));
  app.get('/api/v2/tools/usage', async () => toolUsage());
  app.post('/api/v2/tools/usage/task', async (req) => {
    if (req.body?.tool_id == null) throw badRequest('tool_id 必填');
    return assignToolTask(req.body.tool_id);
  });
}