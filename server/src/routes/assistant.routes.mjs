// 全局 AI 助手域路由（R2.1）+ 对话日志（R6.6/R6.6b）
import {
  parse as assistantParse, exec as assistantExec, suggest as assistantSuggest,
  addMessage, listMessages, clearMessages, updatePlanState,
} from '../assistant.mjs';

export function register(app) {
  app.post('/api/v2/assistant/parse', async (req) => assistantParse(String(req.body?.text ?? ''), req.body?.pageContext ?? {}));
  app.post('/api/v2/assistant/exec', async (req) => assistantExec(req.body?.confirm_token, req.body?.typed_name));
  app.get('/api/v2/assistant/suggest', async () => assistantSuggest());

  // R6.6 对话日志（侧栏唯一 AI 面：文本消息持久化；清空双确认）+ R6.6b 计划卡状态流转
  app.get('/api/v2/assistant/messages', async (req) => listMessages(req.query?.limit));
  app.post('/api/v2/assistant/messages', async (req) => addMessage(req.body ?? {}));
  app.delete('/api/v2/assistant/messages', async (req) => clearMessages(req.query?.confirm));
  app.post('/api/v2/assistant/messages/:id/plan-state', async (req) => updatePlanState(req.params.id, req.body?.state));
}