// P3 强化营：SM-2 lite 间隔重复调度 + 情景题（深度随档案等级）
// 种子卡全量 51 张（17领域×3档深度）见 seeds.mjs；此处仅调度与生成逻辑
import { db, getProfile } from './db.mjs';
import { loadStandard } from './standard.mjs';
import { drillChat, cardFeynmanChat } from './agent.mjs';
import { seedCards } from './seeds.mjs';
import { markTrained } from './growth-links.mjs';
import { refreshExperienceStats } from './growth.mjs';
import { badRequest, notFound } from './errors.mjs';   // R6.4 错误风格：用户错误显式标 4xx
export { seedCards };

// ---------- SM-2 lite 调度 ----------
export function review(cardId, grade) {
  const card = db.prepare('SELECT * FROM knowledge_cards WHERE id=?').get(cardId);
  if (!card) throw notFound('card not found');
  // R6.3 全站测试：grade 白名单（非法值曾落 last_grade 污染调度数据）
  if (!['good', 'ok', 'weak'].includes(grade)) throw badRequest(`非法评分：${grade}（仅 good/ok/weak）`);
  let { interval_days: iv, ease, reps } = card;
  if (grade === 'good') { ease = Math.min(3, ease + 0.1); reps += 1; iv = Math.max(1, Math.round(iv * ease)) || 1; }
  else if (grade === 'ok') { reps += 1; iv = Math.max(1, Math.round(iv * 1.3)) || 1; }
  else { ease = Math.max(1.3, ease - 0.2); reps = 0; iv = 0; }   // weak：今天再见
  const next = new Date(Date.now() + iv * 86400000).toISOString().slice(0, 10);
  db.prepare('UPDATE knowledge_cards SET interval_days=?, ease=?, reps=?, last_grade=?, next_review=? WHERE id=?')
    .run(iv, ease, reps, grade, next, cardId);
  // R2.3 闭环链：复习卡良好表现 → 命中该知识域 open 链接置 trained
  if (grade !== 'weak') markTrained({ domain: card.domain });
  return { id: cardId, interval_days: iv, next_review: next, grade };
}

export function dueQueue(limit = 20) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`SELECT id, domain, front, back, sources, level_tag, reps, next_review FROM knowledge_cards
                     WHERE next_review <= ? ORDER BY next_review, id LIMIT ?`).all(today, limit);
}

// R4.3 WP7 复习体验：到期聚合视图（今日应复习含逾期 / 逾期量 / 未来 7 天分布），供强化营页顶部一览
export function dueSummary() {
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const dueToday = db.prepare('SELECT COUNT(*) c FROM knowledge_cards WHERE next_review <= ?').get(today).c;
  const overdue = db.prepare('SELECT COUNT(*) c FROM knowledge_cards WHERE next_review < ?').get(today).c;
  const upcoming = db.prepare(`SELECT next_review date, COUNT(*) count FROM knowledge_cards
                               WHERE next_review > ? AND next_review <= ? GROUP BY next_review ORDER BY next_review`).all(today, in7);
  const upcomingTotal = upcoming.reduce((a, r) => a + r.count, 0);
  return { today, due_today: dueToday, overdue, upcoming, upcoming_total: upcomingTotal };
}

