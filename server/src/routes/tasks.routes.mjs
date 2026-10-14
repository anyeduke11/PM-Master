// 训练任务域路由
import { notFound } from '../errors.mjs';
import { listTrainingTasks, updateTrainingTaskStatus } from '../repo/tasks.repo.mjs';

export function register(app) {
  app.get('/api/v2/drill/tasks', async () => listTrainingTasks());
  app.post('/api/v2/drill/tasks/:id/status', async (req) => {
    // R6.3 全站测试 J4a：不存在任务不得假成功（原 UPDATE 0 行仍返回 ok:true）
    const info = updateTrainingTaskStatus(Number(req.params.id), req.body?.status ?? 'done');
    if (info.changes === 0) throw notFound(`任务不存在：id=${req.params.id}`);
    return { ok: true };
  });
}