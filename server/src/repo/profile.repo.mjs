// 档案域数据访问：冷启动向导（onboard）commit/skip 的写入（等价 F0 ②③④⑧步）
import { db } from '../db.mjs';

// 确认落库：档案标记（幂等，updated_at 刷新）
export const setOnboardProfile = (currentLevel, targetLevel, track) =>
  db.prepare(`UPDATE user_profile SET current_level=?, target_level=?, track=?, initialized=1, updated_at=datetime('now','localtime') WHERE id=1`)
    .run(currentLevel, targetLevel, track);

// 履历项目批量落库
export const insertOnboardProject = (name, complexity, role, start, end) =>
  db.prepare('INSERT INTO projects (name, complexity, role, start_date, end_date, tolerances) VALUES (?,?,?,?,?,?)')
    .run(name, complexity, role, start, end, JSON.stringify({ cost: 0.1, time: 0.1 }));

// 履历经验现值 upsert
export const upsertOnboardExperienceStat = (k, v) =>
  db.prepare(`INSERT INTO experience_stats (key, value) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')`).run(k, v);

// 跳过（保留现有档案，仅标记已完成）
export const markOnboardInitialized = () =>
  db.prepare('UPDATE user_profile SET initialized=1 WHERE id=1').run();