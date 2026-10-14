// 成长记录域路由（原证据银行）：evidence + 经验硬指标现值
import { badRequest } from '../errors.mjs';
import { listEvidence, insertEvidence, listExperienceStats, upsertExperienceStat } from '../repo/records.repo.mjs';

export function register(app) {
  app.get('/api/v2/records/evidence', async () => listEvidence());
  app.post('/api/v2/records/evidence', async (req) => {
    const b = req.body ?? {};
    return insertEvidence(b.type ?? 'case', String(b.title ?? ''), b.description ?? '', JSON.stringify(b.tags ?? ['CSPM 经验记录']));
  });

  // 经验硬指标现值（成长记录页进度条）
  app.get('/api/v2/records/experience-stats', async () => {
    const rows = listExperienceStats();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });
  app.put('/api/v2/records/experience-stats', async (req) => {
    for (const [k, v] of Object.entries(req.body ?? {})) {
      // R6.3 全站测试 J5：现值须为非负数字（原 NaN→null、负数直接入库毁进度条）
      const n = Number(v);
      if (v === null || v === '' || !Number.isFinite(n) || n < 0) throw badRequest(`经验值须为非负数字：${k}=${JSON.stringify(v)}`);
      upsertExperienceStat(k, n);
    }
    return Object.fromEntries(listExperienceStats().map((r) => [r.key, r.value]));
  });
}