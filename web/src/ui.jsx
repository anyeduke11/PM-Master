import React, { useEffect, useRef, useState } from 'react';

// R6.8 共享 UI 基元：Toast 轻提示（替代 alert）+ Modal 模态框（替代 prompt/confirm）
// 事件总线约定：toast() 通过 window CustomEvent('pm-toast') 广播，App.jsx 挂载唯一 <ToastHost />

/* ---------- Toast ---------- */
export function toast(text, kind = 'info', ms = 3200) {
  window.dispatchEvent(new CustomEvent('pm-toast', { detail: { text, kind, id: `${Date.now()}-${Math.random()}`, ms } }));
}

export function ToastHost() {
  const [items, setItems] = useState([]);
  const timers = useRef({});

  useEffect(() => {
    const on = (e) => {
      const { id, text, kind, ms } = e.detail;
      setItems((xs) => [...xs.slice(-3), { id, text, kind }]);
      timers.current[id] = setTimeout(() => {
        setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x)));
        timers.current[`${id}-rm`] = setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 260);
      }, ms || 3200);
    };
    window.addEventListener('pm-toast', on);
    return () => {
      window.removeEventListener('pm-toast', on);
      Object.values(timers.current).forEach(clearTimeout);
    };
  }, []);

  if (!items.length) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast t-${t.kind}${t.out ? ' out' : ''}`}>{t.text}</div>
      ))}
    </div>
  );
}

/* ---------- Modal ---------- */
export function Modal({ title, children, onClose, footer, width }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px,100%)` } : undefined}>
        <div className="modal-head">
          <b>{title}</b>
          <button onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- 表单字段（label 在上、输入在下） ---------- */
export function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}
