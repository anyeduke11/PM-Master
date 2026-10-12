import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IconSettings, IconRobot, IconChartDots3, IconToggleLeft, IconExternalLink, IconDownload, IconTrendingUp, IconSparkles, IconRadar, IconBolt, IconMessageCode, IconPlus, IconPencil, IconTrash, IconUserCircle, IconBrain, IconPin, IconRefresh } from '@tabler/icons-react';
import { toast, Modal, Field } from './ui.jsx';

// R7.0 P1 设置中心：A 系统状态 / B LLM 与模型（热切换）/ C 可观测性 / E 功能开关
// R7.0 P2：K 数据流入（导入历史与说明）/ G 工具频率（使用排行/冷门推荐/训练任务）
// R7.0 P3：J 巡检简报（调度状态+findings+动作路由）/ I 提示词库（常用场景固化）
// R7.0 P4：F 档案与蒸馏（persona + 画像蒸馏）/ H 记忆与上下文（条目 CRUD + 注入预览）
// 左锚点导航 + 右分区卡片；窄屏导航横滚、单列堆叠（CSS 断点处理）
const SECTIONS = [
  ['sys', '系统状态', IconSettings],
  ['llm', 'LLM 与模型', IconRobot],
  ['obs', '可观测性', IconChartDots3],
  ['feature', '功能开关', IconToggleLeft],
  ['persona', '档案与蒸馏', IconUserCircle],
  ['memory', '记忆与上下文', IconBrain],
  ['import', '数据流入', IconDownload],
  ['tools', '工具频率', IconTrendingUp],
  ['patrol', '巡检简报', IconRadar],
  ['prompts', '提示词库', IconMessageCode],
];

const SRC_LABEL = { db: 'DB 覆盖', env: 'env', default: '默认' };

const SEV_LABEL = { high: '高危', mid: '中危', low: '低危' };

