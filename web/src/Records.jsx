import React, { useEffect, useState } from 'react';
import { IconFileText, IconBraces, IconChartDots3 } from '@tabler/icons-react';
import Feedback from './Feedback.jsx';
import { api } from './api.js';

const LVN = { 1: '辅助人员', 2: '初级', 3: '中级', 4: '高级', 5: '专家级' };

// P2 成长记录（原证据银行）：教练自动归档 + 手动录入 + L5 经验硬指标进度
// R6.6 AI 面整合：承接原「AI 对话」页资产，等级切换（档案驱动）
// R7.0 P1：LLM 调用观测卡迁入设置中心 C 区（增强为可过滤），此处留跳转入口
export default function Records({ onNavigate }) {
  const [list, setList] = useState([]);
  const [stats, setStats] = useState({});
  const [req, setReq] = useState(null);
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ title: '', type: 'training' });

  useEffect(() => {
    api.get('/api/v2/records/evidence').then(setList);
    api.get('/api/v2/records/experience-stats').then(setStats);
    api.get('/api/v2/profile').then((p) => {
      setProfile(p);
      api.get(`/api/v2/standard/requirements/${p.target_level}?track=${p.track}`).then(setReq);
    });
  }, []);

  // R6.6：等级切换（原 AI 对话页「等级自适应」卡迁入；系统提示词与清单随档案自适应）
  async function switchLevel(lv) {
    const p = await api.put('/api/v2/profile', { current_level: lv, target_level: Math.min(lv + 1, 5) });
    setProfile(p);
    api.get(`/api/v2/standard/requirements/${p.target_level}?track=${p.track}`).then(setReq);
  }

  async function add() {
    if (!form.title.trim()) return;
    const e = await api.post('/api/v2/records/evidence', {
      title: form.title, type: form.type,
      tags: { training: ['CSPM 培训授课', 'PMP PDU'], case: ['CSPM 案例分享'], standard: ['CSPM 标准参与'], project: ['CSPM 项目经历'] }[form.type],
    });
    setList([e, ...list]); setForm({ ...form, title: '' });
  }
  async function saveStat(k, v) {
    const next = await api.put('/api/v2/records/experience-stats', { [k]: Number(v) });
    setStats(next);
  }

  return (
    <div className="split" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 14, height: '100%', overflow: 'hidden' }}>
      <div className="card" style={{ overflow: 'auto' }}>
        <h3>成长记录（教练产物自动归档 · 一套数据多头核算）</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="training">培训授课</option><option value="case">案例分享</option>
            <option value="standard">标准参与</option><option value="project">项目经历</option>
          </select>
          <input style={{ flex: 1 }} placeholder="记录标题，如：内部培训《EVM实战》" value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="pri" onClick={add}>录入</button>
        </div>
        {list.map((e) => (
          <div key={e.id} className="rowitem">
            <b style={{ flex: 1 }}>{e.title}</b>
            <small>{(JSON.parse(e.tags ?? '[]')).join(' · ')}</small>
            <small style={{ color: 'var(--ink3)' }}>{e.created_at?.slice(5, 16)}</small>
          </div>
        ))}
        {!list.length && <div className="empty">暂无记录：完成一次教练会话即自动归档第一条</div>}
      </div>
      <div className="card" style={{ overflow: 'auto' }}>
        <h3>{req ? `L${req.level?.slice(1)} 经验硬指标` : '经验硬指标'}（可编辑现值）</h3>
        {(req?.experience ?? []).map((e) => {
          const key = e.metric;
          const cur = stats[key];
          const target = e.value;
          const pct = cur != null ? Math.min(100, Math.round((cur / target) * 100)) : 0;
          return (
            <div key={key} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, display: 'flex', justifyContent: 'space-between' }}>
                <span>{e.desc?.slice(0, 22)}</span>
                <span style={{ color: pct >= 100 ? 'var(--ok)' : 'var(--warn)' }}>
                  {cur ?? '-'} / {target}{e.unit === '一般项目' ? ' 项' : ''}
                </span>
              </div>
              <div className={`bar ${pct >= 100 ? 'ok' : ''}`} style={{ margin: '4px 0' }}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <input type="number" step="0.1" style={{ width: 90, fontSize: 12 }} placeholder="更新现值"
                onBlur={(ev) => ev.target.value && saveStat(key, ev.target.value)} />
            </div>
          );
        })}
        <small style={{ color: 'var(--ink3)' }}>等级自适应：切换档案等级后此清单自动换档（读 gbt41831.yaml）</small>
        <div className="lvbtns" style={{ marginTop: 8 }}>
          {[1, 2, 3, 4, 5].map((lv) => (
            <button key={lv} className={profile?.current_level === lv ? 'on' : ''} onClick={() => switchLevel(lv)}>
              L{lv} {LVN[lv]}
            </button>
          ))}
        </div>
        <hr className="divider" />
        <h3>数据导出（R5.3/R6.5 · 交接/存档）</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="mini" onClick={() => window.open('/api/v2/export/markdown')}><IconFileText size={13}/> Markdown 汇总报告</button>
          <button className="mini" onClick={() => window.open('/api/v2/export/json')}><IconBraces size={13}/> JSON 全库包</button>
        </div>
        <small style={{ display: 'block', marginTop: 6, color: 'var(--ink3)' }}>
          Markdown = 三维/闭环/项目/经验/证据/知识掌握/训练任务/情景错题人读汇总；JSON = 业务表快照（26 表，可读可备份；API 支持 ?tables= 白名单过滤）
        </small>
        {onNavigate && (
          <div style={{ marginTop: 10 }}>
            <button className="mini" onClick={() => onNavigate('settings')}><IconChartDots3 size={13}/> LLM 调用观测（已迁至设置中心）</button>
          </div>
        )}
        <Feedback source="records" />
      </div>
    </div>
  );
}
