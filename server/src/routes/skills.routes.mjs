// 技能注册表域路由（R7.0 P5，L 区）
import { listSkills, setSkillEnabled } from '../skills.mjs';

export function register(app) {
  app.get('/api/v2/settings/skills', async () => listSkills());
  app.put('/api/v2/settings/skills/:id', async (req) => setSkillEnabled(req.params.id, req.body?.enabled));
}