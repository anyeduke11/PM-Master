// R3.4 WP6 掌握度矩阵：工具（四步教学）与知识卡片（SM-2）并轨到 PRD 4.9.2 的 M0-M3 费曼口径
// 纯代码映射（零 LLM、零等级硬编码）；存量 itto_tutor.mastery 整数口径不变，M 档读取时派生
import { db } from './db.mjs';
import { refreshExperienceStats } from './growth.mjs';
import { notFound, conflict } from './errors.mjs';   // R6.4 错误风格

// PRD 4.9.2 M0-M3；判定依据按对象类型分别给出（卡片侧为 SM-2 记忆强度代理口径，前端显式标注）
export const M_LEVELS = [
  { m: 0, key: 'M0', name: '未接触', tool_basis: '无教学记录', card_basis: '从未复习' },
  { m: 1, key: 'M1', name: '已认识', tool_basis: '开课讲解过', card_basis: '复习过 1 次' },
  { m: 2, key: 'M2', name: '会应用', tool_basis: '实练批改 ≥60', card_basis: '复习 ≥2 次' },
  { m: 3, key: 'M3', name: '能教授', tool_basis: '费曼评定合格', card_basis: '复习 ≥4 次且间隔 ≥21 天，或费曼实证合格' },
];

const CN = Object.fromEntries(M_LEVELS.map((l) => [l.m, `${l.key} ${l.name}`]));
export const masteryLabel = (m) => CN[m] ?? 'M0 未接触';

// 工具侧：itto_tutor.mastery v1 整数口径 0=仅讲解 / 1=练成 / 3=可教授 → M 档（无记录=M0）
export function toolMasteryLevel(mastery) {
  if (mastery == null) return 0;
  const v = Number(mastery);
  if (v >= 3) return 3;
  if (v === 1) return 2;
  return 1;                      // 0 = 已开课讲解（M1）
}

// 卡片侧：SM-2 lite 调度信号派生（reps 次数 + 稳定间隔），与 cardStats 的 reps≥2 口径一致
// R5.1 WP1 M3 双通道：evidence_id 非空（费曼实证合格回写）→ 直接 M3 能教授（SM-2 口径不变，实证为增量通道）
export function cardMasteryLevel({ reps = 0, interval_days: iv = 0, last_grade: g = null, evidence_id: ev = null }) {
  if (ev != null) return 3;
  if (!g && Number(reps) === 0) return 0;
  if (Number(reps) >= 4 && Number(iv) >= 21) return 3;
  if (Number(reps) >= 2) return 2;
  return 1;
}

// 工具已沉淀的知识贡献证据（tags 内含机器可读标记 itto_tool#<id>；带闭引号避免 id 前缀歧义）
const evidenceIdSql = (alias = 't') => `(SELECT e.id FROM evidence e
  WHERE e.tags LIKE '%"itto_tool#' || ${alias}.id || '"%'
  ORDER BY e.id DESC LIMIT 1)`;

// ---------- 矩阵（工具全集 + 卡片全集，共用同一 M 档） ----------
export function masteryMatrix() {
  const tools = db.prepare(`SELECT t.id, t.name, t.category,
                            (SELECT COUNT(*) FROM itto_links l WHERE l.tool_id=t.id AND l.kind='tool') proc_count,
                            (SELECT MAX(mastery) FROM itto_tutor tr WHERE tr.tool_id=t.id) mastery,
                            ${evidenceIdSql('t')} evidence_id
                            FROM itto_tools t
                            WHERE EXISTS (SELECT 1 FROM itto_links l WHERE l.tool_id=t.id AND l.kind='tool')
                               OR EXISTS (SELECT 1 FROM itto_tutor tr WHERE tr.tool_id=t.id)`)
    .all()
    .map((r) => ({
      id: r.id, name: r.name, category: r.category, proc_count: r.proc_count,
      m: toolMasteryLevel(r.mastery), label: masteryLabel(toolMasteryLevel(r.mastery)),
      evidence_id: r.evidence_id ?? null,
    }));

  const cards = db.prepare('SELECT id, domain, front, level_tag, reps, interval_days, last_grade, next_review, evidence_id FROM knowledge_cards')
    .all()
    .map((c) => {
      const m = cardMasteryLevel(c);
      return { id: c.id, domain: c.domain, front: c.front, level_tag: c.level_tag, reps: c.reps,
        interval_days: c.interval_days, next_review: c.next_review, m, label: masteryLabel(m),
        evidence_id: c.evidence_id ?? null };
    });

  const counts = M_LEVELS.map((l) => ({
    m: l.m, key: l.key, name: l.name, tool_basis: l.tool_basis, card_basis: l.card_basis,
    tools: tools.filter((t) => t.m === l.m).length,
    cards: cards.filter((c) => c.m === l.m).length,
  }));

  const byM = (a, b) => b.m - a.m || String(a.name ?? a.domain).localeCompare(String(b.name ?? b.domain));
  return {
    levels: M_LEVELS,
    counts,
    summary: {
      tool_total: tools.length,
      card_total: cards.length,
      taught_tools: tools.filter((t) => t.m >= 1).length,
      m3_items: tools.filter((t) => t.m === 3).length + cards.filter((c) => c.m === 3).length,
    },
    tools: tools.sort(byM),
    cards: cards.sort((a, b) => b.m - a.m || String(a.domain).localeCompare(String(b.domain))),
    note: '卡片侧 M 档 v2：SM-2 记忆强度代理 + 费曼实证双通道（R5.1）——evidence_id 非空即 M3；M3 知识贡献证据可由工具费曼（itto_tool#id）或卡片费曼（knowledge_card#id）沉淀',
  };
}

