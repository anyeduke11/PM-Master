import React, { useEffect, useState } from 'react';
import { IconPlus, IconRobot } from '@tabler/icons-react';
import { Modal, Field } from './ui.jsx';
import { api } from './api.js';

// W4 风险评估专项：三场景（GB/T 20984 / 金融数据安全 / 个人信息保护）
const SCN = {
  gb20984: { name: '信息安全风险评估', tag: 'GB/T 20984' },
  fin_data: { name: '金融数据安全评估', tag: 'JR/T 0223/0197' },
  pia: { name: '个人信息保护评估', tag: 'PIPL §55-56' },
};
const PHASES = [
  ['prep', '准备'], ['assets', '资产识别'], ['analysis', '风险分析'],
  ['treatment', '处置'], ['report', '报告'], ['review', '复盘'],
];
const LV_COLOR = { 低: 'var(--ok)', 中: 'var(--warn)', 高: 'var(--hot)', 严重: 'var(--cin)' };

export default function RA() {
  const [projects, setProjects] = useState([]);
  const [pid, setPid] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [extractText, setExtractText] = useState('');
  const [extractOut, setExtractOut] = useState(null);
  const [report, setReport] = useState(null);
  const [newAsset, setNewAsset] = useState({ name: '', type: '数据', confidentiality: 3, integrity: 3, availability: 3, data_level: '' });
  const [newFinding, setNewFinding] = useState({ asset_id: '', threat_desc: '', threat_freq: 3, vuln_desc: '', vuln_sev: 3, measures_existing: '' });
  const [showNew, setShowNew] = useState(false);      // 新建评估项目 Modal
  const [newProj, setNewProj] = useState({ name: '', scenario: 'fin_data', org: '' });

  useEffect(() => { load(); }, []);
  useEffect(() => { if (pid) loadDetail(pid); }, [pid]);

  async function load() {
    const ps = await api.get('/api/v2/ra/projects');
    setProjects(ps);
    if (!pid && ps.length) setPid(ps[0].id);
  }
  async function loadDetail(id) {
    setDetail(await api.get(`/api/v2/ra/projects/${id}`));
    setReport(null); setExtractOut(null);
  }
  // 新建评估项目（Modal 表单提交；payload 与原 prompt 版一致 {name, scenario, org}）
  async function create() {
    const name = newProj.name.trim(); if (!name) return;
    const p = await api.post('/api/v2/ra/projects', { name, scenario: newProj.scenario, org: newProj.org });
    setShowNew(false); setNewProj({ name: '', scenario: 'fin_data', org: '' });
    await load(); setPid(p.id);
  }
  async function setPhase(ph) {
    await api.post(`/api/v2/ra/projects/${pid}/phase`, { phase: ph });
    loadDetail(pid); load();
  }
  async function addAsset() {
    if (!newAsset.name.trim()) return;
    await api.post(`/api/v2/ra/projects/${pid}/assets`, { ...newAsset, data_level: newAsset.data_level || null });
    setNewAsset({ ...newAsset, name: '' }); loadDetail(pid); load();
  }
  async function addFinding() {
    if (!newFinding.threat_desc.trim()) return;
    await api.post(`/api/v2/ra/projects/${pid}/findings`, { ...newFinding, asset_id: newFinding.asset_id ? Number(newFinding.asset_id) : null });
    setNewFinding({ ...newFinding, threat_desc: '', vuln_desc: '', measures_existing: '' }); loadDetail(pid); load();
  }
  async function treat(id, patch) {
    await api.post(`/api/v2/ra/findings/${id}`, patch);
    loadDetail(pid); load();
  }
  async function doExtract() {
    if (extractText.trim().length < 20) return;
    setBusy(true);
    const out = await fetch(`/api/v2/ra/projects/${pid}/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: extractText }),
    }).then((r) => r.json());
    setExtractOut(out.statusCode ? { error: out.message } : out); setBusy(false);
  }
  async function confirmExtract() {
    // 人工确认后批量入库：先资产（建名字→id 映射），再风险项
    const map = {};
    for (const a of extractOut.assets ?? []) {
      const created = await api.post(`/api/v2/ra/projects/${pid}/assets`, { name: a.name, type: a.type, confidentiality: a.confidentiality, integrity: a.integrity, availability: a.availability, data_level: a.data_level ?? null });
      map[a.name] = created.id;
    }
    for (const f of extractOut.findings ?? []) {
      await api.post(`/api/v2/ra/projects/${pid}/findings`, { asset_id: map[f.asset_name] ?? null, threat_desc: f.threat_desc, threat_freq: f.threat_freq, vuln_desc: f.vuln_desc, vuln_sev: f.vuln_sev, measures_existing: f.measures_existing, extra: f.lawful ? { lawful: f.lawful, necessary: f.necessary, consent: f.consent } : (f.lifecycle ? { lifecycle: f.lifecycle } : null) });
    }
    setExtractOut(null); setExtractText(''); loadDetail(pid); load();
  }
  async function genReport() {
    setBusy(true);
    const out = await fetch(`/api/v2/ra/projects/${pid}/report`, { method: 'POST' }).then((r) => r.json());
    setReport(out.markdown ?? `生成失败：${out.message ?? ''}`);
    setBusy(false);
  }
  function exportReport() {
    if (!report) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([report], { type: 'text/markdown;charset=utf-8' }));
    a.download = `${detail.project.name}-评估报告.md`; a.click();
  }

  const p = detail?.project;
  return (
    <div className="split" style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 14, height: '100%' }}>
      <div className="card" style={{ overflow: 'auto' }}>
        <h3>评估项目 <button className="mini" onClick={() => setShowNew(true)} title="新建评估项目"><IconPlus size={14} stroke={2} /></button></h3>
        {projects.map((x) => (
          <div key={x.id} className={`sc ${pid === x.id ? 'sel' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setPid(x.id)}>
            <b>{x.name}</b>
            <small>{x.scenario_name} · 资产{x.asset_count} · 风险{x.finding_count}
              {x.high_count > 0 && <span style={{ color: 'var(--cin)' }}>（高/严重 {x.high_count}）</span>}
            </small>
          </div>
        ))}
        {!projects.length && <div className="empty">新建一个评估项目开始（三场景可选）</div>}
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--ink3)', lineHeight: 1.9 }}>
          <b>三场景</b><br />
          1 信息安全风险评估（GB/T 20984）<br />
          2 金融数据安全评估（JR/T 0223/0197）<br />
          3 个人信息保护评估（PIPL §55-56）
        </div>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        {!detail && <div className="empty">← 选择或新建评估项目</div>}
        {detail && (
          <div>
            <h3>{p.name} <span className="pill">{detail.scenario.name} · {detail.scenario.standard}</span></h3>

            {/* 阶段流 */}
            <div className="growbar" style={{ margin: '10px 0 14px' }}>
              {PHASES.map(([k, label], i) => {
                const cur = PHASES.findIndex(([pk]) => pk === p.phase);
                return (
                  <button key={k} className={`gseg ${i < cur ? 'done' : i === cur ? 'cur' : ''}`} onClick={() => setPhase(k)}>{label}</button>
                );
              })}
            </div>

            {/* 风险分布条 */}
            {detail.findings.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, fontSize: 12 }}>
                {Object.entries(detail.dist).map(([lv, n]) => (
                  <span key={lv} className="pill" style={{ borderColor: LV_COLOR[lv], color: LV_COLOR[lv] }}>{lv} {n}</span>
                ))}
                <small style={{ color: 'var(--ink3)', alignSelf: 'center' }}>可能性×影响 矩阵法（代码计算）</small>
              </div>
            )}

            {/* AI 抽取区 */}
            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <IconRobot size={14} stroke={1.8} />AI 识别抽取（粘贴资产清单/访谈纪要/系统文档）
              </summary>
              <textarea style={{ width: '100%', minHeight: 80, marginTop: 8, fontSize: 12.5 }} placeholder="粘贴资料…AI 将抽取资产（含 CIA/分级建议）与风险链候选，人工确认后入库"
                value={extractText} onChange={(e) => setExtractText(e.target.value)} />
              <button className="pri" disabled={busy || extractText.trim().length < 20} onClick={doExtract}>{busy ? '抽取中…' : '开始抽取'}</button>
              {extractOut?.error && <div className="notice danger" style={{ marginTop: 8 }}>{extractOut.error}</div>}
              {extractOut?.assets && (
                <div style={{ marginTop: 10 }}>
                  <small style={{ color: 'var(--ink3)' }}>{extractOut.summary}</small>
                  <div style={{ margin: '6px 0', fontSize: 12.5 }}><b>资产候选 {extractOut.assets.length}</b>（{extractOut.assets.map((a) => a.name).slice(0, 5).join('、')}…）</div>
                  <div style={{ fontSize: 12.5 }}><b>风险链候选 {extractOut.findings?.length ?? 0}</b></div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="pri" onClick={confirmExtract}>确认入库</button>
                    <button className="mini" onClick={() => setExtractOut(null)}>放弃</button>
                  </div>
                </div>
              )}
            </details>

            {/* 资产识别 */}
            <h3>资产识别（{detail.assets.length}）</h3>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              <input style={{ width: 140 }} placeholder="资产名称" value={newAsset.name} onChange={(e) => setNewAsset({ ...newAsset, name: e.target.value })} />
              <input style={{ width: 90 }} placeholder="类型" value={newAsset.type} onChange={(e) => setNewAsset({ ...newAsset, type: e.target.value })} />
              {[['confidentiality', 'C'], ['integrity', 'I'], ['availability', 'A']].map(([k, l]) => (
                <label key={k} style={{ fontSize: 11.5 }}>{l}
                  <select value={newAsset[k]} onChange={(e) => setNewAsset({ ...newAsset, [k]: Number(e.target.value) })}>
                    {[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              ))}
              {p.scenario === 'fin_data' && (
                <label style={{ fontSize: 11.5 }}>分级
                  <select value={newAsset.data_level} onChange={(e) => setNewAsset({ ...newAsset, data_level: e.target.value })}>
                    <option value="">-</option>{[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
              )}
              <button className="mini pri" onClick={addAsset}>添加</button>
            </div>
            <table className="tb" style={{ marginBottom: 16 }}>
              <thead><tr><th>资产</th><th>类型</th><th>C/I/A</th>{p.scenario === 'fin_data' && <th>分级</th>}<th>价值</th></tr></thead>
              <tbody>
                {detail.assets.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td><td>{a.type}</td>
                    <td className="mono">{a.confidentiality}/{a.integrity}/{a.availability}</td>
                    {p.scenario === 'fin_data' && <td>{a.data_level ?? '-'}</td>}
                    <td className="mono">{Math.max(a.confidentiality, a.integrity, a.availability, a.data_level ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* 风险分析 */}
            <h3>风险分析（{detail.findings.length}，按风险值排序）</h3>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
              <select value={newFinding.asset_id} onChange={(e) => setNewFinding({ ...newFinding, asset_id: e.target.value })}>
                <option value="">关联资产…</option>
                {detail.assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input style={{ width: 170 }} placeholder="威胁（如：外部攻击者入侵）" value={newFinding.threat_desc} onChange={(e) => setNewFinding({ ...newFinding, threat_desc: e.target.value })} />
              <label style={{ fontSize: 11.5 }}>频率<select value={newFinding.threat_freq} onChange={(e) => setNewFinding({ ...newFinding, threat_freq: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
              <input style={{ width: 170 }} placeholder="脆弱性（如：未启用MFA）" value={newFinding.vuln_desc} onChange={(e) => setNewFinding({ ...newFinding, vuln_desc: e.target.value })} />
              <label style={{ fontSize: 11.5 }}>严重<select value={newFinding.vuln_sev} onChange={(e) => setNewFinding({ ...newFinding, vuln_sev: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
              <button className="mini pri" onClick={addFinding}>登记（自动算风险值）</button>
            </div>
            <table className="tb">
              <thead><tr><th>资产</th><th>威胁×脆弱性</th><th>P×I</th><th>风险值</th><th>等级</th><th>处置</th></tr></thead>
              <tbody>
                {detail.findings.map((f) => (
                  <tr key={f.id}>
                    <td>{f.asset_name ?? '-'}</td>
                    <td>{f.threat_desc} × {f.vuln_desc ?? '-'}</td>
                    <td className="mono">{f.possibility}×{f.impact}</td>
                    <td className="mono"><b>{f.risk_value}</b></td>
                    <td><span className="pill" style={{ borderColor: LV_COLOR[f.risk_level], color: LV_COLOR[f.risk_level] }}>{f.risk_level}</span></td>
                    <td>
                      <select value={f.status} onChange={(e) => treat(f.id, { status: e.target.value })} style={{ fontSize: 11.5 }}>
                        <option value="open">未处置</option><option value="mitigating">整改中</option>
                        <option value="accepted">接受</option><option value="closed">已关闭</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* 报告 */}
            <h3 style={{ marginTop: 16 }}>评估报告
              <button className="mini pri" style={{ marginLeft: 8 }} disabled={busy || !detail.findings.length} onClick={genReport}>{busy ? '生成中…' : 'AI 生成报告'}</button>
              {report && <button className="mini" style={{ marginLeft: 6 }} onClick={exportReport}>导出 .md</button>}
            </h3>
            {report && <pre style={{ background: 'var(--paper)', padding: 12, borderRadius: 'var(--r-md)' }}>{report}</pre>}
            <small style={{ color: 'var(--ink3)', display: 'block', marginTop: 8 }}>
              复盘：评估收尾后到演练场走「经验教训萃取」场景，产物自动归档成长记录（知识贡献证据）。
            </small>
          </div>
        )}
      </div>

      {/* 新建评估项目 Modal（替代原三连 prompt） */}
      {showNew && (
        <Modal title="新建评估项目" onClose={() => setShowNew(false)} width={520}
          footer={<>
            <button onClick={() => setShowNew(false)}>取消</button>
            <button className="pri" disabled={!newProj.name.trim()} onClick={create}>创建</button>
          </>}>
          <Field label="项目名称">
            <input value={newProj.name} onChange={(e) => setNewProj({ ...newProj, name: e.target.value })}
              placeholder="如：XX银行2026年数据安全评估" autoFocus />
          </Field>
          <Field label="评估场景">
            <div className="choice-row">
              {Object.entries(SCN).map(([k, s]) => (
                <div key={k} className={`choice ${newProj.scenario === k ? 'on' : ''}`} onClick={() => setNewProj({ ...newProj, scenario: k })}>
                  <b>{s.name}</b><small style={{ color: 'var(--ink3)' }}>{s.tag}</small>
                </div>
              ))}
            </div>
          </Field>
          <Field label="被评估组织（可空）">
            <input value={newProj.org} onChange={(e) => setNewProj({ ...newProj, org: e.target.value })} />
          </Field>
        </Modal>
      )}
    </div>
  );
}
