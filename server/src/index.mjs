// PM-Master 服务层装配根：Fastify 实例 + 错误风格 + 路由装配 + 启动
import Fastify from 'fastify';
import { cfg } from './settings.mjs';
import { registerRoutes } from './routes/index.mjs';
import { runJob } from './scheduler.mjs';

const app = Fastify({ logger: { transport: undefined } });
export { app };   // R6.3 全站测试：test/api.boundary.test.mjs 以 app.inject 作 HTTP seam（不起端口）
app.log.level = 'warn';

// R6.4 错误风格：errors.mjs 显式标注的 4xx 透传（body 形态与 fastify 默认一致，前端按 out.statusCode 判错）；
// 未标注错误按内部错误保持 500——机制只升降级显式标记，不误伤
const STATUS_NAMES = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict' };
app.setErrorHandler((err, req, reply) => {
  const sc = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  if (sc >= 500) req.log.error(err);
  reply.code(sc).send({ statusCode: sc, error: STATUS_NAMES[sc] ?? 'Internal Server Error', message: String(err?.message ?? err) });
});

// 各域路由装配（顺序与拆分前一致）
registerRoutes(app);

// 兼容测试 seam：acceptance 直接 import runJob（不跑调度循环）
export { runJob };

const PORT = Number(process.env.PORT ?? 8735);
// PM_NO_LISTEN=1 时不监听端口（R5.3：acceptance 直接 import 本模块取 runJob，不与测试抢端口/日志；e2e 隔离 server 正常监听）
if (process.env.PM_NO_LISTEN !== '1') {
  app.listen({ port: PORT, host: '127.0.0.1' }).then(() => {
    console.log(`PM-Master 工作台已就绪 → http://127.0.0.1:${PORT} (provider=${cfg('llm.provider')})`);
  });
}