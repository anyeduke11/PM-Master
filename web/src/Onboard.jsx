import React, { useState } from 'react';
import { api } from './api.js';

// F0 冷启动向导（PRD 6.4）：导入式（真实 LLM 结构化）/ 问答式（快速定位）/ 跳过
const LVN = { 1: '辅助人员', 2: '初级', 3: '中级', 4: '高级', 5: '专家级' };
const QUICK = [
  { t: '你目前的角色？', o: [['项目团队成员/项目助理', 1], ['一般项目负责人', 3], ['复杂项目/项目群组负责人', 5]] },
  { t: '项目管理领域工作年限？', o: [['不足1年', 1], ['1-3年', 2], ['3-8年', 4], ['8年以上', 5]] },
  { t: '日常工作重心？', o: [['执行分配的任务并汇报', 1], ['独立管理一般项目目标与团队', 3], ['多项目统筹/治理/战略落地', 5]] },
];

export default function Onboard({ onDone }) {
  const [branch, setBranch] = useState(null);         // import | quick | null
  const [text, setText] = useState('');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [qa, setQa] = useState([0, 0, 0]);
  const [level, setLevel] = useState(null);
  const [track, setTrack] = useState('project');

  async function doImport() {
    setBusy(true); setErr('');
    try {
      const d = await api.post('/api/v2/profile/onboard/import', { text });
      if (d.statusCode) throw new Error(d.message);
      setDraft(d); setLevel(d.suggested_level); setTrack(d.track ?? 'project');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  async function commit() {
    setBusy(true);
    const body = branch === 'quick'
      ? { level, track }
      : { level, track, projects: draft?.projects ?? [], experience_stats: draft?.experience_stats ?? {} };
    const p = await api.post('/api/v2/profile/onboard/commit', body);
    setBusy(false); onDone(p);
  }
  async function skip() {
    const p = await api.post('/api/v2/profile/onboard/skip');
    onDone(p);
  }

  const quickLevel = () => Math.max(1, Math.min(5, Math.floor(Math.min(...qa))));

  return (
    <div style={{ maxWidth: 640, margin: '4vh auto', padding: '0 16px' }}>
      <div className="card ob-card">
        <h2 className="ob-title">冷启动 · 能力定位评估</h2>
        <p style={{ fontSize: 12, color: 'var(--ink3)', margin: '6px 0 18px' }}>
          等级无关系统（GB/T 41831-2022）：定位你当前等级（L1-L5 任意、项目/PMO 双通道），全模块将随档案自适应。
        </p>

        {!branch && !draft && (
          <div style={{ display: 'grid', gap: 10 }}>
            <button className="ob-pick pri" onClick={() => setBranch('import')}>
              粘贴履历（推荐）：AI 结构化为档案初稿，含项目/年限/等级建议
            </button>
            <button className="ob-pick" onClick={() => setBranch('quick')}>
              快速问答：3 个问题，短板原则定位
            </button>
            <button className="ob-pick mini" onClick={skip}>跳过 · 沿用当前档案（{LVN[4]}）</button>
          </div>
        )}

        {branch === 'import' && !draft && (
          <div>
            <textarea style={{ width: '100%', minHeight: 160, fontSize: 13 }} placeholder="粘贴简历/项目经历：项目名称、角色、周期、规模、复杂度、管理年限…（越具体定位越准）"
              value={text} onChange={(e) => setText(e.target.value)} />
            {err && <div className="notice danger">{err}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="pri" disabled={busy || text.trim().length < 30} onClick={doImport}>{busy ? 'AI 结构化中…' : '开始结构化'}</button>
              <button className="mini" onClick={() => setBranch(null)}>返回</button>
            </div>
          </div>
        )}

        {branch === 'quick' && level == null && (
          <div>
            {QUICK.map((q, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <b style={{ fontSize: 13.5 }}>{q.t}</b>
                <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                  {q.o.map(([label, v], j) => (
                    <label key={j} className={`choice ${qa[i] === v ? 'on' : ''}`}>
                      <input type="radio" name={`q${i}`} checked={qa[i] === v} onChange={() => setQa(qa.map((x, k) => (k === i ? v : x)))} />
                      <span style={{ fontSize: 13 }}>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <button className="pri" disabled={qa.some((v) => !v)} onClick={() => setLevel(quickLevel())}>
              {qa.some((v) => !v) ? '请完成 3 问' : '生成定位'}
            </button>
          </div>
        )}

        {(draft || level != null) && (
          <div>
            <div className="ob-hero">
              <small style={{ color: 'var(--ink3)' }}>建议定位（短板原则{draft ? ' · AI 判定' : ' · 问答判定'}）</small>
              <div className="ob-level">L{level} · {LVN[level]}</div>
              {draft?.level_reason && <small style={{ color: 'var(--ink3)' }}>{draft.level_reason}</small>}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0' }}>
              <span style={{ fontSize: 12.5 }}>修正等级：</span>
              {[1, 2, 3, 4, 5].map((lv) => (
                <button key={lv} className={`mini ${level === lv ? 'pri' : ''}`} onClick={() => setLevel(lv)}>L{lv}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '10px 0' }}>
              <span style={{ fontSize: 12.5 }}>通道：</span>
              {['project', 'pmo'].map((t) => (
                <button key={t} className={`mini ${track === t ? 'pri' : ''}`} onClick={() => setTrack(t)}>{t === 'project' ? '项目/项目群组' : 'PMO'}</button>
              ))}
            </div>
            {draft?.projects?.length > 0 && (
              <div style={{ margin: '10px 0' }}>
                <b style={{ fontSize: 12.5 }}>识别到 {draft.projects.length} 个项目（将建档）：</b>
                {draft.projects.map((p, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--ink3)', padding: '3px 0' }}>
                    · {p.name}（{p.complexity} · {p.role} · {p.start || '?'}~{p.end || '至今'}）
                  </div>
                ))}
              </div>
            )}
            {draft?.experience_stats && Object.keys(draft.experience_stats).length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--ink3)', margin: '6px 0' }}>
                经验现值：{Object.entries(draft.experience_stats).map(([k, v]) => `${k}=${v}`).join(' · ')}（写入成长记录）
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="pri" disabled={busy} onClick={commit}>{busy ? '写入中…' : '确认并进入工作台'}</button>
              <button className="mini" onClick={() => { setDraft(null); setLevel(null); }}>重来</button>
            </div>
          </div>
        )}
      </div>
      <small style={{ display: 'block', textAlign: 'center', color: 'var(--ink3)', marginTop: 10 }}>
        定位后仍可随时在档案中调整；一切等级内容读 gbt41831.yaml，代码零硬编码。
      </small>
    </div>
  );
}
