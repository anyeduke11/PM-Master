// R7.0 P5 技能注册表（I2）：LLM 能力清单（purpose 固定枚举）+ kill-switch + 调用统计
// 设计：注册表纯代码（静态清单）；启停为 KV 命名空间 `skill.<purpose>`（直写 settings 表，
// 与 P1 白名单键同表不同前缀——skill 键不进 DEFAULTS 校验体系，值域仅 '0'/'1'）；
// 统计口径复用 llm_calls 表按 purpose 聚合（全时段，provider 合并）。
// 循环依赖规避：仅依赖 db.mjs；agent.mjs 反向 import skillEnabled 作调用门。
import { db } from './db.mjs';
import { notFound, badRequest } from './errors.mjs';

// purpose → 中文能力名/分组/模型档/一句话说明（与 agent.mjs 各 callJSON 的 purpose 严格对齐；
// tier: strong=默认强模型 / fast=llm.model_fast；新增 purpose 时此处必须同步登记——J12 全等断言兜底）
export const REGISTRY = [
  { id: 'coach', label: '教练室对话', group: '教练与评定', tier: 'strong', desc: 'GROW 多轮教练推进的话术生成' },
  { id: 'coach_will', label: '意志力判定', group: '教练与评定', tier: 'strong', desc: '会话结束意愿与档案更新判断' },
  { id: 'rating', label: '能力评定', group: '教练与评定', tier: 'strong', desc: '教练证据 → 指标分级建议' },
  { id: 'onboard', label: '入职画像', group: '教练与评定', tier: 'strong', desc: '首次使用引导的档案生成' },
  { id: 'memory_extract', label: '记忆提取', group: '教练与评定', tier: 'fast', desc: '教练归档时自动提取工作记忆（P4）' },
  { id: 'weekly', label: '周报生成', group: '项目与工作', tier: 'strong', desc: 'EVM 数据 → 周报叙述与建议' },
  { id: 'risk_second_order', label: '风险二阶推演', group: '项目与工作', tier: 'strong', desc: '次级效应与连锁影响推演' },
  { id: 'ra_extract', label: '评估要素抽取', group: '项目与工作', tier: 'fast', desc: 'RA/PIA 文本 → 结构化资产要素' },
  { id: 'ra_report', label: '评估报告', group: '项目与工作', tier: 'strong', desc: '风险评估成稿' },
  { id: 'import_extract', label: '导入抽取', group: '项目与工作', tier: 'fast', desc: '粘贴文本 → 四类结构化行（P2）' },
  { id: 'patrol_digest', label: '巡检简报', group: '项目与工作', tier: 'fast', desc: 'findings → 每日巡检摘要（P3）' },
  { id: 'profile_distill', label: '画像蒸馏', group: '项目与工作', tier: 'strong', desc: '档案+能力分+证据 → 持续画像（P4）' },
  { id: 'drill_gen', label: '强化营出题', group: '强化营与知识库', tier: 'fast', desc: '按域与深度档生成情境题' },
  { id: 'drill_grade', label: '强化营判分', group: '强化营与知识库', tier: 'fast', desc: '作答 → 评分与讲解' },
  { id: 'itto_question', label: 'ITTO 提问', group: '强化营与知识库', tier: 'fast', desc: 'ITTO 卡片情境提问' },
  { id: 'itto_grade', label: 'ITTO 判分', group: '强化营与知识库', tier: 'fast', desc: 'ITTO 作答判定' },
  { id: 'tutor_demonstrate', label: '导师示范', group: '强化营与知识库', tier: 'fast', desc: '四步教学法示范演示' },
  { id: 'tutor_explain', label: '导师讲解', group: '强化营与知识库', tier: 'fast', desc: '卡片讲解生成' },
  { id: 'tutor_feynman', label: '费曼提问（导师）', group: '强化营与知识库', tier: 'fast', desc: '费曼式反问检验理解' },
  { id: 'card_feynman', label: '费曼提问（卡片）', group: '强化营与知识库', tier: 'fast', desc: '知识库卡片费曼检验' },
  { id: 'assistant_intent', label: '助手意图解析', group: '助手与界面', tier: 'fast', desc: '自然语言 → 查询/写动作路由' },
  { id: 'chat', label: '助手流式回复', group: '助手与界面', tier: 'strong', desc: 'SSE 自由对话主通道（停用后助手仅剩查询动作）' },
];

const skillKey = (id) => `skill.${id}`;
const known = (id) => REGISTRY.some((r) => r.id === id);

// kill-switch 读取（agent.mjs 门）：未设置=启用；仅显式 '0' 停用
export function skillEnabled(purpose) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(skillKey(String(purpose ?? 'unknown')));
  return row?.value !== '0';
}

// 全量视图（GET /api/skills）：注册表 + 启停 + 全时段统计
export function listSkills() {
  const agg = new Map();   // purpose → {calls, ok_calls, ms, tokens}（provider 合并）
  for (const r of db.prepare(`SELECT purpose, COUNT(*) calls, SUM(ok) ok_calls, SUM(ms) ms,
                              SUM(total_tokens) tokens FROM llm_calls GROUP BY purpose`).all()) {
    agg.set(r.purpose, r);
  }
  return REGISTRY.map((s) => {
    const a = agg.get(s.id);
    return {
      ...s,
      enabled: skillEnabled(s.id),
      calls: a?.calls ?? 0,
      ok_calls: a?.ok_calls ?? 0,
      avg_ms: a && a.calls ? Math.round(a.ms / a.calls) : null,
      tokens: a?.tokens ?? null,
    };
  });
}

// 启停写入（PUT /api/skills/:id {enabled}）：val=null 清除覆盖回默认启用
export function setSkillEnabled(id, enabled) {
  if (!known(id)) throw notFound(`未登记的能力：${id}`);
  const k = skillKey(id);
  if (enabled === null) { db.prepare('DELETE FROM settings WHERE key = ?').run(k); return { id, enabled: true }; }
  if (enabled !== true && enabled !== false) throw badRequest('enabled 须为布尔值');
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(k, enabled ? '1' : '0');
  return { id, enabled };
}
