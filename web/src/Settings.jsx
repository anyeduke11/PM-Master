import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IconSettings, IconRobot, IconChartDots3, IconToggleLeft, IconExternalLink } from '@tabler/icons-react';
import { toast } from './ui.jsx';

// R7.0 P1 设置中心：A 系统状态 / B LLM 与模型（热切换）/ C 可观测性 / E 功能开关
// 左锚点导航 + 右分区卡片；窄屏导航横滚、单列堆叠（CSS 断点处理）
const SECTIONS = [
  ['sys', '系统状态', IconSettings],
  ['llm', 'LLM 与模型', IconRobot],
  ['obs', '可观测性', IconChartDots3],
  ['feature', '功能开关', IconToggleLeft],
];

const SRC_LABEL = { db: 'DB 覆盖', env: 'env', default: '默认' };

export default function Settings() {
  const [sec, setSec] = useState('sys');
  const [system, setSystem] = useState(null);
  const [settings, setSettings] = useState(null);   // 全量白名单视图
  const [stats, setStats] = useState(null);
  const [days, setDays] = useState(30);
  const [purpose, setPurpose] = useState('');
  const [draft, setDraft] = useState({});           // B/E 区编辑草稿 {key: value}
  const [saving, setSaving] = useState(false);
  const refs = useRef({});

  async function j(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message ?? `HTTP ${r.status}`);
    return r.json();
  }
  async function loadAll() {
    try {
      const [sys, set, st] = await Promise.all([
        j('/api/settings/system'), j('/api/settings'), j('/api/llm/stats'),
      ]);
      setSystem(sys); setSettings(set); setStats(st); setDraft({});
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
        {s.values.map((o) => <option key={o} value={o}>{o}</option>)}
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
        {s.source === 'db' && !dirty && s.group === 'llm' && (
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
          P2 起陆续开放：数据流入 / 工具频率 / 巡检简报 / 提示词库 / 蒸馏与记忆
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
      </div>
    </div>
  );
}
