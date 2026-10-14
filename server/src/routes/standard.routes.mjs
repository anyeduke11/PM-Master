// 标准库域路由：国标结构化装载 / 等级要求 / 差距分析
import { loadStandard, levelRequirements, gapAnalysis } from '../standard.mjs';
import { getProfile } from '../db.mjs';

export function register(app) {
  app.get('/api/v2/standard/:name', async (req) => loadStandard(req.params.name));

  // R6.3 全站测试 J6：等级须为 1-5 整数（国标 L1-L5），非法值 400 清晰文案（原：兜底 L4 或裸类型错 500）
  app.get('/api/v2/standard/requirements/:level', async (req, reply) => {
    const lv = Number(req.params.level);
    if (!Number.isInteger(lv) || lv < 1 || lv > 5) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: `等级须为 1-5 的整数（对应国标 L1-L5），收到：${req.params.level}` });
    }
    return levelRequirements(lv, req.query?.track ?? 'project');
  });

  app.post('/api/v2/standard/gap-analysis', async (req) => {
    const { achieved = [], level = getProfile().target_level, track } = req.body ?? {};
    return gapAnalysis(achieved, Number(level), track ?? getProfile().track);
  });
}