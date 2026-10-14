// ITTO 知识库 + 工具实操题域路由（R2.2；启动时幂等播种）
// R2.4 W1.2 四步教学 + R3.4 WP6 掌握度矩阵（工具与卡片并轨 M0-M3）
import { seedItto, overview as ittoOverview, listProcesses, processDetail, searchTools,
         genPractice, submitPractice, practiceHistory } from '../itto.mjs';
import { startTutor, advanceTutor, feynman } from '../tutor.mjs';
import { masteryMatrix, promoteM3Evidence } from '../mastery.mjs';

// 启动时幂等播种（与原 index.mjs 顶层调用等价）
seedItto();

export function register(app) {
  app.get('/api/v2/itto/overview', async () => ittoOverview());
  app.get('/api/v2/itto/processes', async (req) => listProcesses(req.query?.ka));
  app.get('/api/v2/itto/processes/:id', async (req) => processDetail(Number(req.params.id)));
  app.get('/api/v2/itto/tools', async (req) => searchTools(req.query?.q));
  app.get('/api/v2/itto/practice/history', async (req) => practiceHistory(Number(req.query?.limit) || 10));
  app.post('/api/v2/itto/practice/generate', async (req) => genPractice(req.body ?? {}));
  app.post('/api/v2/itto/practice/submit', async (req) =>
    submitPractice(String(req.body?.token ?? ''), String(req.body?.answer ?? '')));

  app.get('/api/v2/itto/mastery-matrix', async () => masteryMatrix());
  app.post('/api/v2/itto/mastery/evidence', async (req) => promoteM3Evidence(req.body?.tool_id));

  app.post('/api/v2/itto/tutor/start', async (req) => startTutor({ tool_id: req.body?.tool_id }));
  app.post('/api/v2/itto/tutor/advance', async (req) =>
    advanceTutor(String(req.body?.token ?? ''), { answer: String(req.body?.answer ?? '') }));
  app.post('/api/v2/itto/tutor/feynman', async (req) =>
    feynman(String(req.body?.token ?? ''), String(req.body?.explanation ?? '')));
}