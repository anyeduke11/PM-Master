import React, { useEffect, useState } from 'react';
import { IconBulb, IconPlus, IconUpload } from '@tabler/icons-react';
import { toast, Modal, Field } from './ui.jsx';
import Import from './Import.jsx';

// P2 项目工作台：项目列表 + 四件套（周报/风险/干系人/会议）+ 容差预警黄金闭环
// R2.4：W1.3 智能关联提示卡（新风险/超容差时工具提示）+ W3.3 组合视角 tab
export default function Workbench({ goCoach, onContext, importPrefill }) {
  const [projects, setProjects] = useState([]);
  const [pid, setPid] = useState(null);
  const [tab, setTab] = useState('weekly');
  const [busy, setBusy] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [hints, setHints] = useState(null);        // W1.3 提示卡（[{text, tools:[{id,name}]}]）
  const [portfolio, setPortfolio] = useState(null); // W3.3 组合视图
  const [benefitDraft, setBenefitDraft] = useState({});  // R3.3 收益填写草稿 {pid: {target, actual}}
  const [benefitErr, setBenefitErr] = useState(null);    // R3.3 收益保存失败提示（fail loud）

  const [weekly, setWeekly] = useState(null);      // {markdown, evm}
  const [evmIn, setEvmIn] = useState({ pv: 420, ev: 398, ac: 458 });
  const [risks, setRisks] = useState([]);
  const [stakes, setStakes] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [forms, setForms] = useState({ risk: '', stake: '', meeting: '', action: '' });
  const [showNew, setShowNew] = useState(false);      // 新建项目 Modal
  const [newName, setNewName] = useState('');
  const [soOut, setSoOut] = useState(null);           // 二阶推演结果 Modal
  const [showImport, setShowImport] = useState(false); // R7.0 P2 数据流入向导
  const [importDraft, setImportDraft] = useState(null); // R7.0 P5 飞书读入预填草稿 {seq, text}

  useEffect(() => { loadProjects(); loadAlerts(); }, []);
  // R7.0 P5：App 事件桥传来的飞书草稿 → 自动开导向并预填（seq 变化即重挂载）
  useEffect(() => { if (importPrefill) { setImportDraft(importPrefill); setShowImport(true); } }, [importPrefill]);
  useEffect(() => { if (pid) loadAll(pid); }, [pid]);
  useEffect(() => { if (pid) onContext?.({ project_id: pid }); }, [pid]);   // 上报助手页面上下文
  useEffect(() => { if (tab === 'combo' && !portfolio) loadPortfolio(); }, [tab]);

  async function loadProjects() {
    const ps = await fetch('/api/projects').then((r) => r.json());
    setProjects(ps);
    if (!pid && ps.length) setPid(ps[0].id);
  }
  async function loadAlerts() { setAlerts(await fetch('/api/alerts').then((r) => r.json())); }
  async function loadPortfolio() {
    const d = await fetch('/api/portfolio').then((r) => r.json());
    setPortfolio(d);
    setBenefitDraft(Object.fromEntries(d.items.map((p) => [p.id, {
      target: p.benefit?.target ?? '', actual: p.benefit?.actual ?? '',
    }])));
  }
  // R3.3 收益填写（空串→null 清空；服务端数字校验）
  async function saveBenefit(id) {
    const dft = benefitDraft[id] ?? {};
    const res = await fetch(`/api/projects/${id}/benefit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ benefit_target: dft.target, benefit_actual: dft.actual }),
    });
    if (!res.ok) { setBenefitErr('收益保存失败（须为数字）'); return; }
    setBenefitErr(null);
    loadPortfolio();
  }
  async function loadAll(id) {
    const arts = await fetch(`/api/projects/${id}/artifacts`).then((r) => r.json());
    setWeekly(arts[0] ?? null);
    setRisks(await fetch(`/api/projects/${id}/risks`).then((r) => r.json()));
    setStakes(await fetch(`/api/projects/${id}/stakeholders`).then((r) => r.json()));
    setMeetings(await fetch(`/api/projects/${id}/meetings`).then((r) => r.json()));
    loadAlerts();
  }

  // 新建项目（Modal 表单提交；payload 与原 prompt 版一致）
  async function createProject() {
    const name = newName.trim(); if (!name) return;
    const p = await fetch('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, complexity: 'complex' }),
    }).then((r) => r.json());
    setShowNew(false); setNewName('');
    await loadProjects(); setPid(p.id);
  }

  async function genWeekly() {
    setBusy(true);
    const d = await fetch(`/api/projects/${pid}/weekly`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evmIn),
    }).then((r) => r.json());
    setWeekly({ id: d.id, content: d.markdown, evm: d.evm });
    setHints(d.hints?.length ? d.hints : null);   // W1.3：超容差 → 根因工具提示
    await loadAlerts(); setBusy(false);
  }

  // 回写飞书（P3 写回）；未配置凭据 → 降级下载 .md
  async function exportFeishu() {
    if (!weekly?.content) return;
    setBusy(true);
    const st = await fetch('/api/feishu/status').then((r) => r.json());
    if (st.configured) {
      const r = await fetch('/api/feishu/export-doc', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `${proj?.name ?? '项目'} 周报 · ${new Date().toISOString().slice(0, 10)}`, markdown: weekly.content }),
      }).then((r) => r.json());
      if (r.url) { window.open(r.url, '_blank'); setBusy(false); return; }
      toast(`回写失败：${r.message ?? '未知错误'}`, 'err');
    } else {
      const blob = new Blob([weekly.content], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `周报-${proj?.name ?? '项目'}-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      toast('飞书未配置（.env 填 FEISHU_APP_ID/SECRET 后可直接回写云文档），已降级下载 .md', 'warn');
    }
    setBusy(false);
  }

  async function addRisk() {
    if (!forms.risk.trim()) return;
    const d = await fetch(`/api/projects/${pid}/risks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: forms.risk, probability: 0.5, impact: 0.7, strategy: '减轻(PMP)×风险应对(PR2)' }),
    }).then((r) => r.json());
    setHints(d.hints?.length ? d.hints : null);   // W1.3：新风险 → 定量分析工具提示
    setForms({ ...forms, risk: '' }); loadAll(pid);
  }
  async function secondOrder(id) {
    setBusy(true);
    const r = await fetch(`/api/risks/${id}/second-order`, { method: 'POST' }).then((r) => r.json());
    setSoOut(r);   // 结果进 Modal 展示
    setBusy(false); loadAll(pid);
  }
  async function toIssue(id) {
    await fetch(`/api/risks/${id}/to-issue`, { method: 'POST' }); loadAll(pid);
  }
  async function addStake() {
    if (!forms.stake.trim()) return;
    await fetch(`/api/projects/${pid}/stakeholders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: forms.stake, power: 8, interest: 3, current_engagement: '中立', desired_engagement: '支持' }),
    });
    setForms({ ...forms, stake: '' }); loadAll(pid);
  }
  async function addMeeting() {
    if (!forms.meeting.trim()) return;
    const actions = forms.action.trim()
      ? [{ title: forms.action, owner: '我', due_date: '2026-10-15' }] : [];
    await fetch(`/api/projects/${pid}/meetings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: forms.meeting, actions }),
    });
    setForms({ ...forms, meeting: '', action: '' }); loadAll(pid);
  }
  async function toggleAction(id, status) {
    const d = await fetch(`/api/actions/${id}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status === 'done' ? 'open' : 'done' }),
    }).then((r) => r.json());
    loadAll(pid);
  }
  async function ackAlert(id) {
    await fetch(`/api/alerts/${id}/ack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"status":"acknowledged"}',
    });
    loadAlerts();
  }

  const proj = projects.find((p) => p.id === pid);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 14, height: '100%' }}>
      <div className="card" style={{ overflow: 'auto' }}>
        <h3>在管项目 <button className="mini" onClick={() => setShowImport(true)} title="数据流入：粘贴导入 EVM/风险/会议/干系人"><IconUpload size={13} stroke={1.8} /></button><button className="mini" onClick={() => setShowNew(true)} title="新建项目"><IconPlus size={14} stroke={2} /></button></h3>
        {projects.map((p) => (
          <div key={p.id} className={`sc ${pid === p.id ? 'sel' : ''}`} onClick={() => setPid(p.id)}>
            <b>{p.name}</b><small>{p.complexity} · 容差 {JSON.parse(p.tolerances ?? '{}').cost * 100 ?? '-'}%</small>
          </div>
        ))}
        <h3 style={{ marginTop: 12 }}>开放预警 {alerts.length ? <span className="badge cnt-err">{alerts.length}</span> : ''}</h3>
        {alerts.map((a) => (
          <div key={a.id} className="alert-mini">
            <b>{a.project_name} · {a.dimension}</b>
            <small>{a.message}</small>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="mini pri" onClick={() => goCoach('exception')}>进入例外教练</button>
              <button className="mini" onClick={() => ackAlert(a.id)}>知悉</button>
            </div>
          </div>
        ))}
        {!alerts.length && <small style={{ color: 'var(--ink3)' }}>容差内</small>}
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="growbar" style={{ marginBottom: 12 }}>
          {[['weekly', '周报'], ['risks', `风险${risks.length || ''}`], ['stake', '干系人'], ['meet', '会议'], ['combo', '组合视角']].map(([k, l]) => (
            <button key={k} className={`gseg ${tab === k ? 'cur' : ''}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {hints?.length > 0 && tab !== 'combo' && (
          <div className="notice">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconBulb size={14} stroke={1.8} />{hints[0].text}</span>
            {hints[0].tools.map((t) => (
              <button key={t.id} className="mini" style={{ marginLeft: 6 }} onClick={() => setHints(null)} title="可到知识库页用教学模式学习">
                {t.name}
              </button>
            ))}
            <button className="mini" style={{ float: 'right' }} onClick={() => setHints(null)}>×知悉</button>
          </div>
        )}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {tab === 'weekly' && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
                {['pv', 'ev', 'ac'].map((k) => (
                  <label key={k} style={{ fontSize: 12 }}>{k.toUpperCase()}
                    <input style={{ width: 64, marginLeft: 4 }} type="number" value={evmIn[k]}
                      onChange={(e) => setEvmIn({ ...evmIn, [k]: Number(e.target.value) })} />
                  </label>
                ))}
                <button className="pri" style={{ marginLeft: 'auto' }} disabled={busy} onClick={genWeekly}>
                  {busy ? '生成中…' : '生成周报（LLM+容差引擎）'}
                </button>
                <button disabled={busy || !weekly?.content} onClick={exportFeishu} title="写入飞书云文档；未配置则下载 .md">回写飞书</button>
              </div>
              {weekly?.evm && (
                <div style={{ fontSize: 12, marginBottom: 8, color: 'var(--ink3)' }}>
                  SPI {weekly.evm.spi} · CPI <b style={{ color: weekly.evm.cpi < 0.9 ? 'var(--cin)' : 'var(--ok)' }}>{weekly.evm.cpi}</b> · CV {weekly.evm.cv}
                </div>
              )}
              {weekly?.content
                ? <pre style={{ minHeight: 300 }}>{weekly.content}</pre>
                : <div className="empty" style={{ minHeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>（尚未生成）</div>}
            </div>
          )}
          {tab === 'risks' && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input style={{ flex: 1 }} placeholder="新风险，如：核心工程师离职" value={forms.risk}
                  onChange={(e) => setForms({ ...forms, risk: e.target.value })} />
                <button className="pri" onClick={addRisk}>登记</button>
              </div>
              {risks.map((r) => (
                <div key={r.id} className="rowitem">
                  <div style={{ flex: 1 }}>
                    <b>{r.is_issue ? '【已转问题】' : ''}{r.title}</b>
                    <small>P {r.probability} × I {r.impact} · {r.strategy ?? '未设策略'}</small>
                    {r.second_order && (
                      <small style={{ display: 'block', color: 'var(--navy)' }}>
                        二阶：{JSON.parse(r.second_order).second}
                      </small>
                    )}
                  </div>
                  <button className="mini" onClick={() => secondOrder(r.id)}>二阶推演</button>
                  {!r.is_issue && <button className="mini" onClick={() => toIssue(r.id)}>转问题</button>}
                </div>
              ))}
            </div>
          )}
          {tab === 'stake' && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input style={{ flex: 1 }} placeholder="干系人姓名/角色" value={forms.stake}
                  onChange={(e) => setForms({ ...forms, stake: e.target.value })} />
                <button className="pri" onClick={addStake}>添加</button>
              </div>
              {stakes.map((s) => (
                <div key={s.id} className="rowitem">
                  <b style={{ flex: 1 }}>{s.name}</b>
                  <small>权力 {s.power}/10 · 利益 {s.interest}/10</small>
                  <span className="pill">{s.current_engagement} → {s.desired_engagement}</span>
                  {s.current_engagement !== s.desired_engagement && (
                    <button className="mini" onClick={() => goCoach('stakeholder_game')}>博弈训练</button>
                  )}
                </div>
              ))}
            </div>
          )}
          {tab === 'meet' && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <input style={{ flex: 1 }} placeholder="会议主题" value={forms.meeting}
                  onChange={(e) => setForms({ ...forms, meeting: e.target.value })} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input style={{ flex: 1 }} placeholder="行动项（可选）" value={forms.action}
                  onChange={(e) => setForms({ ...forms, action: e.target.value })} />
                <button className="pri" onClick={addMeeting}>记录</button>
              </div>
              {meetings.map((m) => (
                <div key={m.id} className="rowitem" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <b>{m.title} <small style={{ marginLeft: 8 }}>{m.held_at}</small></b>
                  {(m.actions ?? []).map((a) => (
                    <label key={a.id} style={{ display: 'flex', gap: 8, fontSize: 12.5, marginTop: 4, alignItems: 'center' }}>
                      <input type="checkbox" checked={a.status === 'done'} onChange={() => toggleAction(a.id, a.status)} />
                      <span style={{ textDecoration: a.status === 'done' ? 'line-through' : 'none', flex: 1 }}>{a.title}</span>
                      <small style={{ color: 'var(--ink3)' }}>{a.owner} · {a.due_date}</small>
                    </label>
                  ))}
                </div>
              ))}
              <small style={{ color: 'var(--ink3)' }}>行动项按期完成率 → 诚信与可靠 机读分（PRD 4.7.5）</small>
            </div>
          )}
          {tab === 'combo' && (
            <div>
              {!portfolio && <div className="sk-row"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>}
              {portfolio && (
                <>
                  <div className="kpi-row">
                    {[['在管项目', portfolio.summary.projects], ['开放风险', portfolio.summary.open_risks], ['高危风险', portfolio.summary.high_risks], ['越界预警', portfolio.summary.open_alerts], ['资源冲突', portfolio.summary.resource_conflicts]].map(([n, v]) => (
                      <div key={n} className="kpi">
                        <b style={{ color: n.includes('高危') || n.includes('越界') ? 'var(--warn)' : undefined }}>{v}</b>
                        <span>{n}</span>
                      </div>
                    ))}
                  </div>
                  <b style={{ fontSize: 13 }}>跨项目风险热力（可能性 × 影响，三档）</b>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: 4, margin: '6px 0 12px', fontSize: 11 }}>
                    <span />
                    {['可能性 低', '可能性 中', '可能性 高'].map((h) => <b key={h} style={{ textAlign: 'center', color: 'var(--ink3)' }}>{h}</b>)}
                    {[['影响 高', 0], ['影响 中', 1], ['影响 低', 2]].map(([label, ti]) => (
                      <React.Fragment key={label}>
                        <b style={{ display: 'flex', alignItems: 'center', color: 'var(--ink3)' }}>{label}</b>
                        {[0, 1, 2].map((pi) => {
                          const list = portfolio.heat[ti][pi];
                          const lvl = ti + pi;   // 越靠右上越热
                          return (
                            <div key={pi} style={{
                              minHeight: 56, borderRadius: 6, padding: 4,
                              background: lvl >= 3 ? 'var(--danger-soft)' : lvl === 2 ? 'var(--warn-soft)' : 'var(--surface-2)',
                            }}>
                              {list.length === 0
                                ? <span style={{ color: 'var(--ink3)' }}>—</span>
                                : list.map((r, i) => (
                                  <div key={i} style={{ lineHeight: 1.5 }} title={`${r.project_name} · P${r.probability}×I${r.impact}`}>
                                    {r.is_issue && <span style={{ color: 'var(--warn)' }}>!</span>} {r.title.slice(0, 12)}<small style={{ color: 'var(--ink3)' }}>（{r.project_name}）</small>
                                  </div>
                                ))}
                            </div>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </div>
                  <b style={{ fontSize: 13 }}>资源冲突热力（涉及项目数 × 开放行动项，三档）</b>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: 4, margin: '6px 0 4px', fontSize: 11 }}>
                    <span />
                    {['行动项 ≤1', '行动项 2-4', '行动项 ≥5'].map((h) => <b key={h} style={{ textAlign: 'center', color: 'var(--ink3)' }}>{h}</b>)}
                    {[['≥3 项目', 2], ['2 项目', 1], ['单项目', 0]].map(([label, ti]) => (
                      <React.Fragment key={label}>
                        <b style={{ display: 'flex', alignItems: 'center', color: 'var(--ink3)' }}>{label}</b>
                        {[0, 1, 2].map((pi) => {
                          const list = portfolio.resource_conflicts.heat[ti][pi];
                          const lvl = ti + pi;   // 越靠右上越热
                          return (
                            <div key={pi} style={{
                              minHeight: 48, borderRadius: 6, padding: 4,
                              background: lvl >= 3 ? 'var(--danger-soft)' : lvl === 2 ? 'var(--warn-soft)' : 'var(--surface-2)',
                            }}>
                              {list.length === 0
                                ? <span style={{ color: 'var(--ink3)' }}>—</span>
                                : list.map((r, i) => (
                                  <div key={i} style={{ lineHeight: 1.5 }} title={`${r.projects.join('、')} · 开放 ${r.open_actions} / 完成 ${r.done_actions}${r.high_power ? ` · 高权力干系人 ${r.high_power}` : ''}`}>
                                    {r.project_count >= 2 && <span style={{ color: 'var(--warn)' }}>!</span>} {r.name}<small style={{ color: 'var(--ink3)' }}>（{r.project_count}项目·{r.open_actions}开放）</small>
                                  </div>
                                ))}
                            </div>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </div>
                  <small style={{ display: 'block', margin: '4px 0 12px', color: 'var(--ink3)' }}>{portfolio.resource_conflicts.note}</small>
                  <b style={{ fontSize: 13 }}>收益一览（已填 {portfolio.benefit.filled}/{portfolio.benefit.total}）</b>
                  <table className="tb" style={{ margin: '6px 0 4px' }}>
                    <thead><tr>
                      <th>项目</th><th>目标</th><th>实绩</th><th>达成率</th><th /></tr></thead>
                    <tbody>
                      {portfolio.items.map((p) => (
                        <tr key={p.id}>
                          <td><b>{p.name}</b></td>
                          <td><input type="number" style={{ width: 72, padding: '2px 5px', fontSize: 11.5 }} value={benefitDraft[p.id]?.target ?? ''}
                            onChange={(e) => setBenefitDraft((d) => ({ ...d, [p.id]: { ...d[p.id], target: e.target.value } }))} /></td>
                          <td><input type="number" style={{ width: 72, padding: '2px 5px', fontSize: 11.5 }} value={benefitDraft[p.id]?.actual ?? ''}
                            onChange={(e) => setBenefitDraft((d) => ({ ...d, [p.id]: { ...d[p.id], actual: e.target.value } }))} /></td>
                          <td>{p.benefit
                            ? (p.benefit.rate != null ? `${(p.benefit.rate * 100).toFixed(0)}%` : '-')
                            : <span style={{ color: 'var(--ink3)' }}>近似：产物 {p.artifact_count} · CPI {p.cpi ?? '-'}</span>}</td>
                          <td><button className="mini" onClick={() => saveBenefit(p.id)}>保存</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {benefitErr && <div style={{ color: 'var(--cin)', fontSize: 11.5 }}>{benefitErr}</div>}
                  <small style={{ color: 'var(--ink3)' }}>{portfolio.benefit.note}</small>
                  <b style={{ fontSize: 13, display: 'block', marginTop: 12 }}>项目健康一览</b>
                  <table className="tb" style={{ marginTop: 6 }}>
                    <thead><tr>
                      <th>项目</th><th>复杂度</th><th>开放风险</th><th>高危</th><th>越界</th><th>最新CPI</th><th>产物</th>
                    </tr></thead>
                    <tbody>
                      {portfolio.items.map((p) => (
                        <tr key={p.id}>
                          <td><b>{p.name}</b></td>
                          <td><span className="pill">{p.complexity}</span></td>
                          <td>{p.risk_total}</td>
                          <td style={{ color: p.risk_high ? 'var(--warn)' : undefined }}>{p.risk_high || '-'}</td>
                          <td style={{ color: p.alert_count ? 'var(--warn)' : undefined }}>{p.alert_count || '-'}</td>
                          <td className="mono" style={{ color: p.cpi != null && p.cpi < 0.9 ? 'var(--warn)' : undefined }}>{p.cpi ?? '-'}</td>
                          <td>{p.artifact_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <small style={{ display: 'block', marginTop: 8, color: 'var(--ink3)' }}>
                    R3.3 口径：收益以填写值（目标/实绩）为准，未填项目回退「产物量+EVM 现值」近似；资源冲突 v1 按资源名字符串匹配（未规范化）；热力供组合治理与 portfolio 场景训练。
                  </small>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 新建项目 Modal（替代原 prompt） */}
      {showNew && (
        <Modal title="新建项目" onClose={() => setShowNew(false)} width={380}
          footer={<>
            <button onClick={() => setShowNew(false)}>取消</button>
            <button className="pri" disabled={!newName.trim()} onClick={createProject}>创建</button>
          </>}>
          <Field label="项目名称">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="项目名称" autoFocus />
          </Field>
        </Modal>
      )}

      {/* 二阶推演结果 Modal（替代原 alert 长文本） */}
      {soOut && (
        <Modal title="二阶推演微训练" onClose={() => setSoOut(null)} width={520}
          footer={<button className="pri" onClick={() => setSoOut(null)}>关闭</button>}>
          <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
            <div><b>一阶</b>：{soOut.first}</div>
            <div><b>二阶</b>：{soOut.second}</div>
            <div><b>三阶</b>：{soOut.third}</div>
            <div className="notice" style={{ marginBottom: 0 }}>{soOut.question}</div>
          </div>
        </Modal>
      )}

      {/* R7.0 P2 数据流入向导；EVM 导入命中当前项目 → 预填周报输入框（黄金闭环入口） */}
      {/* R7.0 P5：飞书读入经 pm-import-prefill 事件预填 text；seq 作 key 强制重挂载刷新草稿 */}
      {showImport && (
        <Import key={importDraft?.seq ?? 0} initialText={importDraft?.text ?? ''} onClose={() => { setShowImport(false); setImportDraft(null); }} onDone={({ kind, rows, result }) => {
          loadProjects();
          if (pid) loadAll(pid);
          if (kind === 'evm') {
            const hit = result.results.find((x) => x.ok && x.project_id === pid);
            const row = hit && rows[hit.i];
            if (row) { setEvmIn({ pv: Number(row.pv), ev: Number(row.ev), ac: Number(row.ac) }); setTab('weekly'); }
          }
        }} />
      )}
    </div>
  );
}
