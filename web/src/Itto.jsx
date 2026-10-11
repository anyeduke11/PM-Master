import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IconSchool } from '@tabler/icons-react';

// R2.2 ITTO 知识库：三源（PMBOK/PRINCE2/GB-T 41831）过程-输入-工具-输出对照 + 工具实操练习（AI 判分）
const SRC_LABEL = { pmbok: 'PMBOK', prince2: 'PRINCE2', gbt41831: 'GB/T 41831' };
const DEPTH = { know: '识别', apply: '应用', integrate: '整合' };
const VD = { good: '优秀', ok: '合格', weak: '待提升' };

// sources 含 prince2 / gbt41831 时的小标记
function SrcMarks({ sources }) {
  const s = sources || '';
  return (
    <>
      {s.includes('prince2') && <i className="itto-src pr2">PR2</i>}
      {s.includes('gbt41831') && <i className="itto-src gb">国</i>}
    </>
  );
}

export default function Itto() {
  const [ov, setOv] = useState(null);
  const [procs, setProcs] = useState([]);
  const [openKa, setOpenKa] = useState(null);        // 展开的知识域
  const [selId, setSelId] = useState(null);          // 选中的过程 id
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const [q, setQ] = useState('');
  const [tools, setTools] = useState(null);          // null=未搜索，[]=无结果
  const [toolBusy, setToolBusy] = useState(false);

  const [prac, setPrac] = useState(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState(null);
  const [genBusy, setGenBusy] = useState(false);
  const [subBusy, setSubBusy] = useState(false);
  const [hist, setHist] = useState([]);
  const [err, setErr] = useState('');
  const debounce = useRef(null);
  // R3.4 掌握度矩阵（工具 + 卡片共用 M0-M3 口径）
  const [mx, setMx] = useState(null);
  const [mxM, setMxM] = useState(3);
  const [mxBusy, setMxBusy] = useState(false);
  // R2.4 四步教学会话
  const [tutor, setTutor] = useState(null);        // {token, step, tool, explain?, demonstrate?, question?, context?, grade?, mastery?, apply_hints?}
  const [tutorBusy, setTutorBusy] = useState(false);
  const [tutorAnswer, setTutorAnswer] = useState('');
  const [feynText, setFeynText] = useState('');
  const [feynRes, setFeynRes] = useState(null);

  async function j(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  const fail = (e) => setErr(e.message || String(e));
  const loadHist = () => j('/api/itto/practice/history?limit=10').then(setHist).catch(() => {});
  const loadMx = () => j('/api/itto/mastery-matrix').then(setMx).catch(() => {});

  // M3 能教授 → 一键沉淀为知识贡献证据（幂等，服务端已沉淀则回原证据）
  async function promote(toolId) {
    if (mxBusy) return;
    setMxBusy(true);
    try { await j('/api/itto/mastery/evidence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool_id: toolId }),
    }); await loadMx(); } catch (e) { fail(e); }
    setMxBusy(false);
  }

  // ---------- 四步教学（讲→示→练→用 + 费曼 M3） ----------
  async function startTutor(toolId) {
    if (tutorBusy) return;
    setTutorBusy(true); setTutor(null); setTutorAnswer(''); setFeynRes(null); setFeynText('');
    try {
      const r = await j('/api/itto/tutor/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool_id: toolId }),
      });
      setTutor(r); setErr('');
    } catch (e) { fail(e); }
    setTutorBusy(false);
  }
  async function tutorNext(answer) {
    if (!tutor || tutorBusy) return;
    setTutorBusy(true);
    try {
      const r = await j('/api/itto/tutor/advance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tutor.token, answer: answer ?? '' }),
      });
      setTutor({ ...tutor, ...r }); setTutorAnswer('');
    } catch (e) { fail(e); }
    setTutorBusy(false);
  }
  async function submitFeynman() {
    if (!tutor || !feynText.trim() || tutorBusy) return;
    setTutorBusy(true);
    try {
      setFeynRes(await j('/api/itto/tutor/feynman', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tutor.token, explanation: feynText }),
      }));
      loadMx();   // 费曼合格可能把该工具升到 M3
    } catch (e) { fail(e); }
    setTutorBusy(false);
  }

  useEffect(() => {
    j('/api/itto/overview').then(setOv).catch(fail);
    j('/api/itto/processes').then((ps) => { setProcs(ps); if (ps.length) setOpenKa(ps[0].ka); }).catch(fail);
    loadHist();
    loadMx();
  }, []);

  // 工具搜索：400ms 防抖
  useEffect(() => {
    const kw = q.trim();
    const t = setTimeout(async () => {
      if (!kw) { setTools(null); setToolBusy(false); return; }
      setToolBusy(true);
      try { setTools(await j(`/api/itto/tools?q=${encodeURIComponent(kw)}`)); }
      catch (e) { fail(e); setTools([]); }
      setToolBusy(false);
    }, 400);
    return () => clearTimeout(t);
  }, [q]);

  // 优先用 overview.by_ka 的顺序，API 未就绪时退化为从过程列表分组
  const kaList = useMemo(() => {
    if (ov?.by_ka?.length) return ov.by_ka;
    const m = {}; const list = [];
    for (const p of procs) {
      if (!m[p.ka]) { m[p.ka] = { ka: p.ka, count: 0 }; list.push(m[p.ka]); }
      m[p.ka].count++;
    }
    return list;
  }, [ov, procs]);

  async function loadDetail(id) {
    setSelId(id); setDetailBusy(true);
    try { setDetail(await j(`/api/itto/processes/${id}`)); } catch (e) { fail(e); setDetail(null); }
    setDetailBusy(false);
  }

  function jumpToProc(code) {
    const p = procs.find((x) => x.code === code);
    if (p) { setOpenKa(p.ka); loadDetail(p.id); }
  }

  async function gen() {
    if (!selId || genBusy) return;
    setGenBusy(true); setPrac(null); setResult(null); setAnswer('');
    try {
      setPrac(await j('/api/itto/practice/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ process_id: selId }),
      }));
    } catch (e) { fail(e); }
    setGenBusy(false);
  }

  async function submit() {
    if (!prac || !answer.trim() || subBusy) return;
    setSubBusy(true);
    try {
      setResult(await j('/api/itto/practice/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: prac.token, answer }),
      }));
      loadHist();
    } catch (e) { fail(e); }
    setSubBusy(false);
  }

  return (
    <div className="itto">
      {/* 顶部概览条 */}
      <div className="card itto-ov">
        {ov ? (
          <>
            <b>{ov.process_count} 过程</b><span className="dot">·</span>
            <b>{ov.techniques?.distinct ?? ov.tool_count} 工具技术</b><span className="dot">·</span>
            <b>{ov.tool_count} ITTO 条目</b><span className="dot">·</span>
            {Object.entries(ov.sources || {}).map(([k, n]) => (
              <span key={k} className="pill">{SRC_LABEL[k] || k} × {n}</span>
            ))}
          </>
        ) : <small style={{ color: 'var(--ink3)' }}>概览加载中…</small>}
        {err && (
          <span className="itto-err">{err}<button onClick={() => setErr('')}>×</button></span>
        )}
      </div>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '290px 1fr', gap: 14, minHeight: 0, overflow: 'hidden' }}>
        {/* 左栏：10 知识域手风琴 */}
        <div className="card" style={{ overflow: 'auto' }}>
          {kaList.length === 0 && <small style={{ color: 'var(--ink3)' }}>暂无过程数据（等待知识库装载）</small>}
          {kaList.map((k) => (
            <div key={k.ka} className={`itto-ka ${openKa === k.ka ? 'on' : ''}`}>
              <div className="itto-ka-head" onClick={() => setOpenKa(openKa === k.ka ? null : k.ka)}>
                <span>{openKa === k.ka ? '▾' : '▸'}</span><b>{k.ka}</b>
                <span className="cnt">{k.count} 过程</span>
              </div>
              {openKa === k.ka && (
                <div className="itto-ka-list">
                  {procs.filter((p) => p.ka === k.ka).map((p) => (
                    <div key={p.id} className={`itto-p ${selId === p.id ? 'on' : ''}`} onClick={() => loadDetail(p.id)}>
                      <code>{p.code}</code><span>{p.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 右栏：教学 / 详情 / 工具检索 / 实操练习 */}
        <div style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          {tutor && (
            <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
              <h3>
                <IconSchool size={14} stroke={1.8} style={{ verticalAlign: '-2px' }} /> 四步教学 · {tutor.tool?.name}
                <span style={{ float: 'right', display: 'flex', gap: 4 }}>
                  {['explain', 'demonstrate', 'practice', 'apply'].map((s, i) => (
                    <span key={s} className="pill" style={{
                      fontSize: 10,
                      background: tutor.step === s ? 'var(--accent)' : undefined,
                      color: tutor.step === s ? 'var(--on-accent)' : undefined,
                    }}>{['①讲', '②示', '③练', '④用'][i]}</span>
                  ))}
                  <button className="mini" onClick={() => { setTutor(null); setFeynRes(null); setFeynText(''); }}>收起</button>
                </span>
              </h3>
              {tutorBusy && <small style={{ color: 'var(--ink3)' }}>导师思考中…</small>}
              {tutor.explain && (
                <div style={{ marginBottom: 10 }}>
                  <b style={{ fontSize: 13.5 }}>① {tutor.explain.title}</b>
                  <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', marginTop: 4 }}>{tutor.explain.content}</div>
                  {tutor.explain.key_points?.length > 0 && (
                    <small style={{ display: 'block', marginTop: 6, color: 'var(--navy)' }}>
                      要点：{tutor.explain.key_points.join(' · ')}
                    </small>
                  )}
                </div>
              )}
              {tutor.demonstrate && (
                <div style={{ marginBottom: 10 }}>
                  <b style={{ fontSize: 13.5 }}>② {tutor.demonstrate.title}</b>
                  <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', marginTop: 4 }}>{tutor.demonstrate.content}</div>
                </div>
              )}
              {tutor.question && tutor.step !== 'practice' && (
                <div style={{ marginBottom: 10 }}>
                  <b style={{ fontSize: 13.5 }}>③ 实练任务</b>
                  {tutor.context && <div className="itto-ctx">{tutor.context}</div>}
                  <b style={{ display: 'block', lineHeight: 1.7 }}>{tutor.question}</b>
                </div>
              )}
              {tutor.grade && (
                <div className={`itto-res ${tutor.grade.verdict}`} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span className={`itto-score ${tutor.grade.verdict}`}>{tutor.grade.score}</span>
                    <span className={`itto-vd ${tutor.grade.verdict}`}>{VD[tutor.grade.verdict] || tutor.grade.verdict}</span>
                    <span className="pill">{tutor.mastery}</span>
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>{tutor.grade.comment}</div>
                </div>
              )}
              {tutor.apply_hints?.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <b style={{ fontSize: 13.5 }}>④ 用到哪里</b>
                  {tutor.apply_hints.map((h) => (
                    <div key={h.event} className="itto-ctx" style={{ marginTop: 4 }}>
                      {h.text} <span className="pill">{h.event}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* 步骤推进按钮 */}
              {tutor.step === 'explain' && !tutorBusy && (
                <button className="mini pri" onClick={() => tutorNext()}>看懂了 → 用我的真实项目演示</button>
              )}
              {tutor.step === 'demonstrate' && !tutorBusy && (
                <button className="mini pri" onClick={() => tutorNext()}>明白了 → 给我出个实练任务</button>
              )}
              {tutor.step === 'practice' && !tutorBusy && (
                <div>
                  {tutor.context && <div className="itto-ctx">{tutor.context}</div>}
                  <b style={{ display: 'block', lineHeight: 1.7 }}>{tutor.question}</b>
                  <textarea style={{ width: '100%', minHeight: 70, marginTop: 6 }} placeholder="按任务要求作答，导师将按 rubric 批改…"
                    value={tutorAnswer} onChange={(e) => setTutorAnswer(e.target.value)} />
                  <button className="mini pri" style={{ marginTop: 6 }} disabled={!tutorAnswer.trim()} onClick={() => tutorNext(tutorAnswer)}>
                    提交批改
                  </button>
                </div>
              )}
              {tutor.step === 'apply' && !tutorBusy && (
                <div>
                  <b style={{ fontSize: 13 }}>费曼挑战（M3 能教授）</b>
                  <small style={{ display: 'block', margin: '4px 0', color: 'var(--ink3)' }}>
                    假设我是零基础新 PM，用你自己的话把这个工具讲清楚。AI 评定合格即达成「能教授」。
                  </small>
                  <textarea style={{ width: '100%', minHeight: 60 }} placeholder="这个工具是…解决的问题是…用法是…比如…"
                    value={feynText} onChange={(e) => setFeynText(e.target.value)} />
                  <button className="mini pri" style={{ marginTop: 6 }} disabled={!feynText.trim()} onClick={submitFeynman}>
                    提交费曼评定
                  </button>
                  {feynRes && (
                    <div className={feynRes.qualified ? 'notice' : 'notice danger'} style={{ marginTop: 8 }}>
                      <b>{feynRes.qualified ? '✓ 达成 M3 能教授' : '× 尚未达到能教授标准'}</b>
                      <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.7 }}>{feynRes.comment}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* R3.4 WP6 掌握度矩阵：工具（四步教学）与卡片（SM-2）共用同一 M0-M3 口径 */}
          <div className="card">
            <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span>掌握度矩阵 · M0—M3</span>
              <small style={{ fontWeight: 400, color: 'var(--ink3)' }}>
                已开课工具 {mx?.summary?.taught_tools ?? 0}/{mx?.summary?.tool_total ?? 0} · M3 {mx?.summary?.m3_items ?? 0} 项
              </small>
            </h3>
            <div className="mx-grid">
              {(mx?.counts ?? []).map((c) => (
                <button key={c.m} className={`mx-cell ${mxM === c.m ? 'on' : ''}`} onClick={() => setMxM(c.m)}>
                  <b>{c.key} {c.name}</b>
                  <span>工具 {c.tools} · 卡片 {c.cards}</span>
                  <small>工具：{c.tool_basis}<br />卡片：{c.card_basis}</small>
                </button>
              ))}
            </div>
            {!mx && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>}
            {mx && mxM === 0 && (
              <div className="itto-chips">
                {mx.tools.filter((t) => t.m === 0).map((t) => (
                  <span key={t.id} className="itto-chip in" title={`${t.category} · ${t.proc_count} 个过程使用`}>{t.name}</span>
                ))}
              </div>
            )}
            {mx && mxM > 0 && (
              <>
                {mx.tools.filter((t) => t.m === mxM).map((t) => (
                  <div key={`t${t.id}`} className="mx-row">
                    <span className="k">{t.label}</span><b>{t.name}</b>
                    <span className="pill">{t.category}</span>
                    <small style={{ color: 'var(--ink3)' }}>{t.proc_count} 过程</small>
                    {t.m >= 3 && (t.evidence_id
                      ? <span className="pill">已入证据 #{t.evidence_id}</span>
                      : <button className="mini pri" disabled={mxBusy} onClick={() => promote(t.id)}>沉淀知识贡献证据</button>)}
                  </div>
                ))}
                {mx.cards.filter((c) => c.m === mxM).map((c) => (
                  <div key={`c${c.id}`} className="mx-row">
                    <span className="k">{c.label}</span>
                    <span className="pill">{c.domain}</span>
                    <span style={{ flex: 1, minWidth: 200 }}>{c.front}</span>
                    <small className="r">复习 {c.reps} 次 · 间隔 {c.interval_days} 天</small>
                    {c.m >= 3 && (c.evidence_id
                      ? <span className="pill" title="同主题工具费曼合格，教授证据已入成长记录">教授证据 #{c.evidence_id}</span>
                      : <span className="pill" style={{ color: 'var(--ink3)' }} title="卡片侧 M3 为 SM-2 代理口径，暂无同主题教授证据">代理口径</span>)}
                  </div>
                ))}
                {mx.tools.filter((t) => t.m === mxM).length + mx.cards.filter((c) => c.m === mxM).length === 0 && (
                  <small style={{ color: 'var(--ink3)' }}>该档暂无条目</small>
                )}
              </>
            )}
            {mx && <small style={{ display: 'block', marginTop: 8, color: 'var(--ink3)' }}>{mx.note}</small>}
          </div>

          <div className="card">
            <h3>过程 ITTO 明细</h3>
            {!selId && <small style={{ color: 'var(--ink3)' }}>← 在左侧展开知识域，点选一个过程查看输入 / 工具 / 输出</small>}
            {detailBusy && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>}
            {detail && !detailBusy && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <b style={{ fontSize: 15 }}>{detail.process.code} {detail.process.name}</b>
                  <span className="pill">{detail.process.ka}</span>
                </div>
                <div className="itto-grp">
                  <label>输入 · INPUTS</label>
                  <div className="itto-chips">
                    {detail.inputs.map((x, i) => (
                      <span key={i} className="itto-chip in" title={`${x.category} · ${x.sources}`}>{x.name}<SrcMarks sources={x.sources} /></span>
                    ))}
                  </div>
                </div>
                <div className="itto-grp">
                  <label>工具与技术 · TOOLS & TECHNIQUES</label>
                  <div className="itto-chips">
                    {detail.tools.map((x, i) => (
                      <span key={i} className="itto-chip tool" title={`${x.category} · ${x.sources}`}>{x.name}<SrcMarks sources={x.sources} /></span>
                    ))}
                  </div>
                </div>
                <div className="itto-grp" style={{ marginBottom: 0 }}>
                  <label>输出 · OUTPUTS</label>
                  <div className="itto-chips">
                    {detail.outputs.map((x, i) => (
                      <span key={i} className="itto-chip out" title={`${x.category} · ${x.sources}`}>{x.name}<SrcMarks sources={x.sources} /></span>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="card">
            <h3>工具检索</h3>
            <div className="itto-search">
              <input value={q} placeholder="搜索工具关键词，如：挣值 / 矩阵 / 会议…" onChange={(e) => setQ(e.target.value)} />
              {toolBusy && <small style={{ color: 'var(--ink3)' }}>搜索中…</small>}
            </div>
            {tools === null && <small style={{ color: 'var(--ink3)', display: 'block', marginTop: 8 }}>输入关键词检索工具及其被哪些过程使用</small>}
            {tools !== null && (
              <div style={{ marginTop: 8 }}>
                {tools.length === 0 && !toolBusy && <small style={{ color: 'var(--ink3)' }}>没有匹配的工具</small>}
                {tools.map((t) => (
                  <div key={t.id} className="itto-t">
                    <b>{t.name}</b>
                    <span className="pill">{t.category}</span>
                    <span className="srcs">
                      {(t.sources || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => SRC_LABEL[s] || s).join(' / ')}
                    </span>
                    <span className="used">
                      <button className="mini pri" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }} disabled={tutorBusy} onClick={() => startTutor(t.id)}><IconSchool size={12} stroke={1.8} style={{ verticalAlign: '-2px' }} /> 教学</button>
                      {(t.used_by || []).slice(0, 3).map((u) => (
                        <button key={u.code} title={u.name} onClick={() => jumpToProc(u.code)}>{u.code}</button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3>工具实操练习</h3>
            {!prac && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button className="mini pri" style={{ fontSize: 12.5, padding: '5px 12px' }} disabled={!selId || genBusy} onClick={gen}>
                  {genBusy ? '出题中…' : '用当前过程出实操题'}
                </button>
                {!selId && <small style={{ color: 'var(--ink3)' }}>先在左侧选择一个过程</small>}
              </div>
            )}
            {prac && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="pill">深度 · {DEPTH[prac.depth] || prac.depth}</span>
                  <b>{prac.process_name}</b>
                </div>
                {prac.context && <div className="itto-ctx">{prac.context}</div>}
                <b style={{ display: 'block', lineHeight: 1.7, marginTop: 4 }}>{prac.question}</b>
                {!result && (
                  <div style={{ marginTop: 8 }}>
                    <textarea style={{ width: '100%', minHeight: 80 }} placeholder="结合情境：你会用哪些工具/技术？怎么用？产出什么？"
                      value={answer} onChange={(e) => setAnswer(e.target.value)} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <button className="mini pri" style={{ fontSize: 12.5, padding: '5px 12px' }} disabled={subBusy || !answer.trim()} onClick={submit}>
                        {subBusy ? '判分中…' : '提交判分'}
                      </button>
                      <button className="mini" onClick={() => { setPrac(null); setResult(null); setAnswer(''); }}>放弃本题</button>
                    </div>
                  </div>
                )}
                {result && (
                  <div className={`itto-res ${result.verdict}`}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span className={`itto-score ${result.verdict}`}>{result.score}</span>
                      <span className={`itto-vd ${result.verdict}`}>{VD[result.verdict] || result.verdict}</span>
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7 }}>{result.comment}</div>
                    <details className="itto-ref">
                      <summary>参考答案</summary>
                      <div>{result.reference}</div>
                    </details>
                    <div style={{ marginTop: 8 }}>
                      <button className="mini pri" style={{ fontSize: 12.5, padding: '5px 12px' }} disabled={genBusy} onClick={gen}>
                        {genBusy ? '出题中…' : '再来一道'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {hist.length === 0
              ? <small style={{ color: 'var(--ink3)', display: 'block', marginTop: 12 }}>暂无练习记录</small>
              : (
                <table className="itto-hist">
                  <thead><tr><th>时间</th><th>过程</th><th>分数</th><th>评定</th></tr></thead>
                  <tbody>
                    {hist.map((h) => (
                      <tr key={h.id}>
                        <td style={{ color: 'var(--ink3)', whiteSpace: 'nowrap' }}>{h.created_at}</td>
                        <td>{h.process_name}</td>
                        <td>{h.score}</td>
                        <td><span className={`itto-vd ${h.verdict}`}>{VD[h.verdict] || h.verdict}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}