// ---------- R5.1 WP1 卡片费曼（M3 实证通道）：讲给 AI 听 → 合格沉淀知识贡献证据并回写卡片 ----------
// 幂等：evidence 以 tags 机器标记 knowledge_card#<id> 查重；卡片 evidence_id 只在 NULL 时回写（只增不减）
export async function cardFeynman(cardId, explanation) {
  const card = db.prepare('SELECT * FROM knowledge_cards WHERE id=?').get(Number(cardId));
  if (!card) throw notFound('card not found');
  const text = String(explanation ?? '').trim();
  if (text.length < 20) throw badRequest('讲解太短（至少 20 字），费曼要求完整讲清概念、用途与示例');
  const out = await cardFeynmanChat({ card, explanation: text, profile: getProfile() });
  if (!out.qualified) return { qualified: false, comment: out.comment, evidence_id: null };

  const tag = `knowledge_card#${card.id}`;
  const existed = db.prepare('SELECT id FROM evidence WHERE tags LIKE ? ORDER BY id DESC LIMIT 1').get(`%"${tag}"%`);
  if (existed) {
    db.prepare('UPDATE knowledge_cards SET evidence_id=? WHERE id=? AND evidence_id IS NULL').run(existed.id, card.id);
    return { qualified: true, comment: out.comment, evidence_id: existed.id, existing: true };
  }
  const info = db.prepare('INSERT INTO evidence (type, title, description, tags) VALUES (?,?,?,?)').run(
    'case',
    `知识贡献 · 可教授知识点 · ${card.front.slice(0, 24)}`,
    [
      `强化营费曼挑战合格：向 AI 完整讲清该知识点的概念、用途与示例，达成 M3 能教授。`,
      `所属知识域：${card.domain}（卡片 #${card.id}）`,
      '依据：PRD 4.9.2「M3 能教授 → 直接计入 evidence（案例分享类）」，对应 GB/T 41831 知识贡献类经验硬指标。',
    ].join('\n'),
    JSON.stringify(['CSPM 知识贡献', 'M3 能教授', '费曼挑战', tag, card.domain]),
  );
  db.prepare('UPDATE knowledge_cards SET evidence_id=? WHERE id=? AND evidence_id IS NULL').run(info.lastInsertRowid, card.id);
  refreshExperienceStats();
  return { qualified: true, comment: out.comment, evidence_id: info.lastInsertRowid, existing: false };
}
export function cardStats() {
  return db.prepare(`SELECT domain, COUNT(*) total,
                     SUM(CASE WHEN reps >= 2 THEN 1 ELSE 0 END) mastered FROM knowledge_cards GROUP BY domain`).all();
}

// ---------- 情景题（生成 + 判分，深度随档案目标级） ----------
const DEPTH_CN = { know: '知道领会（概念辨析）', apply: '应用分析（情境推断）', integrate: '整合评价（权衡决策）' };

export async function genScenario(domain) {
  const p = getProfile();
  const g = loadStandard('gbt41831');
  // R6.3 全站测试：未知知识域拒绝（曾静默兜底出题并落脏 drill_records 污染情景分口径）
  if (!g.knowledge_domains[domain]) throw badRequest(`未知知识域：${domain}`);
  const need = g.knowledge_domains[domain]?.depth?.[`L${p.target_level}`] ?? 'apply';
  const out = await drillChat({
    profile: p,
    kind: 'gen',
    depth: DEPTH_CN[need],
    domain: g.knowledge_domains[domain]?.name ?? domain,
    card: db.prepare('SELECT front FROM knowledge_cards WHERE domain=? ORDER BY RANDOM() LIMIT 1').get(domain)?.front ?? '',
  });
  const info = db.prepare(`INSERT INTO drill_records (question, model_answer, depth, domain) VALUES (?,?,?,?)`)
    .run(out?.question ?? '', out?.model_answer ?? '', need, domain);
  return { id: info.lastInsertRowid, depth: need, ...out };
}

export async function gradeScenario(recordId, answer) {
  const rec = db.prepare('SELECT * FROM drill_records WHERE id=?').get(recordId);
  if (!rec) throw notFound('record not found');
  const out = await drillChat({
    profile: getProfile(), kind: 'grade', depth: DEPTH_CN[rec.depth] ?? '',
    question: rec.question, model_answer: rec.model_answer, answer,
  });
  const grade = ['good', 'ok', 'weak'].includes(out?.grade) ? out.grade : 'ok';
  db.prepare('UPDATE drill_records SET answer=?, grade=? WHERE id=?').run(answer, grade, recordId);
  // R2.3 闭环链：情景题良好表现 → 命中该知识域 open 链接置 trained
  if (grade !== 'weak') {
    const dom = rec.domain
      ?? db.prepare(`SELECT c.domain FROM drill_records r JOIN knowledge_cards c ON c.id=r.card_id WHERE r.id=?`).get(recordId)?.domain;
    if (dom) markTrained({ domain: dom });
  }
  return { grade, feedback: out?.feedback ?? '' };
}