// ---------- M3 → 知识贡献证据（PRD 4.9.2：M3 即国标经验维「知识贡献」证据；幂等） ----------
// R4.1 WP1：证据 → 同主题知识卡片回写关联（卡片 front/back 命中工具名即视为同主题；已有关联不覆盖，只增不减）
function linkEvidenceCards(evidenceId, toolName) {
  const pat = `%${String(toolName).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const r = db.prepare(`UPDATE knowledge_cards SET evidence_id=?
                        WHERE evidence_id IS NULL AND (front LIKE ? ESCAPE '\\' OR back LIKE ? ESCAPE '\\')`)
    .run(evidenceId, pat, pat);
  return r.changes;
}

export function promoteM3Evidence(toolId) {
  const id = Number(toolId);
  const tool = db.prepare('SELECT * FROM itto_tools WHERE id=?').get(id);
  if (!tool) throw notFound('tool not found');
  const best = db.prepare('SELECT MAX(mastery) m FROM itto_tutor WHERE tool_id=?').get(id);
  if (toolMasteryLevel(best?.m) < 3) throw conflict('该工具尚未达成 M3 能教授（需费曼评定合格），不能沉淀为知识贡献证据');
  const existed = db.prepare('SELECT id FROM evidence WHERE tags LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`%"itto_tool#${id}"%`);
  if (existed) return { evidence_id: existed.id, existing: true, linked_cards: linkEvidenceCards(existed.id, tool.name), knowledge_contributions: null };

  const proc = db.prepare(`SELECT p.code, p.name, p.ka FROM itto_links l JOIN itto_processes p ON p.id=l.process_id
                           WHERE l.tool_id=? AND l.kind='tool' ORDER BY p.code LIMIT 1`).get(id);
  const info = db.prepare('INSERT INTO evidence (type, title, description, tags) VALUES (?,?,?,?)').run(
    'case',
    `知识贡献 · 可教授工具 · ${tool.name}`,
    [
      `四步教学（讲→示→练→用）完成且费曼评定合格，达成 M3 能教授。`,
      tool.category ? `类别：${tool.category}` : '',
      proc ? `常用过程：${proc.code} ${proc.name}` : '',
      '依据：PRD 4.9.2「M3 能教授 → 直接计入 evidence（案例分享类）」，对应 GB/T 41831 知识贡献类经验硬指标。',
    ].filter(Boolean).join('\n'),
    JSON.stringify(['CSPM 知识贡献', 'M3 能教授', `itto_tool#${id}`, ...(proc?.ka ? [proc.ka] : [])]),
  );
  refreshExperienceStats();   // 只增不减口径，立即反映到经验维
  return {
    evidence_id: info.lastInsertRowid,
    existing: false,
    linked_cards: linkEvidenceCards(info.lastInsertRowid, tool.name),
    knowledge_contributions: Number(db.prepare("SELECT value FROM experience_stats WHERE key='knowledge_contributions'").get()?.value ?? 0),
  };
}
