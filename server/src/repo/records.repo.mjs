// 成长记录数据访问：evidence（原证据银行）与 experience_stats（经验硬指标现值）
import { db } from '../db.mjs';

// ---------- 成长记录（原证据银行） ----------
export const listEvidence = () => db.prepare('SELECT * FROM evidence ORDER BY id DESC LIMIT 100').all();

export function insertEvidence(type, title, description, tags) {
  const info = db.prepare('INSERT INTO evidence (type, title, description, tags) VALUES (?,?,?,?)')
    .run(type, title, description, tags);
  return db.prepare('SELECT * FROM evidence WHERE id=?').get(info.lastInsertRowid);
}

// ---------- 经验硬指标现值（成长记录页进度条） ----------
export const listExperienceStats = () => db.prepare('SELECT key, value FROM experience_stats').all();

export const upsertExperienceStat = (k, n) =>
  db.prepare(`INSERT INTO experience_stats (key, value) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')`).run(k, n);