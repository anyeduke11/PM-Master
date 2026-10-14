import React, { useEffect, useState } from 'react';
import { IconMicrophone } from '@tabler/icons-react';
import { api } from './api.js';

// P3 强化营：SM-2 复习队列（主动回忆）+ 情景题（深度随档案等级，快模型）
// R4.3 WP7：到期聚合视图（今日含逾期 / 未来 7 天分布）+ 队列全量展示带到期日
export default function Drill() {
  const [queue, setQueue] = useState([]);
  const [cur, setCur] = useState(null);
  const [showBack, setShowBack] = useState(false);
  const [stats, setStats] = useState([]);
  const [quiz, setQuiz] = useState(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [due, setDue] = useState(null);
  const [feyn, setFeyn] = useState({ open: false, text: '', res: null, busy: false });   // R5.1 WP1 卡片费曼

  useEffect(() => { load(); }, []);
  async function load() {
    setQueue(await api.get('/api/v2/drill/queue'));
    setStats(await api.get('/api/v2/drill/stats'));
    setDue(await api.get('/api/v2/drill/due-summary'));
    setCur(null); setShowBack(false);
    setFeyn({ open: false, text: '', res: null, busy: false });
  }

  async function grade(g) {
    await api.post(`/api/v2/drill/cards/${cur.id}/review`, { grade: g });
    load();
  }

  // R5.1 WP1 卡片费曼：讲给 AI 听 → 合格沉淀知识贡献证据（M3 实证通道）
  async function submitFeyn() {
    if (!cur || !feyn.text.trim() || feyn.busy) return;
    setFeyn((s) => ({ ...s, busy: true }));
    const r = await api.post(`/api/v2/drill/cards/${cur.id}/feynman`, { explanation: feyn.text })
      .catch((e) => ({ error: String(e) }));
    setFeyn((s) => ({ ...s, res: r, busy: false }));
  }
  async function newQuiz() {
    setBusy(true); setResult(null); setAnswer('');
    const domains = ['risk', 'benefits', 'stakeholder', 'plan_control', 'reporting'];
    const d = domains[Math.floor(Math.random() * domains.length)];
    setQuiz(await api.post(`/api/v2/drill/scenario/${d}`));
    setBusy(false);
  }
  async function submit() {
    if (!answer.trim() || !quiz) return;
    setBusy(true);
    const r = await api.post(`/api/v2/drill/scenario/${quiz.id}/answer`, { answer });
    setResult(r); setBusy(false);
  }

  const done = stats.reduce((a, s) => a + s.mastered, 0);
  const total = stats.reduce((a, s) => a + s.total, 0);

  return (
    <div className="split" style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 14, height: '100%', overflow: 'hidden' }}>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        <h3>今日复习队列（SM-2 间隔重复 · 主动回忆：先答后看）</h3>
        {due && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, fontSize: 12 }}>
            <span className={due.due_today ? 'badge' : 'badge cnt-ok'}>
              今日应复习 {due.due_today}{due.overdue > 0 ? `（含逾期 ${due.overdue}）` : ''}
            </span>
            <span style={{ color: 'var(--ink3)' }}>
              未来 7 天 {due.upcoming_total} 张{due.upcoming_total > 0 && `：${due.upcoming.map((u) => `${u.date.slice(5)} ${u.count}`).join(' · ')}`}
            </span>
          </div>
        )}
        {queue.length === 0 && <div className="empty">今日复习队列已清空</div>}
        {queue.length > 0 && !cur && (
          <div>
            <small style={{ color: 'var(--ink3)' }}>待复习 {queue.length} 张（按到期先后排序{due?.overdue > 0 ? '，逾期在前' : ''}）</small>
            {queue.map((c) => {
              const overdue = due && c.next_review < due.today;
              return (
                <div key={c.id} className="rowitem" style={{ cursor: 'pointer' }} onClick={() => { setCur(c); setShowBack(false); setFeyn({ open: false, text: '', res: null, busy: false }); }}>
                  <b style={{ flex: 1 }}>{c.front.slice(0, 40)}</b>
                  <span className="pill">{c.domain}</span>
                  <small style={overdue ? { color: 'var(--warn)' } : null}>
                    {c.reps > 0 ? `已练 ${c.reps} 次 · ` : '新卡 · '}{overdue ? `逾期（${c.next_review.slice(5)}）` : `今日到期`}
                  </small>
                </div>
              );
            })}
          </div>
        )}
        {cur && (
          <div>
            <div className="rowitem" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <b>{cur.front}</b>
              {showBack ? (
                <div style={{ marginTop: 8, padding: 10, background: 'var(--paper)', borderRadius: 'var(--r-md)', fontSize: 12.5, lineHeight: 1.7 }}>
                  {cur.back}
                  <div style={{ marginTop: 6, color: 'var(--navy)', fontSize: 11.5 }}>来源：{cur.sources}</div>
                </div>
              ) : (
                <button className="mini pri" style={{ marginTop: 8 }} onClick={() => setShowBack(true)}>先心里作答，再看答案</button>
              )}
            </div>
            {showBack && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--ink3)', alignSelf: 'center' }}>回忆质量：</span>
                <button className="mini danger" onClick={() => grade('weak')}>想不起来（今日再见）</button>
                <button className="mini" onClick={() => grade('ok')}>模糊（×1.3 间隔）</button>
                <button className="mini pri" onClick={() => grade('good')}>清晰（×ease 间隔）</button>
              </div>
            )}
            {showBack && (
              <div style={{ marginTop: 10, borderTop: '1px dashed var(--hair)', paddingTop: 10 }}>
                {!feyn.open && !feyn.res && (
                  <button className="mini" onClick={() => setFeyn({ open: true, text: '', res: null, busy: false })}>
                    <IconMicrophone size={13} stroke={1.8} style={{ verticalAlign: '-2px' }} /> 讲给 AI 听（费曼挑战 · 合格沉淀 M3 实证）
                  </button>
                )}
                {feyn.open && !feyn.res && (
                  <div>
                    <textarea style={{ width: '100%', minHeight: 80 }} placeholder="向零基础新 PM 完整讲清：是什么 + 何时用 + 一个例子（至少 20 字）…"
                      value={feyn.text} onChange={(e) => setFeyn((s) => ({ ...s, text: e.target.value }))} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <button className="mini pri" disabled={feyn.busy} onClick={submitFeyn}>{feyn.busy ? '评定中…' : '提交挑战'}</button>
                      <button className="mini" onClick={() => setFeyn({ open: false, text: '', res: null, busy: false })}>收起</button>
                    </div>
                  </div>
                )}
                {feyn.res && (feyn.res.error
                  ? <div className="notice danger">{feyn.res.error}</div>
                  : (
                    <div style={{ padding: 10, borderRadius: 'var(--r-md)', background: feyn.res.qualified ? 'var(--ok-soft)' : 'var(--danger-soft)' }}>
                      <b>{feyn.res.qualified ? `✓ 达成 M3 能教授${feyn.res.evidence_id ? ` · 证据 #${feyn.res.evidence_id} 已归档成长记录` : ''}` : '× 尚未达到能教授标准'}</b>
                      <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.7 }}>{feyn.res.comment}</div>
                      <div style={{ marginTop: 8 }}><button className="mini" onClick={() => setFeyn({ open: false, text: '', res: null, busy: false })}>关闭</button></div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        <h3 style={{ marginTop: 18 }}>情景应用题（认知深度随目标级 · 快模型）</h3>
        {!quiz && <button className="pri" disabled={busy} onClick={newQuiz}>{busy ? '出题中…' : '来一道'}</button>}
        {quiz && (
          <div className="rowitem" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <small className="pill">{quiz.depth === 'integrate' ? '整合评价' : quiz.depth === 'apply' ? '应用分析' : '知道领会'}</small>
            <b style={{ marginTop: 6, lineHeight: 1.7 }}>{quiz.question}</b>
            {!result && (
              <div style={{ marginTop: 10 }}>
                <textarea style={{ width: '100%', minHeight: 70 }} placeholder="你的作答（主观题，AI 判分）…"
                  value={answer} onChange={(e) => setAnswer(e.target.value)} />
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <button className="pri" disabled={busy} onClick={submit}>{busy ? '判分中…' : '提交判分'}</button>
                  <button className="mini" onClick={() => { setQuiz(null); setResult(null); }}>换一道</button>
                </div>
              </div>
            )}
            {result && (
              <div style={{ marginTop: 10, padding: 10, borderRadius: 'var(--r-md)', background: result.grade === 'good' ? 'var(--ok-soft)' : result.grade === 'ok' ? 'var(--warn-soft)' : 'var(--danger-soft)' }}>
                <b>评定：{result.grade === 'good' ? '优秀' : result.grade === 'ok' ? '合格' : '待提升'}</b>
                <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.7 }}>{result.feedback}</div>
                <div style={{ marginTop: 8 }}><button className="mini" onClick={() => { setQuiz(null); setResult(null); }}>再来一道</button></div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        <h3>17 领域掌握度 <small style={{ color: 'var(--navy)' }}>{done}/{total} 已掌握</small></h3>
        {stats.map((s) => (
          <div key={s.domain} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span>{s.domain}</span><span style={{ color: s.mastered ? 'var(--ok)' : 'var(--ink3)' }}>{s.mastered}/{s.total}</span>
            </div>
            <div className={`bar ${s.mastered ? 'ok' : ''}`}>
              <i style={{ width: `${(s.mastered / s.total) * 100}%` }} />
            </div>
          </div>
        ))}
        <small style={{ color: 'var(--ink3)' }}>reps≥2 记掌握；M2「会应用」以上计入知识维度覆盖（F3 输入）</small>
      </div>
    </div>
  );
}
