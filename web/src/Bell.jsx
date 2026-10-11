// R3.2 通知中心前端：铃铛 + 未读角标 + 下拉列表（月报/定时任务失败的统一入口）
import React, { useEffect, useRef, useState } from 'react';
import { IconBell } from '@tabler/icons-react';

const KIND_ICON = { info: '·', report: '◈', error: '!' };

export default function Bell() {
  const [data, setData] = useState({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const pollMs = useRef(60_000);   // R7.0 P1：轮询间隔可配置（ui.notify_poll_s），pm-settings 事件即时更新

  async function load() {
    const d = await fetch('/api/notifications?limit=30').then((r) => r.json());
    setData(d);
  }

  useEffect(() => {
    load();
    let timer = null;
    const arm = () => { clearInterval(timer); timer = setInterval(load, pollMs.current); };
    // 初始读取设置 + 监听保存广播（设置页 PUT 后 dispatch pm-settings）
    fetch('/api/settings').then((r) => r.json()).then((list) => {
      const s = list.find((x) => x.key === 'ui.notify_poll_s');
      if (s?.effective) { pollMs.current = s.effective * 1000; arm(); }
    }).catch(() => {});
    const onSettings = (e) => {
      const v = Number(e.detail?.['ui.notify_poll_s']);
      if (v >= 10) { pollMs.current = v * 1000; arm(); }
    };
    window.addEventListener('pm-settings', onSettings);
    arm();
    return () => { clearInterval(timer); window.removeEventListener('pm-settings', onSettings); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function readOne(n) {
    if (!n.read) await fetch(`/api/notifications/${n.id}/read`, { method: 'POST' });
    load();
  }

  async function readAll() {
    await fetch('/api/notifications/read-all', { method: 'POST' });
    load();
  }

  return (
    <div className="bell" ref={boxRef}>
      <button className="bell-btn" onClick={() => { setOpen((o) => !o); if (!open) load(); }} title="通知中心">
        <IconBell size={16} stroke={1.8}/>{data.unread > 0 && <span className="bell-badge">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="bell-head">
            <span>通知中心</span>
            {data.unread > 0 && <button onClick={readAll}>全部已读</button>}
          </div>
          <div className="bell-list">
            {data.items.length === 0 && <div className="bell-empty">暂无通知</div>}
            {data.items.map((n) => (
              <div key={n.id} className={`bell-item ${n.read ? 'read' : ''} k-${n.kind}`} onClick={() => readOne(n)}>
                <div className="bell-item-top">
                  <span className="bell-kind">{KIND_ICON[n.kind] ?? '·'}</span>
                  <span className="bell-title">{n.title}</span>
                  {!n.read && <span className="bell-dot" />}
                </div>
                {n.payload?.url && (
                  <a href={n.payload.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>打开飞书文档</a>
                )}
                <div className="bell-time">{n.created_at}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}