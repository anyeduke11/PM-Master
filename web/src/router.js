import { useCallback, useEffect, useState } from 'react';

// 站点路由（无第三方依赖）：用 location.hash 记录当前 tab，形如 #/<tab>
export const TAB_IDS = ['coach', 'work', 'ra', 'records', 'drill', 'itto', 'growth', 'settings'];

// 解析当前 hash → 合法 tab id，非法/缺失回退 defaultTab
function readHash(defaultTab) {
  const m = /^#\/([^/?]+)/.exec(window.location.hash || '');
  const id = m ? m[1] : '';
  return TAB_IDS.includes(id) ? id : defaultTab;
}

// useHashTab(defaultTab) → [tab, setTab]；setTab 同时更新 location.hash
export function useHashTab(defaultTab) {
  const [tab, setTabState] = useState(() => readHash(defaultTab));

  useEffect(() => {
    const onHash = () => setTabState(readHash(defaultTab));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [defaultTab]);

  const setTab = useCallback((id) => {
    if (!TAB_IDS.includes(id)) return;
    const next = `#/${id}`;
    if (window.location.hash !== next) window.location.hash = next;
    setTabState(id);
  }, []);

  return [tab, setTab];
}