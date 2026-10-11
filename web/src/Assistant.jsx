import React, { useEffect, useRef, useState } from 'react';
import { IconSparkles, IconRobot, IconChevronRight, IconAlertTriangle, IconBulb, IconDownload } from '@tabler/icons-react';

// R2.1 全局 AI 助手：NL → 意图 → 计划 → 确认 → 执行（服务端 assistant.mjs 执行，AI 不直接摸库）
// R6.6 AI 面整合：侧栏为唯一 AI 面（原「AI 对话」tab 并入）——自由问答 SSE 流式 + 对话日志持久化（载入/清空双确认）
const INTRO = { role: 'sys', content: 'AI 助手 · ⌘K/Ctrl+K 唤起。一句话完成查询与操作，如「给经营分析看板登记风险：核心工程师离职」' };

export default function Assistant({ pageContext, onCoachStart, onNavigate }) {
  const [open, setOpen] = useState(window.matchMedia?.('(min-width: 769px)').matches ?? true);   // 窄屏默认折叠（R6.2 WP1：FAB 唤起全宽抽屉）
  const [msgs, setMsgs] = useState([INTRO]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggest, setSuggest] = useState(null);
  const [clearAsk, setClearAsk] = useState(false);   // R6.6：清空双确认（输入「清空」才可执行）
  const [clearText, setClearText] = useState('');
  const inputRef = useRef(null);
  const boxRef = useRef(null);
  const focusPending = useRef(false);
  const suggestOff = useRef(false);   // 会话内不再拉取建议（mount 读档案 / 用户关闭后）
  const [quickPrompts, setQuickPrompts] = useState([]);   // R7.0 P3 I1：启用的快捷提示词（点击填入输入区）

  useEffect(() => {
    const load = () => fetch('/api/prompts?enabled=1').then((r) => r.ok ? r.json() : []).then((ps) => setQuickPrompts(Array.isArray(ps) ? ps : [])).catch(() => {});
    load();
    window.addEventListener('pm-prompts', load);   // 设置页保存后即时刷新
    return () => window.removeEventListener('pm-prompts', load);
  }, []);

  // body 右侧留白容纳 fixed 侧栏（规则见 index.html：.assistant-live / .assistant-collapsed）
  useEffect(() => {
    document.body.classList.add('assistant-live');
    return () => document.body.classList.remove('assistant-live', 'assistant-collapsed');
  }, []);
  useEffect(() => { document.body.classList.toggle('assistant-collapsed', !open); }, [open]);

  // 全局快捷键 ⌘K / Ctrl+K：展开并聚焦输入框
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusPending.current = true;
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open && focusPending.current) { focusPending.current = false; inputRef.current?.focus(); }
  }, [open]);

  // R6.6 mount：载入对话日志（跨刷新持久化；失败不阻塞会话）
  // R6.6b：计划卡以冻结态回放（令牌不落库——pending 降级为「未确认」，done/canceled 终态原样展示）
  useEffect(() => {
    (async () => {
      try {
        const hist = await fetch('/api/assistant/messages').then((r) => r.json());
        if (Array.isArray(hist) && hist.length) {
          setMsgs([INTRO, ...hist.map((h) => {
            if (h.kind === 'plan') {
              try {
                const d = JSON.parse(h.content);
                return { role: 'plan', plan: d.plan, state: d.state, msgId: h.id, frozen: true };
              } catch { return null; }   // 损坏行跳过（版本演进容错）
            }
            return { role: h.role, content: h.content, ok: h.kind === 'result' };
          }).filter(Boolean)]);
        }
      } catch { /* 历史载入失败不阻塞 */ }
    })();
  }, []);

  // mount：读偏好（suggest_off 则不显示），否则拉一次主动建议
  useEffect(() => {
    (async () => {
      try {
        const p = await fetch('/api/profile').then((r) => r.json());
        if (p?.assistant_prefs?.suggest_off) { suggestOff.current = true; return; }
      } catch { /* 档案读取失败不阻塞建议 */ }
      loadSuggest();
    })();
  }, []);

  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [msgs, open]);

  function push(m) { setMsgs((ms) => [...ms, m]); }
  function updPlan(m, patch) { setMsgs((ms) => ms.map((x) => (x === m ? { ...x, ...patch } : x))); }

  // R6.6 落库已完成消息（me/ai 文本与结果、计划卡；错误条为会话内状态，不落库）；返回落库行（计划卡追踪 id 用）
  async function logMsg(m) {
    try {
      const r = await fetch('/api/assistant/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
      }).then((x) => x.json());
      return r?.id ? r : null;
    } catch { return null; }
  }

  // 统一成功消息：payload.url 新开窗口；payload.markdown 生成 Blob 下载链接
  function resultMsg(content, payload) {
    const files = [];
    if (payload?.markdown) {
      files.push({
        url: URL.createObjectURL(new Blob([payload.markdown], { type: 'text/markdown;charset=utf-8' })),
        name: payload.filename ?? `assistant-${new Date().toISOString().slice(0, 10)}.md`,
      });
    }
    if (payload?.url) window.open(payload.url, '_blank');
    return { role: 'ai', content: content ?? '已执行', ok: true, files };
  }

  async function loadSuggest() {
    if (suggestOff.current) return;
    try {
      const d = await fetch('/api/assistant/suggest').then((r) => r.json());
      setSuggest(d?.suggestion ?? null);
    } catch { /* 静默 */ }
  }

  async function dismissSuggest() {
    setSuggest(null);
    suggestOff.current = true;   // 本次会话不再拉取
    try {
      const p = await fetch('/api/profile').then((r) => r.json());
      await fetch('/api/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant_prefs: { ...(p?.assistant_prefs ?? {}), suggest_off: true } }),
      });
    } catch { /* 偏好持久化失败不影响本次会话 */ }
  }

  function goSuggest(action) {
    setSuggest(null);
    if (action === 'coach:exception') onCoachStart?.('exception');
    else if (action === 'drill' || action === 'growth') onNavigate?.(action);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput(''); setBusy(true);
    const history = msgs
      .filter((m) => (m.role === 'me' || m.role === 'ai') && m.content)
      .map((m) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.content }));
    push({ role: 'me', content: text });
    await logMsg({ role: 'me', kind: 'text', content: text });
    try {
      const d = await fetch('/api/assistant/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, pageContext }),
      }).then((r) => r.json());
      await handleParse(d, [...history, { role: 'user', content: text }]);
    } catch (e) {
      push({ role: 'err', content: `助手服务暂不可用（${e.message}），请稍后再试` });
    }
    setBusy(false);
  }

  async function handleParse(d, chatMessages) {
    if (!d?.kind) return push({ role: 'err', content: '服务端响应异常，请稍后再试' });
    if (d.kind === 'result') { const m = resultMsg(d.result, d.payload); push(m); logMsg({ role: 'ai', kind: 'result', content: m.content }); return; }   // 查询：免确认直接回显
    if (d.kind === 'chat') return streamReply(d.reply ?? '', chatMessages);                                                                             // R6.6：自由问答流式
    if (d.kind === 'clarify') { push({ role: 'ai', content: d.reply }); logMsg({ role: 'ai', kind: 'text', content: d.reply }); return; }
    if (d.kind === 'action') { push({ role: 'ai', content: d.reply, action: { scenario: d.params?.scenario } }); logMsg({ role: 'ai', kind: 'text', content: d.reply }); return; }
    if (d.kind === 'plan') {
      const m = { role: 'plan', plan: d.plan, confirm_token: d.confirm_token, expires_in: d.expires_in, state: 'pending', msgId: null };
      push(m);
      // R6.6b：计划卡创建即落库（令牌不落库）；终态回写同一行——刷新后冻结回放
      const row = await logMsg({ role: 'ai', kind: 'plan', content: JSON.stringify({ plan: d.plan, state: 'pending' }) });
      if (row) updPlan(m, { msgId: row.id });
      return;
    }
    push({ role: 'err', content: `未知响应类型：${d.kind}` });
  }

  // R6.6 自由问答：SSE 逐字回显（原「AI 对话」tab 通道迁入）；失败降级整段显示 parse 的 reply
  async function streamReply(fallbackReply, chatMessages) {
    push({ role: 'ai', content: '' });
    let full = '';
    let failed = false;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n'); buf = frames.pop();
        for (const f of frames) {
          const ev = /^event: (.+)$/m.exec(f)?.[1];
          const data = JSON.parse(/^data: (.+)$/m.exec(f)?.[1] ?? '{}');
          if (ev === 'delta') {
            full += data.delta;
            setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'ai', content: full }; return c; });
          }
        }
      }
    } catch { failed = true; }
    const text = (failed && fallbackReply) ? fallbackReply : (full || fallbackReply || '');
    if (!text) { setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'ai', content: '（无回复）' }; return c; }); return; }
    setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'ai', content: text }; return c; });
    await logMsg({ role: 'ai', kind: 'text', content: text });
  }

  // R6.6b：计划卡终态回写（先本地冻结，再尽力回写落库行；回写失败仅刷新后停留未确认态，不影响本次会话）
  async function setPlanState(m, state) {
    updPlan(m, { state });
    if (m.msgId) {
      try {
        await fetch(`/api/assistant/messages/${m.msgId}/plan-state`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state }),
        });
      } catch { /* 静默 */ }
    }
  }

  async function execPlan(m, typedName) {
    setBusy(true);
    try {
      const r = await fetch('/api/assistant/exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(typedName ? { confirm_token: m.confirm_token, typed_name: typedName } : { confirm_token: m.confirm_token }),
      }).then((r) => r.json());
      if (r?.ok) {
        await setPlanState(m, 'done');
        const rm = resultMsg(r.result, r.payload);
        push(rm);
        logMsg({ role: 'ai', kind: 'result', content: rm.content });
        loadSuggest();   // 执行成功后刷新主动建议
      } else {
        push({ role: 'err', content: r?.message ?? '执行失败' });
      }
    } catch (e) {
      push({ role: 'err', content: `执行请求失败（${e.message}）` });
    }
    setBusy(false);
  }

  // R6.6 清空对话（双确认：输入「清空」；服务端再校验 confirm=clear）
  async function doClear() {
    if (clearText.trim() !== '清空' || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/assistant/messages?confirm=clear', { method: 'DELETE' }).then((x) => x.json());
      if (r?.cleared != null) {
        setMsgs([INTRO, { role: 'sys', content: `对话记录已清空（${r.cleared} 条）` }]);
        setClearAsk(false); setClearText('');
      }
    } catch (e) { push({ role: 'err', content: `清空失败（${e.message}）` }); }
    setBusy(false);
  }

  return (
    <>
      {open ? (
        <aside className="asst">
          <div className="asst-head">
            <b><IconSparkles size={14} stroke={1.8}/> AI 助手</b>
            <button className="asst-clearbtn" title="清空对话" onClick={() => setClearAsk((v) => !v)}>清空</button>
            <span className="asst-kbd">⌘K</span>
            <button title="折叠" onClick={() => setOpen(false)}><IconChevronRight size={14}/></button>
          </div>
          <div className="asst-msgs" ref={boxRef}>
            {msgs.map((m, i) => {
              if (m.role === 'plan') {
                return (
                  <div key={i} className={`asst-plan ${m.plan?.danger ? 'danger' : ''}`}>
                    <b>将执行：{m.plan.title}</b>
                    {m.plan.danger && <div className="warn" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconAlertTriangle size={12}/> 危险操作 · 需输入目标名称二次确认</div>}
                    <ol>{(m.plan.steps ?? []).map((s, j) => <li key={j}>{s}</li>)}</ol>
                    {!m.frozen && m.state === 'pending' && (
                      <div className="asst-btns">
                        <button className="pri" disabled={busy}
                          onClick={() => (m.plan.danger ? updPlan(m, { state: 'typing' }) : execPlan(m))}>确认执行</button>
                        <button disabled={busy} onClick={() => setPlanState(m, 'canceled')}>取消</button>
                      </div>
                    )}
                    {!m.frozen && m.state === 'typing' && (
                      <div className="asst-type">
                        <small>输入 <code>{m.plan.target_name}</code> 以确认：</small>
                        <input autoFocus value={m.typed ?? ''} placeholder={m.plan.target_name}
                          onChange={(e) => updPlan(m, { typed: e.target.value })} />
                        <div className="asst-btns">
                          <button className="pri" disabled={busy || !(m.typed ?? '').trim()}
                            onClick={() => execPlan(m, (m.typed ?? '').trim())}>执行</button>
                          <button disabled={busy} onClick={() => setPlanState(m, 'canceled')}>取消</button>
                        </div>
                      </div>
                    )}
                    {m.state === 'canceled' && <div className="asst-note">已取消</div>}
                    {m.state === 'done' && <div className="asst-note ok">已执行 ✓</div>}
                    {m.frozen && m.state === 'pending' && <div className="asst-note">未确认 · 刷新后令牌失效（可重新发起）</div>}
                  </div>
                );
              }
              return (
                <div key={i} className={`asst-m ${m.role}${m.ok ? ' ok' : ''}`}>
                  {m.role === 'err'
                    ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconAlertTriangle size={13}/> {m.content}</span>
                    : m.content}
                  {m.action && (
                    <div className="asst-btns asst-cta">
                      <button className="pri" onClick={() => onCoachStart?.(m.action.scenario)}>进入教练室</button>
                    </div>
                  )}
                  {(m.files ?? []).map((f) => (
                    <a key={f.name} href={f.url} download={f.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconDownload size={12}/> 下载 {f.name}</a>
                  ))}
                </div>
              );
            })}
          </div>
          {suggest && (
            <div className="asst-suggest">
              <small style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><IconBulb size={13}/> {suggest.text}</small>
              <button className="mini pri" onClick={() => goSuggest(suggest.action)}>去处理</button>
              <button className="x" title="关闭建议（不再提示）" onClick={dismissSuggest}>×</button>
            </div>
          )}
          {clearAsk && (
            <div className="asst-type asst-clearbox">
              <small>清空全部对话记录（不可恢复）。输入 <code>清空</code> 以确认：</small>
              <input autoFocus value={clearText} placeholder="清空"
                onChange={(e) => setClearText(e.target.value)} />
              <div className="asst-btns">
                <button className="pri" disabled={busy || clearText.trim() !== '清空'} onClick={doClear}>确认清空</button>
                <button disabled={busy} onClick={() => { setClearAsk(false); setClearText(''); }}>取消</button>
              </div>
            </div>
          )}
          {/* R7.0 P3 I1：快捷提示词（设置·提示词库启用项；点击填入可再编辑） */}
          {quickPrompts.length > 0 && (
            <div className="qbtns">
              {quickPrompts.map((p) => (
                <button key={p.id} title={p.content} onClick={() => { setInput(p.content); inputRef.current?.focus(); }}>{p.title}</button>
              ))}
            </div>
          )}
          <div className="asst-bar">
            <input ref={inputRef} value={input} placeholder="自然语言指令或提问…" disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()} />
            <button onClick={send} disabled={busy}>{busy ? '…' : '发送'}</button>
          </div>
        </aside>
      ) : (
        <button className="asst-fab" title="展开 AI 助手（⌘K）" onClick={() => setOpen(true)}><IconRobot size={20} stroke={1.7}/></button>
      )}
    </>
  );
}