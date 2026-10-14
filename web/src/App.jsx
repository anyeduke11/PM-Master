import React, { useEffect, useState } from 'react';
import { IconCompass, IconLayoutDashboard, IconShieldCheck, IconHistory, IconBrain, IconBook, IconTrendingUp, IconSettings, IconSun, IconMoon } from '@tabler/icons-react';
import CoachRoom from './CoachRoom.jsx';
import Workbench from './Workbench.jsx';
import Records from './Records.jsx';
import Drill from './Drill.jsx';
import Itto from './Itto.jsx';
import Growth from './Growth.jsx';
import Onboard from './Onboard.jsx';
import RA from './RA.jsx';
import Assistant from './Assistant.jsx';
import Bell from './Bell.jsx';
import Settings from './Settings.jsx';
import { ToastHost } from './ui.jsx';
import { api } from './api.js';
import { useHashTab } from './router.js';

const LVN = { 1: '辅助人员', 2: '初级', 3: '中级', 4: '高级', 5: '专家级' };

// R6.8 导航：Tabler 图标（替代 emoji，跨浏览器一致渲染）
// v5.20.0：M2「教练室」更名「演练场」（与统一角色短标签「教练」区隔；tab id / hash 深链 `#/coach` 不变）
const TABS = [
  ['coach', '演练场', IconCompass],
  ['work', '项目工作台', IconLayoutDashboard],
  ['ra', '风险评估', IconShieldCheck],
  ['records', '成长记录', IconHistory],
  ['drill', '强化营', IconBrain],
  ['itto', '知识库', IconBook],
  ['growth', '成长路径', IconTrendingUp],
  ['settings', '设置', IconSettings],
];

export default function App() {
  const [tab, setTab] = useHashTab('coach');
  const [autoScenario, setAutoScenario] = useState(null);   // 预警→教练闭环跳转
  const [profile, setProfile] = useState(null);
  const [projCtx, setProjCtx] = useState(null);      // 工作台选中项目 → 助手页面上下文
  const [importPrefill, setImportPrefill] = useState(null);   // R7.0 P5：飞书读入 → 导入向导草稿（经事件桥，跨 tab 不丢）
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark');   // R6.7 双主题

  useEffect(() => {
    api.get('/api/v2/profile').then(setProfile);
  }, []);

  // R7.0 P5：Settings 派发 pm-import-prefill → 切工作台并携带草稿（Workbench 条件渲染，须在此中转）
  useEffect(() => {
    const h = (e) => {
      setImportPrefill({ seq: Date.now(), text: e.detail?.text ?? '' });
      setTab('work');
    };
    window.addEventListener('pm-import-prefill', h);
    return () => window.removeEventListener('pm-import-prefill', h);
  }, []);

  // R7.0 P1：设置应用，减少动效开关；默认主题仅在用户从未手动切换时生效（localStorage 无 pm-theme）
  useEffect(() => {
    const applyMotion = (on) => {
      if (on) document.documentElement.dataset.reduceMotion = '1';
      else delete document.documentElement.dataset.reduceMotion;
    };
    api.get('/api/v2/settings').then((list) => {
      const m = Object.fromEntries(list.map((s) => [s.key, s.effective]));
      applyMotion(Boolean(m['ui.reduce_motion']));
      let stored = null;
      try { stored = localStorage.getItem('pm-theme'); } catch { /* 无痕模式忽略 */ }
      if (!stored && m['ui.default_theme'] === 'light') {
        document.documentElement.dataset.theme = 'light';
        setTheme('light');
        window.dispatchEvent(new CustomEvent('pm-theme', { detail: 'light' }));
      }
    }).catch(() => { /* 设置装载失败不阻塞（保持 CSS 默认） */ });
    // 设置页保存后即时应用动效开关（无需刷新）
    const onSettings = (e) => applyMotion(Boolean(e.detail?.['ui.reduce_motion']));
    window.addEventListener('pm-settings', onSettings);
    return () => window.removeEventListener('pm-settings', onSettings);
  }, []);

  // R6.7：主题切换（应用 + 持久化 + 广播事件供 ECharts 等重渲染）
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pm-theme', next); } catch { /* 无痕模式忽略 */ }
    window.dispatchEvent(new CustomEvent('pm-theme', { detail: next }));
  }

  // 冷启动：未初始化档案 → 全屏向导（F0）
  if (profile && !profile.initialized) {
    return (
      <>
        <Onboard onDone={(p) => { setProfile(p); setTab('growth'); }} />
        <ToastHost />
      </>
    );
  }

  const ThemeIcon = theme === 'dark' ? IconSun : IconMoon;

  return (
    <>
      <header>
        <div className="seal">项</div>
        <h1>PM-Master · 项目经理成长工作台</h1>
        <Bell />
        <div className="lv">
          {profile ? `当前 L${profile.current_level}（${LVN[profile.current_level]}）→ 目标 L${profile.target_level} · ${profile.track === 'pmo' ? 'PMO' : '项目'}通道` : '加载中…'}
        </div>
        <button className="theme-btn" title={theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'} onClick={toggleTheme}>
          <ThemeIcon size={14} stroke={1.8} />{theme === 'dark' ? '亮色' : '深色'}
        </button>
      </header>
      <nav className="tabs">
        {TABS.map(([k, l, Ic]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            <Ic size={15} stroke={1.8} />{l}
          </button>
        ))}
      </nav>
      {tab === 'coach' && <main style={{ overflow: 'hidden' }} className="page"><CoachRoom autoStart={autoScenario} onConsumed={() => setAutoScenario(null)} /></main>}
      {tab === 'work' && (
        <main style={{ overflow: 'hidden' }} className="page">
          <Workbench goCoach={(sc) => { setAutoScenario(sc); setTab('coach'); }} onContext={(c) => setProjCtx(c?.project_id ?? null)} importPrefill={importPrefill} />
        </main>
      )}
      {tab === 'ra' && <main style={{ overflow: 'hidden' }} className="page"><RA /></main>}
      {tab === 'records' && <main style={{ overflow: 'hidden' }} className="page"><Records onNavigate={(t) => setTab(t)} /></main>}
      {tab === 'drill' && <main style={{ overflow: 'hidden' }} className="page"><Drill /></main>}
      {tab === 'itto' && <main style={{ overflow: 'hidden' }} className="page"><Itto /></main>}
      {tab === 'growth' && <main style={{ overflow: 'auto' }} className="page"><Growth /></main>}
      {tab === 'settings' && <main style={{ overflow: 'hidden' }} className="page"><Settings onNavigate={(t) => setTab(t)} onCoachStart={(sc) => { setAutoScenario(sc); setTab('coach'); }} /></main>}
      <Assistant
        pageContext={tab === 'work' && projCtx ? { tab, project_id: projCtx } : { tab }}
        onCoachStart={(sc) => { setAutoScenario(sc); setTab('coach'); }}
        onNavigate={(t) => setTab(t)}
      />
      <ToastHost />
    </>
  );
}
