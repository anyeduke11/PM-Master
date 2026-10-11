// R3.2 通知中心（W3.4 完整形态）：系统内通知的统一投递与读写
// 纯代码无 LLM；kind = info（一般）| report（月报/产物）| error（定时任务失败——失败显式通道）
import { db } from './db.mjs';
import { feishuConfigured, exportDoc } from './feishu.mjs';
import { notFound } from './errors.mjs';   // R6.4 错误风格

export function notify({ kind = 'info', title, body = '', payload = null }) {
  const info = db.prepare('INSERT INTO notifications (kind, title, body, payload) VALUES (?,?,?,?)')
    .run(kind, String(title ?? '通知'), String(body ?? ''), payload ? JSON.stringify(payload) : null);
  return db.prepare('SELECT * FROM notifications WHERE id=?').get(info.lastInsertRowid);
}

export function unreadCount() {
  return db.prepare('SELECT COUNT(*) c FROM notifications WHERE read=0').get().c;
}

export function listNotifications(limit = 30) {
  return {
    unread: unreadCount(),
    items: db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null })),
  };
}

export function markRead(id) {
  // R6.3 全站测试 J4b：不存在通知不得假成功（原 UPDATE 0 行仍返回 200）
  const info = db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(Number(id));
  if (info.changes === 0) throw notFound(`通知不存在：id=${id}`);
  return { id: Number(id), unread: unreadCount() };
}

export function markAllRead() {
  db.prepare('UPDATE notifications SET read=1 WHERE read=0').run();
  return { unread: 0 };
}

// 月报投递：本地通知必达；飞书仅在凭据就绪时写回，失败不吞——降级为 error 通知（诚实标注）
export async function deliverReport({ title, markdown }) {
  const note = notify({
    kind: 'report',
    title,
    body: markdown.slice(0, 400),
    payload: { chars: markdown.length },
  });
  if (!feishuConfigured()) return { notification: note, feishu: { skipped: '未配置飞书凭据，仅本地通知' } };
  try {
    const doc = await exportDoc({ title, markdown });
    notify({ kind: 'report', title: `${title} · 已写回飞书`, body: doc.url, payload: { document_id: doc.document_id, url: doc.url } });
    return { notification: note, feishu: doc };
  } catch (e) {
    notify({ kind: 'error', title: `${title} · 飞书写回失败`, body: String(e.message ?? e), payload: { step: 'feishu_export' } });
    return { notification: note, feishu: { error: String(e.message ?? e) } };
  }
}