export default function Settings({ onNavigate, onCoachStart }) {
  const [sec, setSec] = useState('sys');
  const [system, setSystem] = useState(null);
  const [settings, setSettings] = useState(null);   // 全量白名单视图
  const [stats, setStats] = useState(null);
  const [days, setDays] = useState(30);
  const [purpose, setPurpose] = useState('');
  const [draft, setDraft] = useState({});           // B/E 区编辑草稿 {key: value}
  const [saving, setSaving] = useState(false);
  const [logs, setLogs] = useState(null);           // R7.0 P2 K 区：导入历史
  const [usage, setUsage] = useState(null);         // R7.0 P2 G 区：工具频率聚合
  const [reports, setReports] = useState(null);     // R7.0 P3 J 区：巡检简报（[0]=最新）
  const [sched, setSched] = useState(null);         // R7.0 P3 J 区：调度状态
  const [runningPatrol, setRunningPatrol] = useState(false);
  const [prompts, setPrompts] = useState(null);     // R7.0 P3 I 区：提示词库
  const [pEdit, setPEdit] = useState(null);         // 编辑中提示词 {id?, title, content, sort}（null=关）
  const [pDel, setPDel] = useState(null);           // 待删除确认的提示词 id
  const [memories, setMemories] = useState(null);   // R7.0 P4 H 区：记忆条目
  const [ctx, setCtx] = useState(null);             // R7.0 P4 H 区：上下文预览
  const [memInput, setMemInput] = useState('');     // 手记输入
  const [memDel, setMemDel] = useState(null);       // 待删除确认记忆 id
  const [summaryEdit, setSummaryEdit] = useState(null);  // F 区：画像编辑文本（null=非编辑态）
  const [distilling, setDistilling] = useState(false);
  const refs = useRef({});

  async function j(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message ?? `HTTP ${r.status}`);
    return r.json();
  }
  async function loadAll() {
    try {
      const [sys, set, st, lg, us, rp, sc, pm, mm, cx] = await Promise.all([
        j('/api/settings/system'), j('/api/settings'), j('/api/llm/stats'),
        j('/api/import/logs'), j('/api/tools/usage'), j('/api/patrol/reports'), j('/api/scheduler'), j('/api/prompts'),
        j('/api/memories'), j('/api/context/preview'),
      ]);
      setSystem(sys); setSettings(set); setStats(st); setLogs(lg); setUsage(us);
      setReports(rp); setSched(sc); setPrompts(pm); setMemories(mm); setCtx(cx); setDraft({});
    } catch (e) { toast(`设置加载失败：${e.message}`, 'err'); }
  }
  useEffect(() => { loadAll(); }, []);

  // C 区过滤（days/purpose 走后端参数；purpose 下拉选项来自聚合结果）
  async function loadStats(d, p) {
    try {
      const qs = new URLSearchParams({ days: String(d) });
      if (p) qs.set('purpose', p);
      setStats(await j(`/api/llm/stats?${qs}`));
    } catch (e) { toast(`观测刷新失败：${e.message}`, 'err'); }
  }
  const purposes = useMemo(() => (stats?.by_purpose ?? []).map((r) => r.purpose).filter((v, i, a) => a.indexOf(v) === i).sort(), [stats]);

  const byGroup = (g) => (settings ?? []).filter((s) => s.group === g);
  const eff = (s) => (s.key in draft ? draft[s.key] : s.effective);

  // 保存草稿：PUT 后广播 pm-settings（Bell 轮询间隔/助手建议即时生效），再回读
  async function save(patch) {
    const body = patch ?? draft;
    if (!Object.keys(body).length) return;
    setSaving(true);
    try {
      const next = await j('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      setSettings(next);
      if (!patch) setDraft({});
      else setDraft((d) => { const c = { ...d }; for (const k of Object.keys(body)) delete c[k]; return c; });
      window.dispatchEvent(new CustomEvent('pm-settings', { detail: Object.fromEntries(next.map((s) => [s.key, s.effective])) }));
      toast('设置已保存（LLM 项下次调用生效）', 'ok');
    } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
    setSaving(false);
  }

  function goto(id) {
    setSec(id);
    refs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // G 区：冷门工具 → 训练任务（服务端幂等；成功后刷新排行）
  async function assignTask(tool) {
    try {
      const r = await j('/api/tools/usage/task', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool_id: tool.id }),
      });
      toast(r.existing ? `「${tool.name}」训练任务已在清单中` : `已为「${tool.name}」生成训练任务`, 'ok');
      setUsage(await j('/api/tools/usage'));
    } catch (e) { toast(`生成失败：${e.message}`, 'err'); }
  }

  // J 区：手动触发巡检（真实 LLM 较慢，busy 态）+ finding 动作路由（白名单：coach:xxx | tab:xxx）
  async function runPatrol() {
    setRunningPatrol(true);
    try {
      const r = await j('/api/scheduler/run/patrol', { method: 'POST' });
      toast(`巡检完成：${r.result.findings} 项发现${r.result.notified ? '，已投通知' : '（无发现，静默）'}`, 'ok', 4200);
      setReports(await j('/api/patrol/reports'));
      setSched(await j('/api/scheduler'));
    } catch (e) { toast(`巡检失败：${e.message}`, 'err'); }
    setRunningPatrol(false);
  }
  function fireRoute(route) {
    const [kind, arg] = String(route).split(':');
    if (kind === 'coach') onCoachStart?.(arg);
    else if (kind === 'tab') onNavigate?.(arg);
  }

  // I 区：提示词保存（新建/编辑）与删除；成功后广播 pm-prompts（助手快捷按钮即时刷新）
  const broadcastPrompts = () => window.dispatchEvent(new Event('pm-prompts'));
  async function savePrompt() {
    if (!pEdit?.title?.trim() || !pEdit?.content?.trim()) return toast('标题与内容必填', 'warn');
    try {
      if (pEdit.id) await j(`/api/prompts/${pEdit.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pEdit) });
      else await j('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pEdit) });
      setPrompts(await j('/api/prompts'));
      setPEdit(null);
      broadcastPrompts();
      toast('提示词已保存', 'ok');
    } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
  }
  async function removePrompt(id) {
    try {
      await j(`/api/prompts/${id}`, { method: 'DELETE' });
      setPrompts(await j('/api/prompts'));
      setPDel(null);
      broadcastPrompts();
      toast('已删除', 'ok');
    } catch (e) { toast(`删除失败：${e.message}`, 'err'); }
  }
  async function togglePrompt(p) {
    try {
      await j(`/api/prompts/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !p.enabled }) });
      setPrompts(await j('/api/prompts'));
      broadcastPrompts();
    } catch (e) { toast(e.message, 'err'); }
  }

  // —— R7.0 P4 F 区：画像蒸馏 + 编辑保存（写 user_profile.summary，下次 AI 调用即注入） ——
  async function runDistill() {
    setDistilling(true);
    try {
      const r = await j('/api/profile/distill', { method: 'POST' });
      toast('画像已蒸馏并写入（可编辑后保存）', 'ok');
      setCtx(await j('/api/context/preview'));
      setSummaryEdit(r.summary);
    } catch (e) { toast(`蒸馏失败：${e.message}`, 'err'); }
    setDistilling(false);
  }
  async function saveSummary() {
    try {
      await j('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: summaryEdit || null }) });
      setCtx(await j('/api/context/preview'));
      setSummaryEdit(null);
      toast('画像已保存（下次 AI 调用生效）', 'ok');
    } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
  }

  // —— R7.0 P4 H 区：记忆条目 CRUD + 预览刷新 ——
  async function addMem() {
    const c = memInput.trim();
    if (!c) return;
    try {
      await j('/api/memories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: c }) });
      setMemInput('');
      setMemories(await j('/api/memories'));
      setCtx(await j('/api/context/preview'));
      toast('已记住', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function togglePin(m) {
    try {
      await j(`/api/memories/${m.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: !m.pinned }) });
      setMemories(await j('/api/memories'));
      setCtx(await j('/api/context/preview'));
    } catch (e) { toast(e.message, 'err'); }
  }
  async function removeMem(id) {
    try {
      await j(`/api/memories/${id}`, { method: 'DELETE' });
      setMemories(await j('/api/memories'));
      setCtx(await j('/api/context/preview'));
      setMemDel(null);
      toast('已删除', 'ok');
    } catch (e) { toast(`删除失败：${e.message}`, 'err'); }
  }

  // —— 单行渲染器：按 type 出控件；「恢复」按钮=写 null 删 KV 行 ——
  function row(s) {
    const v = eff(s);
    const dirty = s.key in draft;
    const set = (x) => setDraft((d) => ({ ...d, [s.key]: x }));
    let ctl;
    if (s.type === 'bool') {
      ctl = <button type="button" className={`switch ${v ? 'on' : ''}`} role="switch" aria-checked={Boolean(v)}
        aria-label={s.label} onClick={() => set(!v)} />;
    } else if (s.type === 'enum') {
      ctl = <select value={v ?? ''} onChange={(e) => set(e.target.value)}>
        {(s.values ?? []).map((o) => <option key={o} value={o}>{s.labels?.[o] ?? o}</option>)}
      </select>;
    } else if (s.type === 'int') {
      ctl = <input type="number" value={v ?? ''} min={s.min} max={s.max}
        onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} />;
    } else {
      ctl = <input type="text" value={v ?? ''} placeholder={s.default ?? ''} onChange={(e) => set(e.target.value)} />;
    }
    return (
      <div key={s.key} className="set-row">
        <span className="lab">{s.label}<small>{s.key}{s.env ? ` · env: ${s.env}` : ''}{s.min != null ? ` · ${s.min}-${s.max}` : ''}</small></span>
        <span className={`src-tag ${dirty ? 'db' : s.source === 'db' ? 'db' : s.source === 'env' ? 'env' : ''}`}>{dirty ? '待保存' : SRC_LABEL[s.source]}</span>
        {s.source === 'db' && !dirty && (s.group === 'llm' || s.group === 'persona') && (
          <button className="mini" title="清除 DB 覆盖，恢复 env/默认" disabled={saving} onClick={() => save({ [s.key]: null })}>恢复</button>
        )}
        {ctl}
      </div>
    );
  }

  const dirtyCount = Object.keys(draft).length;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 14, height: '100%', overflow: 'hidden' }}>
      {/* 左锚点导航 */}
      <nav className="card set-nav" style={{ padding: 10 }}>
        {SECTIONS.map(([id, label, Ic]) => (
          <button key={id} className={sec === id ? 'on' : ''} onClick={() => goto(id)} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Ic size={14} stroke={1.8} />{label}
          </button>
        ))}
        <div style={{ marginTop: 8, padding: '8px 6px 2px', borderTop: '1px dashed var(--line)', fontSize: 10.5, color: 'var(--ink3)', lineHeight: 1.7 }}>
          P5 规划：Skill 注册表 / MCP 管理 / 飞书读入
        </div>
      </nav>

      {/* 右分区 */}
      <div style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 2 }}>
        {/* A 系统状态 */}
        <div className="card" ref={(el) => (refs.current.sys = el)}>
          <h3>系统状态</h3>
          {!system && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /></div>}
          {system && (
            <>
              <div className="kpi-row">
                {[['版本', `v${system.version}`], ['数据表', system.db_tables], ['运行时长', `${Math.floor(system.uptime_s / 60)} 分钟`]].map(([n, v]) => (
                  <div key={n} className="kpi"><b style={{ fontSize: 14 }}>{v}</b><span>{n}</span></div>
                ))}
                <div className="kpi"><b style={{ fontSize: 14, color: system.key_configured ? 'var(--ok)' : 'var(--warn)' }}>{system.key_configured ? '已配置' : '未配置'}</b><span>LLM 密钥</span></div>
                <div className="kpi"><b style={{ fontSize: 14, color: system.feishu_configured ? 'var(--ok)' : 'var(--warn)' }}>{system.feishu_configured ? '已配置' : '未配置'}</b><span>飞书凭据</span></div>
              </div>
              <div className="set-rows">
                {[['提供方（生效）', system.provider], ['强模型', system.model], ['快模型', system.model_fast || '（未设，用强模型）'],
                  ['网关 base_url（只读）', system.base_url], ['Node', system.node]].map(([k, v]) => (
                  <div key={k} className="set-row"><span className="lab">{k}</span><span className="mono" style={{ color: 'var(--text-2)', wordBreak: 'break-all' }}>{v}</span></div>
                ))}
              </div>
              <small style={{ color: 'var(--ink3)' }}>密钥值永不出后端；改密钥/网关走 server/.env（经 scripts/with-env.sh 注入）后重启生效。</small>
            </>
          )}
        </div>

        {/* B LLM 与模型 */}
        <div className="card" ref={(el) => (refs.current.llm = el)}>
          <h3>LLM 与模型（热切换 · 下次调用生效）
            {dirtyCount > 0 && (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className="mini" onClick={() => setDraft({})}>放弃修改</button>
                <button className="mini pri" disabled={saving} onClick={() => save()}>{saving ? '保存中…' : `保存 ${dirtyCount} 项`}</button>
              </span>
            )}
          </h3>
          {!settings && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /></div>}
          {settings && <div className="set-rows">{byGroup('llm').map(row)}</div>}
          <small style={{ color: 'var(--ink3)' }}>DB 覆盖优先于环境变量；「恢复」清除覆盖。provider=openai 需 .env 已配密钥，pi 需本机安装 pi CLI。</small>
        </div>

        {/* C 可观测性（R6.6 观测卡自 Records 页迁入并增强） */}
        <div className="card" ref={(el) => (refs.current.obs = el)}>
          <h3>可观测性 · LLM 调用
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              <select value={days} onChange={(e) => { setDays(Number(e.target.value)); loadStats(Number(e.target.value), purpose); }}>
                {[7, 14, 30, 90].map((d) => <option key={d} value={d}>近 {d} 天</option>)}
              </select>
              <select value={purpose} onChange={(e) => { setPurpose(e.target.value); loadStats(days, e.target.value); }}>
                <option value="">全部用途</option>
                {purposes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </span>
          </h3>
          {!stats && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /></div>}
          {stats && (
            <>
              <div className="kpi-row">
                {[['累计调用', stats.total, 'var(--text)'], ['失败/限流', stats.errors, stats.errors ? 'var(--warn)' : 'var(--ok)'], ['tokens', stats.tokens, 'var(--text)']].map(([n, v, c]) => (
                  <div key={n} className="kpi"><b style={{ color: c }}>{v}</b><span>{n}</span></div>
                ))}
              </div>
              <table className="tb">
                <thead><tr><th>用途</th><th>提供方</th><th>次数</th><th>失败</th><th>均耗</th><th>tokens</th></tr></thead>
                <tbody>
                  {stats.by_purpose.map((r) => (
                    <tr key={`${r.purpose}-${r.provider}`}>
                      <td>{r.purpose}</td><td>{r.provider}</td><td className="mono">{r.calls}</td>
                      <td className="mono" style={{ color: r.error_calls ? 'var(--warn)' : undefined }}>{r.error_calls}</td>
                      <td className="mono">{r.avg_ms}ms</td><td className="mono">{r.tokens ?? 0}</td>
                    </tr>
                  ))}
                  {stats.by_purpose.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--ink3)' }}>暂无调用记录</td></tr>}
                </tbody>
              </table>
              <small style={{ display: 'block', margin: '8px 0 4px', color: 'var(--ink3)' }}>近 {days} 天用量（柱高=tokens，黄柱=当日有失败）· 过滤作用于明细表</small>
              {stats.daily?.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }}>
                  {stats.daily.map((d) => {
                    const max = Math.max(...stats.daily.map((x) => x.tokens ?? 0)) || 1;
                    return (
                      <div key={d.date} title={`${d.date}：${d.calls} 次 · ${d.tokens ?? 0} tokens${d.errors ? ` · 失败 ${d.errors}` : ''}`}
                        style={{ flex: '0 1 24px', minWidth: 6, textAlign: 'center' }}>
                        <div style={{ height: Math.max(3, ((d.tokens ?? 0) / max) * 44), background: d.errors ? 'var(--warn)' : 'var(--navy)', borderRadius: 2 }} />
                        <small style={{ fontSize: 8, color: 'var(--ink3)' }}>{d.date.slice(8)}</small>
                      </div>
                    );
                  })}
                </div>
              )}
              <details className="itto-ref" style={{ marginTop: 8 }}>
                <summary>最近调用明细（{stats.recent.length} 条{purpose ? ` · ${purpose}` : ''}）</summary>
                <div style={{ maxHeight: 260, overflow: 'auto' }}>
                  <table className="tb">
                    <thead><tr><th>时间</th><th>用途</th><th>模型</th><th>状态</th><th>耗时</th><th>tokens</th></tr></thead>
                    <tbody>
                      {stats.recent.map((r) => (
                        <tr key={r.id}>
                          <td style={{ whiteSpace: 'nowrap', color: 'var(--ink3)' }}>{r.created_at?.slice(5, 16)}</td>
                          <td>{r.purpose}</td><td className="mono" style={{ fontSize: 11 }}>{r.model ?? '-'}</td>
                          <td>{r.ok ? <span style={{ color: 'var(--ok)' }}>✓</span> : <span style={{ color: 'var(--cin)' }}>✗</span>}</td>
                          <td className="mono">{r.ms}ms</td><td className="mono">{r.total_tokens ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {stats.recent.filter((r) => !r.ok).slice(0, 5).map((r) => (
                    <small key={`e${r.id}`} style={{ display: 'block', marginTop: 4, color: 'var(--warn)' }}>{r.created_at?.slice(5, 16)} {r.purpose}: {r.error}</small>
                  ))}
                </div>
              </details>
            </>
          )}
        </div>

        {/* E 功能开关 */}
        <div className="card" ref={(el) => (refs.current.feature = el)}>
          <h3>功能开关
            {dirtyCount > 0 && (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className="mini" onClick={() => setDraft({})}>放弃修改</button>
                <button className="mini pri" disabled={saving} onClick={() => save()}>{saving ? '保存中…' : `保存 ${dirtyCount} 项`}</button>
              </span>
            )}
          </h3>
          {settings && <div className="set-rows">{byGroup('feature').map(row)}</div>}
          <small style={{ color: 'var(--ink3)' }}>开关保存后即时广播生效（通知轮询/助手建议/动效）；默认主题仅影响未手动切换过的首次访问。</small>
          <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="mini" onClick={() => window.open('/api/export/json', '_blank')}><IconExternalLink size={12} stroke={1.8} /> 数据快照 JSON</button>
            <button className="mini" onClick={() => window.open('/api/scheduler', '_blank')}><IconExternalLink size={12} stroke={1.8} /> 调度任务状态</button>
          </div>
        </div>

        {/* F 档案与蒸馏（R7.0 P4）：AI persona 设定 + 画像蒸馏（写 summary，下次 AI 调用注入） */}
        <div className="card" ref={(el) => (refs.current.persona = el)}>
          <h3>AI 角色与画像
            {dirtyCount > 0 && (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className="mini" onClick={() => setDraft({})}>放弃修改</button>
                <button className="mini pri" disabled={saving} onClick={() => save()}>{saving ? '保存中…' : `保存 ${dirtyCount} 项`}</button>
              </span>
            )}
          </h3>
          {!settings && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /></div>}
          {settings && <div className="set-rows">{byGroup('persona').map(row)}</div>}
          <small style={{ color: 'var(--ink3)' }}>persona 保存后下次 AI 调用即生效（注入 system prompt 的交互设定）。</small>
          <hr className="divider" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <b style={{ fontSize: 12.5 }}>画像蒸馏（档案 + 能力分 + 近期证据 → 一段 AI 持续了解的画像）</b>
            <button className="mini pri" style={{ marginLeft: 'auto', flex: 'none' }} disabled={distilling} onClick={runDistill}>
              <IconRefresh size={12} stroke={1.8} /> {distilling ? '蒸馏中（强模型）…' : '重新蒸馏'}
            </button>
          </div>
          {summaryEdit === null ? (
            ctx?.summary
              ? (
                <div className="itto-ctx" style={{ whiteSpace: 'pre-wrap' }}>
                  {ctx.summary}
                  <div style={{ marginTop: 6 }}><button className="mini" onClick={() => setSummaryEdit(ctx.summary)}><IconPencil size={11} stroke={1.8} /> 编辑</button></div>
                </div>
              )
              : <div className="empty">尚无画像——蒸馏后每次 AI 调用自动携带（约 100 token）；教练归档的记忆会自动补充细节</div>
          ) : (
            <div>
              <textarea style={{ width: '100%', minHeight: 90 }} maxLength={500} value={summaryEdit}
                onChange={(e) => setSummaryEdit(e.target.value)} />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="mini pri" disabled={!summaryEdit.trim()} onClick={saveSummary}>保存画像</button>
                <button className="mini" onClick={() => setSummaryEdit(null)}>取消</button>
                <button className="mini danger" style={{ marginLeft: 'auto' }} onClick={() => setSummaryEdit('')}>清空</button>
              </div>
            </div>
          )}
        </div>

        {/* H 记忆与上下文（R7.0 P4）：条目级工作记忆 CRUD + 注入透明化预览 */}
        <div className="card" ref={(el) => (refs.current.memory = el)}>
          <h3>记忆与上下文</h3>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input style={{ flex: 1 }} placeholder="告诉 AI 需要长期记住的事（≤300 字），如：我的周报口径以 EVM 为准"
              value={memInput} onChange={(e) => setMemInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addMem()} />
            <button className="pri" disabled={!memInput.trim()} onClick={addMem}>记住</button>
          </div>
          {!memories && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /></div>}
          {memories && memories.length === 0 && <div className="empty">暂无记忆——教练会话归档时会自动提取（kind=coach），也可手动添加</div>}
          {memories?.map((m) => (
            <div key={m.id} className="set-row">
              <span className="lab">{m.content}
                <small>{m.kind === 'coach' ? '教练提取' : m.kind === 'chat' ? '对话提取' : '手记'} · {m.source ?? 'manual'}{m.pinned ? ' · 置顶' : ''}</small>
              </span>
              <button className={`mini ${m.pinned ? 'pri' : ''}`} title={m.pinned ? '取消置顶' : '置顶（注入优先）'} onClick={() => togglePin(m)}><IconPin size={12} stroke={1.8} /></button>
              {memDel === m.id
                ? <><button className="mini danger" onClick={() => removeMem(m.id)}>确认删除</button><button className="mini" onClick={() => setMemDel(null)}>取消</button></>
                : <button className="mini" title="删除" onClick={() => setMemDel(m.id)}><IconTrash size={12} stroke={1.8} /></button>}
            </div>
          ))}
          {ctx && (
            <>
              <hr className="divider" />
              <div className="kpi-row">
                <div className="kpi"><b style={{ fontSize: 14 }}>L{ctx.profile.current_level} → L{ctx.profile.target_level}</b><span>档案（{ctx.profile.track === 'pmo' ? 'PMO' : '项目'}通道）</span></div>
                <div className="kpi"><b style={{ fontSize: 14, color: ctx.summary ? 'var(--ok)' : 'var(--ink3)' }}>{ctx.summary ? '已生成' : '未生成'}</b><span>画像注入</span></div>
                <div className="kpi"><b style={{ fontSize: 14, color: 'var(--accent)' }}>{ctx.memory_injection.injected}/{ctx.memory_injection.total}</b><span>记忆注入（top5 置顶优先）</span></div>
              </div>
              <details className="itto-ref">
                <summary>查看实际注入的 system prompt（AI 现在知道什么）</summary>
                <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{ctx.system_prompt}</div>
              </details>
            </>
          )}
        </div>

        {/* K 数据流入（R7.0 P2）：导入历史与说明（导入操作入口在工作台） */}
        <div className="card" ref={(el) => (refs.current.import = el)}>
          <h3>数据流入 · 导入历史</h3>
          <div className="notice">
            导入入口在<b>项目工作台 → 在管项目 → 上传图标</b>：粘贴表格/清单文本（或拖入 .txt/.md/.csv）→ AI 抽取预览 → 逐行编辑勾选 → 入库。
            四类：EVM 度量（导入后可直接生成周报）/ 风险登记 / 会议行动项 / 干系人。校验、项目匹配、去重全部服务端代码执行。
          </div>
          {!logs && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /></div>}
          {logs && (
            <table className="tb">
              <thead><tr><th>时间</th><th>类型</th><th>来源</th><th>入库</th><th>跳过</th><th>状态</th></tr></thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td style={{ whiteSpace: 'nowrap', color: 'var(--ink3)' }}>{l.created_at?.slice(5, 16)}</td>
                    <td>{l.kind}</td><td>{l.source}</td>
                    <td className="mono" style={{ color: 'var(--ok)' }}>{l.items}</td>
                    <td className="mono" style={{ color: l.skipped ? 'var(--warn)' : undefined }}>{l.skipped}</td>
                    <td>{l.status === 'ok' ? <span style={{ color: 'var(--ok)' }}>✓ 全部</span> : <span style={{ color: 'var(--warn)' }}>部分</span>}</td>
                  </tr>
                ))}
                {logs.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--ink3)' }}>暂无导入记录</td></tr>}
              </tbody>
            </table>
          )}
        </div>

        {/* G 工具频率（R7.0 P2）：138 工具使用排行 + 高杠杆冷门 + 一键训练任务 */}
        <div className="card" ref={(el) => (refs.current.tools = el)}>
          <h3>工具频率管理</h3>
          {!usage && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /></div>}
          {usage && (
            <>
              <div className="kpi-row">
                {[['工具总数', usage.total, 'var(--text)'], ['已使用', usage.used_count, 'var(--accent)'],
                  ['覆盖率', usage.coverage == null ? '-' : `${Math.round(usage.coverage * 100)}%`, usage.coverage > 0.3 ? 'var(--ok)' : 'var(--warn)']].map(([n, v, c]) => (
                  <div key={n} className="kpi"><b style={{ color: c }}>{v}</b><span>{n}</span></div>
                ))}
              </div>
              {usage.top_ka?.length > 0 && (
                <div style={{ marginBottom: 8, fontSize: 11.5, color: 'var(--ink3)' }}>
                  过程引用最密集知识域：{usage.top_ka.map((k) => `${k.ka}(${k.n})`).join(' · ')}
                </div>
              )}
              <b style={{ fontSize: 12.5 }}>常用工具 Top {Math.min(usage.top.length, 15)}</b>
              {usage.top.length === 0 && <div className="empty" style={{ margin: '6px 0' }}>尚无使用记录——去知识库对工具开四步教学或实操练习</div>}
              {usage.top.length > 0 && (
                <table className="tb" style={{ margin: '6px 0 12px' }}>
                  <thead><tr><th>工具</th><th>类别</th><th>使用</th><th>教学/实操</th><th>M 档</th><th>最近使用</th></tr></thead>
                  <tbody>
                    {usage.top.slice(0, 15).map((t) => (
                      <tr key={t.id}>
                        <td><b>{t.name}</b></td><td style={{ color: 'var(--ink3)' }}>{t.category ?? '-'}</td>
                        <td className="mono">{t.usage}</td><td className="mono">{t.taught}/{t.practiced}</td>
                        <td><span className={`itto-vd ${t.m >= 3 ? 'good' : t.m === 2 ? 'ok' : 'weak'}`}>{t.m_label}</span></td>
                        <td className="mono" style={{ fontSize: 10.5, color: 'var(--ink3)' }}>{t.last_used?.slice(0, 10) ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <b style={{ fontSize: 12.5 }}>高杠杆冷门（过程引用多但零使用）</b>
              <div style={{ display: 'grid', gap: 6, margin: '6px 0' }}>
                {usage.cold.map((t) => (
                  <div key={t.id} className="mx-row">
                    <b>{t.name}</b>
                    <span className="pill">{t.category}</span>
                    <small style={{ color: 'var(--ink3)' }}>{t.proc_count} 个过程引用</small>
                    <button className="mini pri" style={{ marginLeft: 'auto' }} onClick={() => assignTask(t)}>
                      <IconSparkles size={11} stroke={2} /> 生成训练任务
                    </button>
                  </div>
                ))}
                {usage.cold.length === 0 && <div className="empty">所有被引用工具都已有使用记录</div>}
              </div>
              <small style={{ color: 'var(--ink3)' }}>{usage.note}；训练任务写入成长路径「训练任务」清单（幂等，重复指派不重建）</small>
            </>
          )}
        </div>

        {/* J 巡检简报（R7.0 P3）：调度状态 + 最新 findings（动作路由）+ 历史 */}
        <div className="card" ref={(el) => (refs.current.patrol = el)}>
          <h3>每日巡检简报
            <button className="mini pri" style={{ marginLeft: 'auto' }} disabled={runningPatrol} onClick={runPatrol}>
              <IconBolt size={12} stroke={2} /> {runningPatrol ? '巡检中（LLM 摘要）…' : '立即巡检'}
            </button>
          </h3>
          {sched?.patrol && (
            <div className="set-row" style={{ marginBottom: 8 }}>
              <span className="lab">定时调度<small>{sched.patrol.cron}（{sched.patrol.label}）</small></span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--ink3)' }}>上次：{sched.patrol.last_run ? sched.patrol.last_run.slice(5, 16) : '未执行'}</span>
              {sched.patrol.last_result === 'ok'
                ? <span className="badge cnt-ok">✓ 正常</span>
                : sched.patrol.last_result ? <span className="badge cnt-err">✗ {String(sched.patrol.last_error ?? '失败').slice(0, 40)}</span> : null}
            </div>
          )}
          {!reports && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /></div>}
          {reports && reports.length === 0 && <div className="empty">尚无巡检记录——点击「立即巡检」或等待每日 08:00 定时执行</div>}
          {reports?.length > 0 && (
            <>
              <div className="notice">
                <b>{reports[0].patrol_date} 简报</b>
                {!reports[0].llm_ok && <span className="src-tag env" style={{ marginLeft: 6 }}>降级模板</span>}
                <div style={{ marginTop: 3 }}>{reports[0].digest}</div>
              </div>
              {reports[0].findings.map((f, i) => (
                <div key={i} className={`pt-item s-${f.severity}`}>
                  <span className={`sev-tag s-${f.severity}`}>{SEV_LABEL[f.severity] ?? f.severity}</span>
                  <span className="body"><b>{f.title}</b><small>{f.detail}</small></span>
                  {f.action && <button className="mini" onClick={() => fireRoute(f.action.route)}>{f.action.label}</button>}
                </div>
              ))}
              {reports.length > 1 && (
                <details className="itto-ref" style={{ marginTop: 6 }}>
                  <summary>更早简报（{reports.length - 1} 期）</summary>
                  {reports.slice(1).map((r) => (
                    <div key={r.id} style={{ marginBottom: 6 }}>
                      <b style={{ fontSize: 11.5 }}>{r.patrol_date}</b>
                      <div style={{ fontSize: 11.5, color: 'var(--ink3)', lineHeight: 1.6 }}>{r.digest}</div>
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
        </div>

        {/* I 提示词库（R7.0 P3）：常用场景固化 → 助手侧栏快捷按钮 */}
        <div className="card" ref={(el) => (refs.current.prompts = el)}>
          <h3>提示词库
            <button className="mini pri" style={{ marginLeft: 'auto' }} onClick={() => setPEdit({ title: '', content: '', sort: (prompts?.length ?? 0) + 1 })}>
              <IconPlus size={12} stroke={2} /> 新建
            </button>
          </h3>
          {!prompts && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /></div>}
          {prompts && prompts.length === 0 && <div className="empty">暂无提示词——把高频指令（如「给当前项目生成周报并分析成本偏差」）固化为一键按钮</div>}
          {prompts?.map((p) => (
            <div key={p.id} className="set-row">
              <span className="lab">{p.title}<small>{p.content.length > 60 ? `${p.content.slice(0, 60)}…` : p.content}</small></span>
              <button type="button" className={`switch ${p.enabled ? 'on' : ''}`} role="switch" aria-checked={Boolean(p.enabled)} aria-label={`启用 ${p.title}`}
                onClick={() => togglePrompt(p)} />
              <button className="mini" title="编辑" onClick={() => setPEdit({ ...p })}><IconPencil size={12} stroke={1.8} /></button>
              {pDel === p.id
                ? <><button className="mini danger" onClick={() => removePrompt(p.id)}>确认删除</button><button className="mini" onClick={() => setPDel(null)}>取消</button></>
                : <button className="mini" title="删除" onClick={() => setPDel(p.id)}><IconTrash size={12} stroke={1.8} /></button>}
            </div>
          ))}
          <small style={{ color: 'var(--ink3)' }}>启用项显示在 AI 助手输入框上方（点击填入，可再编辑后发送）；按 sort 升序排列</small>
        </div>
      </div>

      {/* I 区：新建/编辑提示词 Modal */}
      {pEdit && (
        <Modal title={pEdit.id ? '编辑提示词' : '新建提示词'} onClose={() => setPEdit(null)} width={520}
          footer={<><button onClick={() => setPEdit(null)}>取消</button><button className="pri" onClick={savePrompt}>保存</button></>}>
          <Field label="标题（≤30 字，按钮文案）">
            <input value={pEdit.title} maxLength={30} autoFocus onChange={(e) => setPEdit((d) => ({ ...d, title: e.target.value }))} placeholder="如：周报成本分析" />
          </Field>
          <Field label="提示词内容（≤2000 字，点击按钮填入输入区）">
            <textarea style={{ width: '100%', minHeight: 100 }} maxLength={2000} value={pEdit.content}
              onChange={(e) => setPEdit((d) => ({ ...d, content: e.target.value }))}
              placeholder="给当前项目生成周报，重点分析成本偏差根因与纠偏方案" />
          </Field>
          <Field label="排序（小者靠前）">
            <input type="number" style={{ width: 90 }} value={pEdit.sort ?? 0} onChange={(e) => setPEdit((d) => ({ ...d, sort: Number(e.target.value) }))} />
          </Field>
        </Modal>
      )}
    </div>
  );
}
