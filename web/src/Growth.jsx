import React, { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { IconRefresh, IconFileText } from '@tabler/icons-react';
import { toast } from './ui.jsx';
import { api } from './api.js';

// P3 成长路径：ECharts 雷达（29指标/17领域双视图，目标级要求线）+ 等级轨 + F3 重算 + 任务
// R2.3：成长闭环链（差距→训练→闭环）+ 月报生成/飞书推送
// R6.7：图表配色随主题令牌（读 CSS 变量，pm-theme 切换事件重绘）
const LVN = { 1: '辅助人员', 2: '初级', 3: '中级', 4: '高级', 5: '专家级' };
const LINK_ST = { open: '差距', trained: '训练中', closed: '已闭环' };
const cssv = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const withAlpha = (hex, a) => {
  const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex;
};

export default function Growth() {
  const [scores, setScores] = useState(null);
  const [history, setHistory] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [links, setLinks] = useState(null);
  const [report, setReport] = useState(null);     // 月报 markdown
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState(null);
  const [radarView, setRadarView] = useState('competency');   // competency | knowledge
  const radarRef = useRef(null);
  const chartRef = useRef(null);
  const trendRef = useRef(null);        // R4.3 WP6 三维等级历史趋势
  const trendChartRef = useRef(null);

  useEffect(() => { load(); }, []);
  useEffect(() => { if (scores) drawRadar(); }, [scores, radarView]);
  useEffect(() => { if (history.length > 0) drawTrend(); }, [history]);
  // R6.7：主题切换时双图重绘（配色取自最新令牌）
  useEffect(() => {
    const fn = () => { if (scores) drawRadar(); if (history.length > 0) drawTrend(); };
    window.addEventListener('pm-theme', fn);
    return () => window.removeEventListener('pm-theme', fn);
  }, [scores, history]);

  // R4.3 WP6：三维等级 + composite 随月度重算的历史趋势（纯展示，读现有 /api/v2/growth/history）
  function drawTrend() {
    if (!trendRef.current) return;
    if (!trendChartRef.current) trendChartRef.current = echarts.init(trendRef.current);
    const rows = history.slice(-12);
    const ts = rows.map((h) => String(h.created_at ?? '').slice(0, 10));
    const mk = (key) => rows.map((h) => h[key]);
    trendChartRef.current.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['知识 K', '素质 C', '经验 E', '综合 L'], bottom: 0, textStyle: { color: cssv('--text-2'), fontSize: 11 } },
      grid: { left: 34, right: 12, top: 14, bottom: 46 },
      xAxis: { type: 'category', data: ts, axisLabel: { color: cssv('--text-2'), fontSize: 10 } },
      yAxis: { type: 'value', min: 1, max: 5, interval: 1, axisLabel: { color: cssv('--text-2'), fontSize: 10, formatter: (v) => `L${v}` }, splitLine: { lineStyle: { color: cssv('--line') } } },
      series: [
        { name: '知识 K', type: 'line', data: mk('k_level'), step: 'middle', lineStyle: { color: cssv('--accent-2'), width: 2 }, itemStyle: { color: cssv('--accent-2') } },
        { name: '素质 C', type: 'line', data: mk('c_level'), step: 'middle', lineStyle: { color: cssv('--cin'), width: 2 }, itemStyle: { color: cssv('--cin') } },
        { name: '经验 E', type: 'line', data: mk('e_level'), step: 'middle', lineStyle: { color: cssv('--ok'), width: 2 }, itemStyle: { color: cssv('--ok') } },
        { name: '综合 L', type: 'line', data: mk('composite_level'), step: 'middle', lineStyle: { color: cssv('--warn'), width: 2.5, type: 'dashed' }, itemStyle: { color: cssv('--warn') }, symbolSize: 5 },
      ],
    }, true);
  }

  async function load() {
    setProfile(await api.get('/api/v2/profile'));
    setScores(await api.get('/api/v2/growth/scores'));
    setHistory(await api.get('/api/v2/growth/history'));
    setTasks(await api.get('/api/v2/drill/tasks'));
    setLinks(await api.get('/api/v2/growth/links'));
  }
  async function recalc() {
    setBusy(true);
    const r = await api.post('/api/v2/growth/recalc');
    setScores(r); await load(); setBusy(false);
  }
  async function genReport() {
    setBusy(true);
    const r = await fetch('/api/v2/growth/monthly-report', { method: 'POST' }).then((r) => r.json());
    setReport(r.report?.markdown ?? null);
    if (r.error) toast(r.error, 'err');
    setBusy(false);
  }
  async function pushReport() {
    if (!report) return;
    setBusy(true);
    const r = await fetch('/api/v2/feishu/export-doc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `PM-Master 成长月报 ${new Date().toISOString().slice(0, 10)}`, markdown: report }),
    }).then((r) => r.json());
    if (r.url) window.open(r.url, '_blank'); else toast(r.message ?? '推送失败', 'err');
    setBusy(false);
  }
  async function toggleTask(id, status) {
    await api.post(`/api/v2/drill/tasks/${id}/status`, { status: status === 'open' ? 'done' : 'open' });
    load();
  }

  function drawRadar() {
    if (!radarRef.current) return;
    if (!chartRef.current) chartRef.current = echarts.init(radarRef.current);
    const g = scores;

    let names, cur, reqLine;
    if (radarView === 'competency') {
      const entries = Object.entries(g.cDetails);            // 29 指标（环境→个人→技术顺序即 YAML 定义序）
      names = entries.map(([, v]) => v.name);
      cur = entries.map(([, v]) => +(v.score * 100).toFixed(0));
      reqLine = entries.map(([, v]) => (v.required ? 70 : 0)); // 目标级要求项 70 及格线；非要求项不画（0）
    } else {
      const entries = Object.entries(g.kDetails);            // 17 领域
      names = entries.map(([k]) => k);
      cur = entries.map(([, v]) => +(v * 100).toFixed(0));
      reqLine = names.map(() => 70);
    }

    chartRef.current.setOption({
      tooltip: { trigger: 'item' },
      legend: { data: ['当前证据分', '目标级要求线'], bottom: 0, textStyle: { color: cssv('--text-2'), fontSize: 11 } },
      radar: {
        indicator: names.map((n) => ({ name: n, max: 100 })),
        radius: '64%', center: ['50%', '48%'],
        axisName: { color: cssv('--text-2'), fontSize: 10 },
        splitArea: { areaStyle: { color: [cssv('--surface'), cssv('--surface-2')] } },
        splitLine: { lineStyle: { color: cssv('--line') } },
        axisLine: { lineStyle: { color: cssv('--line') } },
      },
      series: [{
        type: 'radar',
        data: [
          { value: reqLine, name: '目标级要求线', lineStyle: { color: cssv('--hair'), type: 'dashed' }, areaStyle: { color: withAlpha(cssv('--hair'), .15) }, symbol: 'none' },
          { value: cur, name: '当前证据分', lineStyle: { color: cssv('--cin'), width: 2 }, areaStyle: { color: withAlpha(cssv('--cin'), .13) }, itemStyle: { color: cssv('--cin') }, symbolSize: 3 },
        ],
      }],
    }, true);
  }
  useEffect(() => {
    const onResize = () => { chartRef.current?.resize(); trendChartRef.current?.resize(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const dims = scores ? [
    { name: `知识 K（L${scores.k_level}）`, v: scores.K },
    { name: `素质 C（L${scores.c_level}）`, v: scores.C },
    { name: `经验 E（L${scores.e_level}）`, v: scores.E },
  ] : [];

  return (
    <div className="split" style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 14, height: '100%', overflow: 'auto' }}>
      <div className="card">
        <h3>
          能力雷达（对照 GB/T 41831 目标级要求）
          <span style={{ float: 'right', display: 'flex', gap: 6 }}>
            <button className={`mini ${radarView === 'competency' ? 'pri' : ''}`} onClick={() => setRadarView('competency')}>29 指标</button>
            <button className={`mini ${radarView === 'knowledge' ? 'pri' : ''}`} onClick={() => setRadarView('knowledge')}>17 领域</button>
          </span>
        </h3>
        {profile && (
          <div style={{ display: 'flex', gap: 6, margin: '4px 0 8px' }}>
            {[1, 2, 3, 4, 5].map((lv) => {
              const cur = scores?.composite ?? profile.current_level;
              return (
                <div key={lv} style={{
                  flex: 1, textAlign: 'center', padding: '5px 0', borderRadius: 'var(--r-sm)',
                  background: lv < cur ? 'var(--ok-soft)' : lv === cur ? 'var(--accent)' : 'var(--surface-2)',
                  color: lv === cur ? 'var(--on-accent)' : lv < cur ? 'var(--ok)' : 'var(--ink3)',
                  fontSize: 11, fontWeight: lv === cur ? 700 : 400,
                }}>L{lv} {LVN[lv]}{lv === cur ? ' ←' : ''}</div>
              );
            })}
          </div>
        )}
        <div ref={radarRef} style={{ height: 400 }} />
        <small style={{ color: 'var(--ink3)' }}>
          {radarView === 'competency'
            ? '素质 29 指标：实线=行为证据聚合分；虚线=目标级要求项及格线 70（非要求项不画线）。分数随教练会话 E 评定与机读分自动上升。'
            : '知识 17 领域：卡片 reps≥2 计掌握；深度要求读 gbt41831.yaml 深度矩阵。'}
        </small>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="card">
          <h3>三维合成（短板原则 min）
            <button className="mini pri" style={{ float: 'right' }} disabled={busy} onClick={recalc}>{busy ? '重算中…' : <><IconRefresh size={12}/> F3 月度重算</>}</button>
          </h3>
          {dims.map((d) => (
            <div key={d.name} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span>{d.name}</span><span style={{ fontFamily: 'monospace' }}>{(d.v * 100).toFixed(0)}/100</span>
              </div>
              <div className={`bar ${d.v > 0.8 ? 'ok' : d.v > 0.5 ? '' : 'warn'}`}>
                <i style={{ width: `${d.v * 100}%` }} />
              </div>
            </div>
          ))}
          {scores && <small style={{ color: 'var(--ink3)' }}>E 维 = 硬指标满足率 {scores.met}/{scores.total_reqs}（成长记录页更新现值）</small>}
          {history.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div ref={trendRef} style={{ height: 190 }} />
              {history.slice(-5).map((h) => (
                <div key={h.id} style={{ display: 'flex', gap: 10, fontSize: 12, color: 'var(--ink3)' }}>
                  <span>{h.created_at?.slice(5, 16)}</span>
                  <span>K{h.k_level}·C{h.c_level}·E{h.e_level} → <b style={{ color: 'var(--cin)' }}>L{h.composite_level}</b></span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3>成长闭环（差距 → 训练 → 闭环）
            <span style={{ float: 'right', display: 'flex', gap: 6 }}>
              <button className="mini" disabled={busy} onClick={genReport}>{busy ? '生成中…' : <><IconFileText size={12}/> 生成月报</>}</button>
              <button className="mini pri" disabled={busy || !report} onClick={pushReport}>推送飞书</button>
            </span>
          </h3>
          {report
            ? <pre style={{ maxHeight: 150, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--paper)', padding: 8, borderRadius: 'var(--r-sm)' }}>{report}</pre>
            : links && (
              <>
                <div style={{ display: 'flex', gap: 8, margin: '2px 0 8px' }}>
                  {[['全部', links.total, 'var(--ink)'], ['差距', links.open, 'var(--warn)'], ['训练中', links.trained, 'var(--navy)'], ['已闭环', links.closed, 'var(--ok)']].map(([n, v, c]) => (
                    <div key={n} style={{ flex: 1, textAlign: 'center', padding: '6px 0', background: 'var(--paper)', borderRadius: 'var(--r-sm)' }}>
                      <b style={{ fontSize: 17, color: c }}>{v}</b>
                      <div style={{ fontSize: 10.5, color: 'var(--ink3)' }}>{n}</div>
                    </div>
                  ))}
                  <div style={{ flex: 1, textAlign: 'center', padding: '6px 0', background: 'var(--paper)', borderRadius: 'var(--r-sm)' }}>
                    <b style={{ fontSize: 17, color: 'var(--cin)' }}>{links.closure_rate == null ? '-' : `${Math.round(links.closure_rate * 100)}%`}</b>
                    <div style={{ fontSize: 10.5, color: 'var(--ink3)' }}>闭环率</div>
                  </div>
                </div>
                <div style={{ maxHeight: 150, overflow: 'auto' }}>
                  {links.items.slice(0, 12).map((l) => (
                    <div key={l.id} className="rowitem" style={{ padding: '3px 0' }}>
                      <span style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 'var(--r-xs)', color: 'var(--on-accent)',
                        background: l.status === 'closed' ? 'var(--ok)' : l.status === 'trained' ? 'var(--accent-2)' : 'var(--warn)',
                      }}>{LINK_ST[l.status]}</span>
                      <span style={{ flex: 1, fontSize: 12 }}>{l.label}</span>
                      {l.delta != null && <small style={{ color: l.delta >= 0 ? 'var(--ok)' : 'var(--warn)' }}>{l.delta >= 0 ? '↑' : '↓'}{Math.abs(Math.round(l.delta * 100))}</small>}
                    </div>
                  ))}
                </div>
                <small style={{ color: 'var(--ink3)' }}>训练信号来自教练归档（素质指标）/ 强化营复习与情景题 / 知识库实操≥60（知识域）；月度重算分数≥70 自动闭环。</small>
              </>
            )}
        </div>

        <div className="card" style={{ flex: 1, overflow: 'auto' }}>
          <h3>训练任务（grow-planner · 差距驱动）</h3>
          {tasks.length === 0 && <small style={{ color: 'var(--ink3)' }}>先跑一次 F3 重算，弱项将自动生成训练任务</small>}
          {tasks.map((t) => (
            <div key={t.id} className="rowitem">
              <input type="checkbox" checked={t.status === 'done'} onChange={() => toggleTask(t.id, t.status)} />
              <div style={{ flex: 1 }}>
                <b style={{ textDecoration: t.status === 'done' ? 'line-through' : 'none', fontSize: 12.5 }}>{t.title}</b>
                <small>{t.type} · {t.indicator_id ?? '-'} · {t.source}</small>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
