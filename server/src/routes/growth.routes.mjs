// 成长路径域路由（P3 闭环）：三维评分/历史/重算/关联 + LLM 观测量 + 月报
import { monthlyRecalc, history as growthHistory, computeScores, monthlyReport } from '../growth.mjs';
import { linkStats } from '../growth-links.mjs';
import { llmStats } from '../agent.mjs';

export function register(app) {
  app.get('/api/v2/growth/scores', async () => computeScores());
  app.get('/api/v2/growth/history', async () => growthHistory());
  app.post('/api/v2/growth/recalc', async () => monthlyRecalc());   // F3 手动触发=定时器同款
  app.get('/api/v2/growth/links', async () => linkStats());
  app.get('/api/v2/growth/llm/stats', async (req) => llmStats({
    days: req.query?.days, purpose: req.query?.purpose ?? null, limit: req.query?.limit,
  }));                                        // R4.3 WP8 LLM 调用观测（R7.0 P1：加 days/purpose/limit 参数）
  app.post('/api/v2/growth/monthly-report', async () => {
    try { return { report: monthlyReport() }; }
    catch (e) { return { error: String(e.message) }; }
  });
}