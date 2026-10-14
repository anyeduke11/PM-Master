import React, { useEffect, useRef, useState } from 'react';
import { IconLock } from '@tabler/icons-react';
import { api } from './api.js';

const PHASE_META = { G: '目标', R: '现状', O: '选项', W: '行动', E: '评定' };

export default function CoachRoom({ autoStart, onConsumed }) {
  const [scenarios, setScenarios] = useState([]);
  const [session, setSession] = useState(null);   // view 对象
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(null);
  const [sessions, setSessions] = useState([]);      // 历史会话（恢复/查看）
  const boxRef = useRef(null);
  const autoRef = useRef(null);

  useEffect(() => { api.get('/api/v2/coach/scenarios').then(setScenarios); loadSessions(); }, []);
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [msgs]);

  async function loadSessions() {
    setSessions(await api.get('/api/v2/coach/sessions'));
  }

  // 恢复会话：服务端状态原样回灌（pi tree 思路的单线版：DB 即真相）
  async function resume(id) {
    setBusy(true);
    const v = await api.get(`/api/v2/coach/sessions/${id}`);
    setSession(v);
    setClosing(v.closed ? { ratings: v.rating ?? [], evidence_id: null } : null);
    setMsgs([
      { role: 'system', content: v.closed ? `已加载归档会话 #${v.id}（只读）` : `已恢复进行中会话 #${v.id} · 当前 ${v.phase} 阶段，可继续作答` },
      ...(v.history ?? []),
    ]);
    setBusy(false);
  }

  // 预警→教练闭环：外部指定场景自动开场（一次性）
  useEffect(() => {
    if (autoStart && autoRef.current !== autoStart) {
      autoRef.current = autoStart;
      start(autoStart);
      onConsumed?.();
    }
  }, [autoStart]);

  function applyView(v, extraSys) {
    setSession(v);
    setMsgs((m) => {
      const next = [...m];
      if (extraSys) next.push({ role: 'system', content: extraSys });
      if (v.last_reply) next.push({ role: 'ai', content: v.last_reply });
      return next;
    });
  }

  async function start(id) {
    setBusy(true); setClosing(null); setMsgs([]);
    const v = await api.post('/api/v2/coach/sessions', { scenario: id, mode: 'fast' });
    applyView(v);
    loadSessions();
    setBusy(false);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !session || session.closed) return;
    if (text.startsWith('/')) {
      const cmd = text.slice(1).split(' ')[0];
      return ctl(cmd);
    }
    setInput(''); setBusy(true);
    setMsgs((m) => [...m, { role: 'user', content: text }]);
    const v = await api.post(`/api/v2/coach/sessions/${session.id}/messages`, { content: text });
    if (v.last_reply) applyView(v); else setSession(v);
    setBusy(false);
  }

  async function ctl(cmd) {
    setInput(''); setBusy(true);
    const v = await api.post(`/api/v2/coach/sessions/${session.id}/control`, { cmd });
    applyView(v, v.note || null);
    setBusy(false);
  }

  async function close() {
    if (!session || session.closed) return;
    setBusy(true);
    const c = await api.post(`/api/v2/coach/sessions/${session.id}/close`, {});
    setClosing(c);
    setSession((s) => ({ ...s, closed: true }));
    setMsgs((m) => [...m, { role: 'system', content: `会话已归档：评分流水 ${c.ratings.length} 条 · 证据 #${c.evidence_id}（可在成长记录查看）` }]);
    setBusy(false);
    loadSessions();
  }

  const phase = session?.phase ?? 'G';
  const stepIdx = session?.step ?? 0;
  const steps = session?.steps ?? [];
  const indicators = scenarios.find((s) => s.id === session?.scenario)?.indicators ?? [];

  return (
    <div className="split" style={{ display: 'grid', gridTemplateColumns: '230px 1fr 270px', gridTemplateRows: 'minmax(0, 1fr)', gap: 14, height: '100%' }}>
      {/* 场景 */}
      <div className="card">
        <h3>PM 教练场景（随等级解锁）</h3>
        {scenarios.map((s) => (
          <div key={s.id} className={`sc ${s.unlocked ? '' : 'locked'}`} onClick={() => s.unlocked && start(s.id)}>
            <b>{s.name}</b>
            <small>{Array.isArray(s.combo) ? s.combo.join('+') : s.combo} · {s.unlocked ? '可训练' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><IconLock size={11} stroke={2}/>{`${s.unlock_level} 解锁`}</span>}</small>
          </div>
        ))}
        {sessions.length > 0 && (
          <>
            <h3 style={{ marginTop: 14 }}>进行中（点击恢复）</h3>
            {sessions.filter((x) => x.open).map((x) => (
              <div key={x.id} className={`sc ${session?.id === x.id && !session?.closed ? 'sel' : ''}`} onClick={() => resume(x.id)} style={{ cursor: 'pointer' }}>
                <b>#{x.id} {x.scenario}</b>
                <small>{x.phase} 阶段 · {x.mode === 'fast' ? '快速' : '标准'} · {x.started_at?.slice(5, 16)}</small>
              </div>
            ))}
            {sessions.filter((x) => x.open).length === 0 && <div className="empty">无（进行中的会话可随时中断，回来继续）</div>}
            <h3 style={{ marginTop: 14 }}>已归档</h3>
            {sessions.filter((x) => !x.open).slice(0, 8).map((x) => (
              <div key={x.id} className={`sc ${session?.id === x.id ? 'sel' : ''}`} onClick={() => resume(x.id)} style={{ cursor: 'pointer' }}>
                <b>#{x.id} {x.scenario}</b>
                <small>{(x.rating ?? []).map((r) => `${r.indicator}:${r.grade}`).join(' ') || '-'} · {x.started_at?.slice(5, 16)}</small>
              </div>
            ))}
          </>
        )}
      </div>

      {/* 对话 */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 14 }}>
        <div className="growbar">
          {['G', 'R', 'O', 'W', 'E'].map((p, i) => {
            const cur = ['G', 'R', 'O', 'W', 'E'].indexOf(phase);
            return (
              <div key={p} className={`gseg ${p === phase ? 'cur' : i < cur ? 'done' : ''}`}>
                <b>{p}</b><span>{PHASE_META[p]}</span>
              </div>
            );
          })}
        </div>
        {session && steps.length > 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--ink3)', margin: '6px 0 2px' }}>
            {session.phase}-{stepIdx + 1}/{steps.length} · {steps[stepIdx]}
          </div>
        )}
        <div id="msgs" ref={boxRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 6 }}>
          {msgs.length === 0 && <div className="m sys">← 选择场景开始 GROW 教练（默认快速模式；/fast /skip /back /status 可用）</div>}
          {msgs.map((m, i) => <div key={i} className={`m ${m.role === 'user' ? 'me' : m.role === 'system' ? 'sys' : 'ai'}`}>{m.content}</div>)}
          {closing && (
            <div className="m ai">
              <b>【E · 会话评定（依据引用）】</b>{'\n'}
              {closing.ratings.map((r, i) => `▸ ${r.indicator}：${r.grade} · ${r.evidence}`).join('\n')}
              {'\n\n'}{closing.evidence_id ? `产物已归档成长记录（#${closing.evidence_id}）· 行为分流水已写入雷达数据源。` : '（归档会话只读回看）'}
            </div>
          )}
        </div>
        <div id="bar">
          <input
            value={input} disabled={!session || session.closed || busy}
            placeholder={session?.closed ? '会话已关闭' : '回答… 或 /skip /back /fast /status'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
          <button onClick={send} disabled={busy || !session || session.closed}>{busy ? '…' : '发送'}</button>
          {session && !session.closed && session.phase === 'E' && <button className="pri" onClick={close}>结束并归档</button>}
        </div>
      </div>

      {/* 数据面板 · 会话遥测 */}
      <div className="card">
        <h3>会话数据 <span className="tel-tag">自动收集</span></h3>
        {!session ? (
          <div className="empty">选择左侧场景开始后，这里实时显示会话状态与自动提炼的要点</div>
        ) : (
          <>
            <div className="tel-grid">
              <div className="tel-cell"><span>场景</span><b>{session.scenario}</b></div>
              <div className="tel-cell"><span>模式</span><b>{session.mode === 'fast' ? '快速' : '标准'}</b></div>
              <div className="tel-cell"><span>阶段</span><b>{PHASE_META[phase]} · {phase}</b></div>
              <div className="tel-cell"><span>步进</span><b>{steps.length ? `${stepIdx + 1}/${steps.length}` : '-'}</b></div>
            </div>
            {steps[stepIdx] && <div className="tel-topic">当前：{steps[stepIdx]}</div>}

            <h3 style={{ marginTop: 14 }}>自动提炼要点</h3>
            {Object.keys(session.collected ?? {}).length ? (
              <div className="tel-kv">
                {Object.entries(session.collected).map(([k, v]) => (
                  <div className="kv" key={k}><b>{k}</b><p>{String(v)}</p></div>
                ))}
              </div>
            ) : (
              <div className="empty">尚未提炼（随对话自动收集目标 / 事实 / 根因）</div>
            )}

            {indicators.length > 0 && (
              <>
                <h3 style={{ marginTop: 14 }}>训练指标</h3>
                <div>{indicators.map((i) => <span key={i} className="pill">{i}</span>)}</div>
              </>
            )}
          </>
        )}

        <h3 style={{ marginTop: 14 }}>流程控制</h3>
        <div className="tel-ctl">
          {[['skip', '/skip'], ['back', '/back'], ['fast', '/fast'], ['status', '/status']].map(([c, l]) => (
            <button key={c} className="mini" disabled={!session || session.closed} onClick={() => ctl(c)}>{l}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
