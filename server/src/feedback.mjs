// R6.1 C1 使用反馈：提交/列表/聚合/标记解决/删除（删除双确认——输入条目 id 才执行，项目硬规则）
// 纯代码零 LLM；R6.3 使用期汇总评审的数据地基
import { db } from './db.mjs';
import { badRequest, notFound } from './errors.mjs';   // R6.4 错误风格

const SOURCES = ['chat', 'records', 'coach', 'drill'];
const TAGS = ['bug', '体验', '建议', '其他'];

export function addFeedback({ source, rating, tag, content }) {
  const text = String(content ?? '').trim();
  if (!text) throw badRequest('反馈内容不能为空');
  if (text.length > 2000) throw badRequest('反馈内容过长（≤2000 字）');
  const src = SOURCES.includes(source) ? source : '其他';
  const t = TAGS.includes(tag) ? tag : '其他';
  const r = rating == null || rating === '' ? null : Number(rating);
  if (r != null && (!Number.isInteger(r) || r < 1 || r > 5)) throw badRequest('rating 须为 1-5 整数');
  const info = db.prepare('INSERT INTO feedback (source, rating, tag, content) VALUES (?,?,?,?)').run(src, r, t, text);
  return db.prepare('SELECT * FROM feedback WHERE id=?').get(info.lastInsertRowid);
}

export function listFeedback({ status, limit = 100 } = {}) {
  const where = status === 'open' || status === 'resolved' ? `WHERE status='${status}'` : '';
  return db.prepare(`SELECT * FROM feedback ${where} ORDER BY id DESC LIMIT ?`).all(Number(limit) || 100);
}

// 汇总：R6.3 使用期评审的数据源（评分分布 + tag 分布 + open 数）
export function feedbackStats() {
  const total = db.prepare('SELECT COUNT(*) c FROM feedback').get().c;
  const open = db.prepare(`SELECT COUNT(*) c FROM feedback WHERE status='open'`).get().c;
  const byTag = db.prepare(`SELECT tag, COUNT(*) c FROM feedback GROUP BY tag ORDER BY c DESC`).all();
  const byRating = db.prepare(`SELECT rating, COUNT(*) c FROM feedback WHERE rating IS NOT NULL GROUP BY rating ORDER BY rating`).all();
  const ratings = byRating.flatMap((r) => Array(r.c).fill(r.rating));
  const avg = ratings.length ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : null;
  return { total, open, resolved: total - open, avg_rating: avg, by_tag: byTag, by_rating: byRating };
}

export function resolveFeedback(id) {
  const row = db.prepare('SELECT id FROM feedback WHERE id=?').get(Number(id));
  if (!row) throw notFound('feedback not found');
  db.prepare(`UPDATE feedback SET status='resolved' WHERE id=?`).run(Number(id));
  return { id: Number(id), status: 'resolved' };
}

// 删除双确认（项目硬规则）：confirm 必须等于条目 id 才执行——防误删
export function deleteFeedback(id, confirm) {
  const num = Number(id);
  if (Number(confirm) !== num) throw badRequest('删除需二次确认：confirm 参数必须等于条目 id');
  const row = db.prepare('SELECT id FROM feedback WHERE id=?').get(num);
  if (!row) throw notFound('feedback not found');
  db.prepare('DELETE FROM feedback WHERE id=?').run(num);
  return { deleted: num };
}
