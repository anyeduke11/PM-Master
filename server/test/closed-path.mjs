// R3.1 WP3 闭环链第三态实测桩：trained → closed（分数达标自动闭环）
// 用法：node test/closed-path.mjs            # 自动挑一条 trained 知识链接
//       node test/closed-path.mjs schedule   # 指定知识域
// 原理：把该域全部卡片置为已掌握（reps≥2）→ 域分 ≥0.7 → syncLinks 将链接置 closed
// 特性：自带恢复（链接状态 + 卡片 reps 全还原）；直接调 syncLinks 而非 monthlyRecalc，
//       避免向 assessments 写入验证用的重算记录
import { db } from '../src/db.mjs';
import { computeScores } from '../src/growth.mjs';
import { syncLinks, linkStats } from '../src/growth-links.mjs';

const want = process.argv[2] ?? null;
const link = want
  ? db.prepare(`SELECT * FROM growth_links WHERE domain=? AND status='trained' LIMIT 1`).get(want)
  : db.prepare(`SELECT * FROM growth_links WHERE status='trained' AND domain IS NOT NULL ORDER BY id LIMIT 1`).get();

if (!link) {
  console.error('✗ 前置不满足：没有 status=trained 且带 domain 的链接。');
  console.error('  先制造训练信号（强化营复习卡判 ok/good，或跑一次月度重算建链）再执行本桩。');
  process.exit(2);
}

const cards = db.prepare('SELECT id, reps FROM knowledge_cards WHERE domain=?').all(link.domain);
if (!cards.length) {
  console.error(`✗ 域 ${link.domain} 下无卡片，无法造数`);
  process.exit(2);
}

const statsBefore = linkStats();
const linkBefore = { status: link.status, score_after: link.score_after, closed_at: link.closed_at };

// ---------- 造数 ----------
for (const c of cards) db.prepare('UPDATE knowledge_cards SET reps=2 WHERE id=?').run(c.id);
const scoreBefore = computeScores();
const domainScore = scoreBefore.kDetails[link.domain];
const res = syncLinks(scoreBefore);
const after = db.prepare('SELECT * FROM growth_links WHERE id=?').get(link.id);

const checks = [
  ['域分升至 ≥0.7', domainScore != null && domainScore >= 0.7, `域分=${domainScore}`],
  ['链接置为 closed', after.status === 'closed', `status=${after.status}`],
  ['写入 score_after 且 ≥0.7', after.score_after != null && after.score_after >= 0.7, `score_after=${after.score_after}`],
  ['写入 closed_at', !!after.closed_at, `closed_at=${after.closed_at}`],
  ['未误建新链接', res.created === 0, `created=${res.created}`],
];

// ---------- 恢复 ----------
db.prepare('UPDATE growth_links SET status=?, score_after=?, closed_at=? WHERE id=?')
  .run(linkBefore.status, linkBefore.score_after, linkBefore.closed_at, link.id);
for (const c of cards) db.prepare('UPDATE knowledge_cards SET reps=? WHERE id=?').run(c.reps, c.id);

const statsAfter = linkStats();
checks.push(['现场已复原（回 trained）', db.prepare('SELECT status FROM growth_links WHERE id=?').get(link.id).status === 'trained', '']);
checks.push(['闭环计数复原', statsAfter.closed === statsBefore.closed, `${statsBefore.closed} → ${statsAfter.closed}`]);

let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  if (!pass) ok = false;
}
console.log(`\n${ok ? '✅ closed 路径实测通过' : '❌ closed 路径实测失败'}（域=${link.domain} link#${link.id}）`);
process.exit(ok ? 0 : 1);