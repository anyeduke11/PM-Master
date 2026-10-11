import React, { useState } from 'react';
import { IconMessageCircle } from '@tabler/icons-react';

// R6.1 C1 使用反馈轻入口：rating 1-5 + tag + 正文；两处挂载（AI 对话页 / 成长记录页），source 由挂载点传入
const TAGS = ['bug', '体验', '建议', '其他'];

export default function Feedback({ source }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ rating: null, tag: '建议', content: '' });
  const [done, setDone] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);   // R6.3 bug 修复：防连点重复提交

  async function submit() {
    if (!form.content.trim() || busy) return;
    setErr(''); setBusy(true);
    const r = await fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, ...form }),
    }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setDone(r); setForm({ rating: null, tag: '建议', content: '' });
  }

  return (
    <div style={{ borderTop: '1px dashed var(--hair)', marginTop: 12, paddingTop: 10 }}>
      {!open && !done && (
        <button className="mini" onClick={() => setOpen(true)}><IconMessageCircle size={13}/> 提个反馈（卡点/建议，R6.3 评审用）</button>
      )}
      {open && !done && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: 'var(--ink3)' }}>评分</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={`mini ${form.rating === n ? 'pri' : ''}`} style={{ padding: '2px 8px' }}
                onClick={() => setForm((f) => ({ ...f, rating: n }))}>{n}</button>
            ))}
            <select value={form.tag} onChange={(e) => setForm((f) => ({ ...f, tag: e.target.value }))} style={{ marginLeft: 6 }}>
              {TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <textarea style={{ width: '100%', minHeight: 56 }} placeholder="哪里卡了/哪里好用/想要什么（≤2000 字）…"
            value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))} />
          {err && <small style={{ color: 'var(--cin)' }}>{err}</small>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="mini pri" disabled={!form.content.trim() || busy} onClick={submit}>{busy ? '提交中…' : '提交'}</button>
            <button className="mini" onClick={() => { setOpen(false); setErr(''); }}>收起</button>
          </div>
        </div>
      )}
      {done && (
        <small style={{ color: 'var(--ok)' }}>✓ 已记录（#{done.id}），R6.3 使用期评审时统一处理。</small>
      )}
    </div>
  );
}
