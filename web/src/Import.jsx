import React, { useState } from 'react';
import { IconFileText, IconAlertTriangle } from '@tabler/icons-react';
import { Modal, Field, toast } from './ui.jsx';

// R7.0 P2 数据流入向导：选类型 → 粘贴/拖入文本 → AI 抽取预览（可逐行编辑/勾选）→ 入库
// 后端契约：POST /api/import/preview {kind,text} 瞬态；POST /api/import/commit {kind,rows} 服务端重校验为权威
const KINDS = [
  ['evm', 'EVM 度量', 'PV / EV / AC 三数（进度表复制粘贴）'],
  ['risks', '风险登记', '风险标题 + 概率/影响（0-1）'],
  ['meetings', '会议行动项', '会议主题 + 行动项（负责人/截止）'],
  ['stakeholders', '干系人', '姓名 + 权力/利益（1-10）+ 参与度'],
];

// 各 kind 的可编辑列（key → 表头；number 类型列宽小）
const COLS = {
  evm: [['pv', 'PV', 'n'], ['ev', 'EV', 'n'], ['ac', 'AC', 'n']],
  risks: [['title', '风险标题', 't'], ['probability', '概率', 'n'], ['impact', '影响', 'n']],
  meetings: [['title', '会议主题', 't'], ['held_at', '日期', 't']],
  stakeholders: [['name', '姓名', 't'], ['power', '权力', 'n'], ['interest', '利益', 'n']],
};

export default function Import({ onClose, onDone }) {
  const [kind, setKind] = useState(null);
  const [text, setText] = useState('');
  const [rows, setRows] = useState(null);      // null=未抽取；[] 起为预览态
  const [checked, setChecked] = useState({});  // {i: true}
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState([]);

  async function extract() {
    setBusy(true);
    try {
      const r = await fetch('/api/import/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, text }),
      });
      const out = await r.json();
      if (!r.ok) throw new Error(out.message ?? `HTTP ${r.status}`);
      setRows(out.rows);
      setWarnings(out.warnings ?? []);
      setChecked(Object.fromEntries(out.rows.map((row, i) => [i, !row._err])));   // 合法行默认勾选
    } catch (e) { toast(`抽取失败：${e.message}`, 'err'); }
    setBusy(false);
  }

  async function commit() {
    const picked = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => checked[i] && !r._err).map(({ r }) => r);
    if (!picked.length) return toast('没有勾选可入库的行', 'warn');
    setBusy(true);
    try {
      const res = await fetch('/api/import/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, rows: picked }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.message ?? `HTTP ${res.status}`);
      toast(`入库完成：成功 ${out.inserted} 行${out.skipped ? ` · 跳过 ${out.skipped} 行` : ''}`, out.skipped ? 'warn' : 'ok', 4200);
      onDone?.({ kind, rows: picked, result: out });
      onClose?.();
    } catch (e) { toast(`入库失败：${e.message}`, 'err'); }
    setBusy(false);
  }

  function readFile(f) {
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => setText(String(rd.result ?? '').slice(0, 50000));
    rd.readAsText(f);
  }

  return (
    <Modal title="数据流入 · 粘贴导入" onClose={onClose} width={640}
      footer={rows === null
        ? <><button onClick={onClose}>取消</button><button className="pri" disabled={busy || !kind || text.trim().length < 10} onClick={extract}>{busy ? 'AI 抽取中…' : 'AI 抽取预览'}</button></>
        : <><button onClick={() => setRows(null)}>← 重选</button><button className="pri" disabled={busy} onClick={commit}>{busy ? '入库中…' : `入库 ${Object.entries(checked).filter(([i, v]) => v && !rows[i]?._err).length} 行`}</button></>}>
      {rows === null ? (
        <>
          <Field label="1 · 导入类型（决定校验与入库表）">
            <div className="choice-row">
              {KINDS.map(([k, name, hint]) => (
                <button key={k} type="button" className={`choice ${kind === k ? 'on' : ''}`} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
                  onClick={() => setKind(k)}>
                  <b>{name}</b><small style={{ color: 'var(--ink3)', fontWeight: 400 }}>{hint}</small>
                </button>
              ))}
            </div>
          </Field>
          <Field label="2 · 原始资料（从 Excel/文档复制即可；也可拖入 .txt/.md/.csv 文件）">
            <textarea style={{ width: '100%', minHeight: 130 }} placeholder={'每行一条，如：\n经营分析看板,核心工程师离职,0.6,0.8\n经营分析看板,合同价格未锁定,0.4,0.7'}
              value={text} onChange={(e) => setText(e.target.value)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); readFile(e.dataTransfer?.files?.[0]); }} />
          </Field>
          <small style={{ color: 'var(--ink3)', display: 'flex', alignItems: 'center', gap: 5 }}><IconFileText size={12} stroke={1.8} />AI 仅抽取字段，类型路由/校验/去重全部由服务端代码执行；预览可逐行修改后再入库</small>
        </>
      ) : (
        <>
          {warnings.length > 0 && <div className="notice warn">{warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
          <div style={{ overflowX: 'auto' }}>
            <table className="tb">
              <thead><tr>
                <th style={{ width: 28 }} />
                <th>项目</th>
                {COLS[kind].map(([k, l]) => <th key={k}>{l}</th>)}
                <th>状态</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><input type="checkbox" checked={!!checked[i] && !r._err} disabled={Boolean(r._err)}
                      onChange={(e) => setChecked((c) => ({ ...c, [i]: e.target.checked }))} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.project_name ?? '—'}</td>
                    {COLS[kind].map(([k, , t]) => (
                      <td key={k}>
                        <input type={t === 'n' ? 'number' : 'text'} step={t === 'n' ? 'any' : undefined}
                          style={{ width: t === 'n' ? 72 : 150, padding: '2px 6px', fontSize: 11.5 }}
                          value={r[k] ?? ''} disabled={Boolean(r._err)}
                          onChange={(e) => setRows((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />
                      </td>
                    ))}
                    <td style={{ fontSize: 11 }}>{r._err
                      ? <span style={{ color: 'var(--cin)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><IconAlertTriangle size={11} />{r._err}</span>
                      : r._dup ? <span style={{ color: 'var(--warn)' }}>疑似重复</span>
                      : <span style={{ color: 'var(--ok)' }}>✓ 可入库</span>}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--ink3)', textAlign: 'center', padding: 14 }}>未抽取到任何行，「重选」后调整资料格式再试</td></tr>}
              </tbody>
            </table>
          </div>
          <small style={{ color: 'var(--ink3)' }}>勾选 {Object.values(checked).filter(Boolean).length} / {rows.length} 行；入库时服务端逐行重校验（项目匹配/范围/去重），失败行自动跳过并说明</small>
        </>
      )}
    </Modal>
  );
}
