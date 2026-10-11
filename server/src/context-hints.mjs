// R2.4 W1.3 工作台智能关联：场景事件 → 可用工具提示卡（卡片式，不打断主流程）
// 规则表驱动（PRD：关联规则表驱动，AI 只负责提示文案与演示执行——本模块零 LLM）
// 关键词是内容层配置（工具名），等级相关逻辑一律不在此处
import { db } from './db.mjs';

// 关键词是内容层配置：event → 提示文案 + itto_tools 匹配关键词
const TRIGGERS = [
  {
    event: 'risk_new',
    text: '新风险已登记。定量分析与应对比选可用：',
    keywords: ['决策树', '蒙特卡洛', '预期货币价值', '敏感性分析', '风险概率'],
  },
  {
    event: 'cpi_anomaly',
    text: '成本/进度超容差，根因分析可用：',
    keywords: ['鱼骨', '五问', '5Why', '帕累托', '偏差分析', '趋势分析'],
  },
  {
    event: 'project_init',
    text: '立项阶段商业论证与可行性工具：',
    keywords: ['商业论证', 'SWOT', '可行性研究', '专家判断', '干系人分析'],
  },
  {
    event: 'stakeholder_cold',
    text: '干系人参与度不足，可用的参与工具：',
    keywords: ['权力利益', '参与度评估', '沟通方法', '人际交往'],
  },
];

const norm = (s) => String(s ?? '').toLowerCase();

function toolsByKeywords(keywords, limit = 4) {
  const hit = new Map();
  for (const kw of keywords) {
    for (const t of db.prepare('SELECT id, name, category FROM itto_tools WHERE name LIKE ? OR category LIKE ? ORDER BY id LIMIT 3')
      .all(`%${kw}%`, `%${kw}%`)) {
      if (!hit.has(t.id)) hit.set(t.id, t);
      if (hit.size >= limit) break;
    }
    if (hit.size >= limit) break;
  }
  return [...hit.values()];
}

// 事件 → 提示卡（无匹配规则或库中无工具时返回 []）
export function hintsFor(event) {
  const trig = TRIGGERS.find((t) => t.event === event);
  if (!trig) return [];
  const tools = toolsByKeywords(trig.keywords);
  if (!tools.length) return [];
  return [{ event, text: trig.text, tools }];
}

// 反向：工具 → 该工具适用于哪些场景（教学第④步「用」的落点提示）
export function applyHintsFor(tool) {
  const name = norm(tool.name);
  const cat = norm(tool.category);
  return TRIGGERS
    .filter((t) => t.keywords.some((kw) => name.includes(norm(kw)) || cat.includes(norm(kw))))
    .map((t) => ({ event: t.event, text: t.text.replace(/可用.*?：|工具：/, '').replace(/。$/, '') }));
}
