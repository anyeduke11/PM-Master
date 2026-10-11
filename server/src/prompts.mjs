// R7.0 P3 提示词库：常用 PM 场景固化为快捷指令（CRUD + 启停；助手侧栏渲染启用项为按钮）
// 纯数据层零 LLM；校验走 errors.mjs（400/404 fail loud）
import { db } from './db.mjs';
import { badRequest, notFound } from './errors.mjs';

const clean = (v, max) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
};

export function listPrompts({ enabledOnly = false } = {}) {
  return db.prepare(`SELECT * FROM prompts ${enabledOnly ? 'WHERE enabled=1' : ''} ORDER BY sort, id`).all();
}

export function createPrompt({ title, content, sort = 0 }) {
  const t = clean(title, 30);
  const c = clean(content, 2000);
  if (!t) throw badRequest('标题必填（≤30 字）');
  if (!c) throw badRequest('提示词内容必填');
  const info = db.prepare('INSERT INTO prompts (title, content, sort) VALUES (?,?,?)')
    .run(t, c, Math.max(0, Math.min(999, Number(sort) || 0)));
  return db.prepare('SELECT * FROM prompts WHERE id=?').get(Number(info.lastInsertRowid));
}

export function updatePrompt(id, patch) {
  const row = db.prepare('SELECT * FROM prompts WHERE id=?').get(Number(id));
  if (!row) throw notFound(`提示词不存在：id=${id}`);
  // 显式传字段但清洗后为空 → 400 fail loud（不静默回退旧值）；未传字段保持原值
  const take = (key, max, cur) => {
    if (!(key in patch)) return cur;
    const v = clean(patch[key], max);
    if (!v) throw badRequest(`${key === 'title' ? '标题' : '内容'}不得为空`);
    return v;
  };
  const next = {
    title: take('title', 30, row.title),
    content: take('content', 2000, row.content),
    enabled: 'enabled' in patch ? (patch.enabled ? 1 : 0) : row.enabled,
    sort: 'sort' in patch ? Math.max(0, Math.min(999, Number(patch.sort) || 0)) : row.sort,
  };
  db.prepare('UPDATE prompts SET title=?, content=?, enabled=?, sort=? WHERE id=?')
    .run(next.title, next.content, next.enabled, next.sort, row.id);
  return db.prepare('SELECT * FROM prompts WHERE id=?').get(row.id);
}

export function deletePrompt(id) {
  const info = db.prepare('DELETE FROM prompts WHERE id=?').run(Number(id));
  if (info.changes === 0) throw notFound(`提示词不存在：id=${id}`);
  return { ok: true };
}
