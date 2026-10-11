// PM-Master 标准库加载器：三个 YAML 是评级唯一依据，启动时加载并缓存
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { badRequest } from './errors.mjs';   // R6.4 错误风格

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'standard');

const cache = {};
export function loadStandard(name) {
  if (!['gbt41831', 'pmp-prince2-map', 'indicator-training-map'].includes(name)) {
    throw badRequest(`unknown standard: ${name}（可选 gbt41831|pmp-prince2-map|indicator-training-map）`);
  }
  if (!cache[name]) {
    cache[name] = yaml.load(readFileSync(join(DIR, `${name}.yaml`), 'utf8'));
  }
  return cache[name];
}

// 等级自适应核心查询：给定档案等级与通道，返回该级全部要求（供评估/出题/差距分析）
export function levelRequirements(level, track = 'project') {
  const g = loadStandard('gbt41831');
  const L = `L${level}`;
  const domains = Object.fromEntries(
    Object.entries(g.knowledge_domains).map(([id, d]) => [id, { name: d.name, required: d.depth[L] }])
  );
  return {
    level: L,
    levelDef: g.levels[L],
    knowledge: domains,
    competency: {
      environmental_personal: g.competency_requirements[L][track],
      technical: g.competency_requirements[L][`technical_${track}`],
    },
    experience: g.experience_requirements[L][track],
    adaptation: g.product_adaptation,
  };
}

// 差距分析：当前指标覆盖 vs 目标级要求（短板原则输入）
export function gapAnalysis(achievedCompetencies, level, track = 'project') {
  const req = levelRequirements(level, track);
  const required = [...req.competency.environmental_personal, ...req.competency.technical];
  const missing = required.filter((id) => !achievedCompetencies?.includes(id));
  return { level: req.level, required_count: required.length, missing, missing_count: missing.length };
}
