// 档案域路由：档案读写 + 冷启动向导（F0 · PRD 6.4：导入式/问答式/跳过）
import { getProfile, updateProfile } from '../db.mjs';
import { buildSystemPrompt, onboardChat } from '../agent.mjs';
import { badRequest } from '../errors.mjs';
import {
  setOnboardProfile, insertOnboardProject, upsertOnboardExperienceStat, markOnboardInitialized,
} from '../repo/profile.repo.mjs';

export function register(app) {
  // ---------- 档案 ----------
  app.get('/api/v2/profile', async () => {
    const p = getProfile();
    return { ...p, system_prompt_preview: buildSystemPrompt(p).slice(0, 200) };
  });
  app.put('/api/v2/profile', async (req) => updateProfile(req.body ?? {}));

  // ---------- 冷启动向导 ----------
  // 履历结构化（仅预览，不落库；用户确认后走 commit）
  app.post('/api/v2/profile/onboard/import', async (req) => {
    const text = String(req.body?.text ?? '').trim();
    if (text.length < 30) throw badRequest('文本太短，请粘贴简历或项目经历（≥30字）');
    const draft = await onboardChat({ text });
    if (!draft?.suggested_level) throw new Error('结构化失败，请补充更多项目细节后重试');
    return draft;
  });

  // 确认落库：档案 + 项目 + 经验现值 原子写入（等价 F0 ②③④⑧步）
  app.post('/api/v2/profile/onboard/commit', async (req) => {
    const b = req.body ?? {};
    const level = Math.max(1, Math.min(5, Number(b.level) || 1));
    const track = b.track === 'pmo' ? 'pmo' : 'project';
    setOnboardProfile(level, Math.min(level + 1, 5), track);
    for (const p of (b.projects ?? []).slice(0, 10)) {
      insertOnboardProject(String(p.name ?? '未命名'), ['normal', 'complex', 'program', 'portfolio'].includes(p.complexity) ? p.complexity : 'normal',
        p.role ?? '项目经理', p.start || null, p.end || null);
    }
    if (b.experience_stats && typeof b.experience_stats === 'object') {
      for (const [k, v] of Object.entries(b.experience_stats)) {
        if (v == null || Number.isNaN(Number(v))) continue;
        upsertOnboardExperienceStat(k, Number(v));
      }
    }
    return getProfile();
  });

  // 跳过（保留现有档案，仅标记已完成）
  app.post('/api/v2/profile/onboard/skip', async () => {
    markOnboardInitialized();
    return getProfile();
  });
}