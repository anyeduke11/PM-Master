// 首条对话流（SSE，pi/LLM 经适配层）
import { getProfile } from '../db.mjs';
import { streamChat } from '../agent.mjs';
import { cfg } from '../settings.mjs';

export function register(app) {
  app.post('/api/v2/chat', (req, reply) => {
    const profile = getProfile();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20) : [];
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('meta', { provider: cfg('llm.provider'), level: profile.current_level });
    streamChat({ messages, profile, pageContext: req.body?.pageContext ?? {} }, (delta) => send('delta', { delta }))
      .then((full) => {
        send('done', { chars: full.length });
        reply.raw.end();
      })
      .catch((err) => { send('error', { message: String(err.message ?? err) }); reply.raw.end(); });
  });
}