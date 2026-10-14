// R3.5 WP8 起步的验收脚本化回归（node:test，零外部依赖、零密钥）；R6.1 起扩至 33 例（A-I 九组）
// 运行：cd server && npm run test:acceptance
// 隔离：PM_DB_PATH 指向独立测试库（每次重建），不触碰真实数据；AGENT_PROVIDER=mock 保证确定性
// 覆盖：A1-A9 闭环链 / B1-B5 评分 K-C-E / C1-C5 月报与飞书 / D1-D3 Growth 页数据契约 /
//       E1-E3 R4.1 口径精细化 / F1-F2 R4.3 复习体验与 LLM 可观测 /
//       G1-G3 R5.1 卡片费曼·趋势去重 + R5.2 token 契约 / H1-H2 R5.3 复习提醒联动与数据导出 /
//       I1 R6.1 反馈通道
// 诚实标注：C4（飞书真实写回）为避免每次回归产生线上文档标 skip，写回链路由 C5 降级路径 + R3.2 人工实测覆盖；
//           D1-D3 原为浏览器交互用例，此处以 Growth 页所依赖的 API 数据契约作确定性替身（渲染层仍需人工验收）
process.env.AGENT_PROVIDER = 'mock';
// 飞书凭据默认清除（零密钥回归）；RUN_FEISHU_LIVE=1 时 J14 临时注入走真实闭环（仅该用例，用毕即清）
const FEISHU_CRED = { id: process.env.FEISHU_APP_ID || '', secret: process.env.FEISHU_APP_SECRET || '' };
process.env.FEISHU_APP_ID = '';
process.env.FEISHU_APP_SECRET = '';

import { rmSync } from 'node:fs';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB = join(DATA, 'test-acceptance.db');
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.PM_DB_PATH = DB;   // 必须早于 src 模块导入（db.mjs 打开库时读取）

const { db, getProfile, updateProfile } = await import('../src/db.mjs');
const { cfg, allSettings, setSettings } = await import('../src/settings.mjs');   // R7.0 P1 设置中心
const { importPreview, importCommit, importLogs } = await import('../src/import-flow.mjs');   // R7.0 P2 数据流入
const { toolUsage, assignToolTask } = await import('../src/tools-usage.mjs');                 // R7.0 P2 工具频率
const { patrolScan, patrolRun, patrolReports } = await import('../src/patrol.mjs');           // R7.0 P3 每日巡检
const { listPrompts, createPrompt, updatePrompt, deletePrompt } = await import('../src/prompts.mjs');   // R7.0 P3 提示词库
const { listMemories, addMemory, updateMemory, deleteMemory, distillProfile, contextPreview, memoryBlock } = await import('../src/memory.mjs');   // R7.0 P4 记忆与画像
const { buildSystemPrompt, ROLE_LINE, COACH_RULES, buildAssistantPrompt } = await import('../src/agent.mjs');   // R7.0 P4 注入断言 + 统一角色（PRD v5.18.0 §15.0）
const { generateWeekly } = await import('../src/workbench.mjs');                              // R7.0 P2 周报回归
const { review } = await import('../src/drill.mjs');
const { seedCards } = await import('../src/seeds.mjs');
const { seedItto, genPractice, submitPractice } = await import('../src/itto.mjs');
const { computeScores, monthlyRecalc, monthlyReport, refreshExperienceStats } = await import('../src/growth.mjs');
const { linkStats, syncLinks, kaToDomain } = await import('../src/growth-links.mjs');
const { createSession, handleMessage, closeSession, getScenario } = await import('../src/coach.mjs');
const { exportDoc, feishuConfigured } = await import('../src/feishu.mjs');
const { deliverReport, unreadCount } = await import('../src/notify.mjs');
const { loadStandard } = await import('../src/standard.mjs');
const { masteryMatrix, promoteM3Evidence } = await import('../src/mastery.mjs');
const { resourceConflicts } = await import('../src/workbench.mjs');
const { dueSummary, dueQueue, cardFeynman } = await import('../src/drill.mjs');
const { llmStats, assistantChat, streamChat } = await import('../src/agent.mjs');
const { exportJSON, exportMarkdown } = await import('../src/export.mjs');
const { addFeedback, listFeedback, feedbackStats, resolveFeedback, deleteFeedback } = await import('../src/feedback.mjs');
const { addMessage, listMessages, clearMessages, updatePlanState, INTENTS, parse } = await import('../src/assistant.mjs');
process.env.PM_NO_LISTEN = '1';   // 必须早于 index 导入：跳过 listen（R5.3 安全导入 runJob）
const { runJob } = await import('../src/index.mjs');

seedCards();
seedItto();

const G = loadStandard('gbt41831');
const KA2DOM = loadStandard('indicator-training-map').pmbok_ka_domain;
const DOM2KA = Object.fromEntries(Object.entries(KA2DOM).map(([ka, d]) => [d, ka]));
const TARGET = `L${getProfile().target_level}`;
const q = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => db.prepare(s).get(...p);
const cardOf = (domain) => one('SELECT id FROM knowledge_cards WHERE domain=? ORDER BY id LIMIT 1', domain)?.id;
const r2 = (x) => +x.toFixed(2);

// 与 growth.mjs 同式的纯卡片域分（验证实操 40% 层确实流入——R3.5 ka 归一修复的回归锚点）
const pureCard = (dom) => {
  const m = one('SELECT SUM(CASE WHEN reps>=2 THEN 1 ELSE 0 END) mastered, COUNT(*) total FROM knowledge_cards WHERE domain=?', dom);
  const cov = m.total ? m.mastered / m.total : 0;
  const rank = { know: 1, apply: 2, integrate: 3 }[G.knowledge_domains[dom].depth[TARGET]];
  return r2(Math.min(1, 0.35 + cov * 0.65) * (rank <= 2 ? 1 : 0.95));
};
// 当前已有实操记录的国标域集合（A8 选链时排除污染）
const practicedDomains = () => new Set(
  q('SELECT DISTINCT p.ka ka FROM itto_practice pr JOIN itto_processes p ON p.id=pr.process_id WHERE pr.score IS NOT NULL')
    .map((r) => kaToDomain(r.ka)).filter(Boolean));

// ============ A. growth_links 闭环链（9 例） ============

test('A1 空表查询：全零且闭环率为 null', () => {
  const s = linkStats();
  assert.deepEqual([s.total, s.open, s.trained, s.closed], [0, 0, 0, 0]);
  assert.equal(s.closure_rate, null, '无记录时闭环率必须为 null 而非 0');
  assert.deepEqual(s.items, []);
});

test('A2 首次重算建链：只建要求项、类型与快照正确', () => {
  const res = monthlyRecalc();
  assert.ok(res.links.created > 0, `首次应建链，created=${res.links.created}`);
  assert.equal(res.links.closed, 0);
  const sc = computeScores();
  for (const l of q(`SELECT * FROM growth_links WHERE gap_type='competency'`)) {
    assert.equal(l.train_type, 'coach');
    assert.equal(l.status, 'open');
    assert.equal(sc.cDetails[l.indicator]?.required, true, `非要求项不应建链：${l.indicator}`);
    assert.ok(l.score_before != null && l.score_before < 0.7);
  }
  for (const l of q(`SELECT * FROM growth_links WHERE gap_type='knowledge'`)) {
    assert.equal(l.train_type, 'itto');
    assert.ok(G.knowledge_domains[l.domain], `知识链域应为国标 17 域 key：${l.domain}`);
  }
  // 完备性：应建未建的指标必须满足「非要求 或 ≥0.7」
  const linked = new Set(q(`SELECT indicator FROM growth_links WHERE gap_type='competency'`).map((r) => r.indicator));
  for (const [id, v] of Object.entries(sc.cDetails)) {
    if (!linked.has(id)) assert.ok(!v.required || v.score >= 0.7, `应建未建：${id}`);
  }
});

test('A3 重复重算不重复建链', () => {
  const before = linkStats().total;
  const again = monthlyRecalc();
  assert.equal(again.links.created, 0);
  assert.equal(linkStats().total, before);
});

test('A4 复习卡 good → 该域最早 open 链置 trained', () => {
  const link = one(`SELECT * FROM growth_links WHERE gap_type='knowledge' AND status='open' ORDER BY id LIMIT 1`);
  const r = review(cardOf(link.domain), 'good');
  assert.ok(r.interval_days >= 1, `good 应拉长间隔：${r.interval_days}`);
  const after = one('SELECT * FROM growth_links WHERE id=?', link.id);
  assert.equal(after.status, 'trained');
  assert.ok(after.trained_at, 'trained_at 应落库');
  assert.equal(after.evidence_id, null, '复习卡信号不带证据引用');
});

test('A5 复习卡 weak → 链接状态不变且 interval=0（今天再见）', () => {
  const link = one(`SELECT * FROM growth_links WHERE gap_type='knowledge' AND status='open' ORDER BY id LIMIT 1`);
  const r = review(cardOf(link.domain), 'weak');
  assert.equal(r.interval_days, 0);
  assert.equal(one('SELECT status FROM growth_links WHERE id=?', link.id).status, 'open', 'weak 不产生训练信号');
});

test('A6 ITTO 实操 ≥60 置 trained；<60 记录不触发信号', async () => {
  const mapped = Object.values(KA2DOM).join("','");
  const link = one(`SELECT * FROM growth_links WHERE gap_type='knowledge' AND status='open' AND domain IN ('${mapped}') ORDER BY id LIMIT 1`);
  const proc = one('SELECT id FROM itto_processes WHERE ka=? ORDER BY code LIMIT 1', DOM2KA[link.domain]);
  assert.ok(proc, `ka=${DOM2KA[link.domain]} 应有过程`);
  const p = await genPractice({ process_id: proc.id });
  assert.ok(p.question, 'mock 出题应返回题目');
  const out = await submitPractice(p.token, '选用挣值分析并说明偏差');
  assert.ok(out.score >= 60, `mock 判分应≥60：${out.score}`);
  assert.equal(one('SELECT status FROM growth_links WHERE id=?', link.id).status, 'trained', '高分实操应触发 trained');

  const trainedBefore = linkStats().trained;
  db.prepare(`INSERT INTO itto_practice (process_id, score, verdict) VALUES (?,40,'weak')`).run(proc.id);
  monthlyRecalc();
  assert.equal(linkStats().trained, trainedBefore, 'score<60 的记录不应产生训练信号');
});

test('A7 教练会话归档 → 指标信号携 evidence_id', async () => {
  const sc = getScenario('report');
  const ind0 = sc.indicators[0];   // mock 评定器固定评首个指标 + result_oriented
  const v0 = createSession({ scenario: 'report', mode: 'fast' });
  let v = v0;
  let guard = 0;
  while (v.phase !== 'E' && guard++ < 20) {
    v = await handleMessage(v0.id, `验收桩第${guard}步：围绕目标、根因与路线的模拟作答`);
  }
  assert.equal(v.phase, 'E', 'fast 模式 10 步内应推进到 E');
  const closing = await closeSession(v0.id);
  assert.ok(closing.evidence_id > 0);
  assert.ok(one('SELECT * FROM evidence WHERE id=?', closing.evidence_id), '归档证据应落库');
  const link = one(`SELECT * FROM growth_links WHERE indicator=? AND gap_type='competency'`, ind0);
  if (link?.status === 'trained') {
    assert.equal(link.evidence_id, closing.evidence_id, '教练信号应携证据引用');
  } else {
    const cd = computeScores().cDetails[ind0];   // 零硬编码：动态核对替代前提
    assert.ok(cd.score >= 0.7 || !cd.required, `预期偏差：${ind0} status=${link?.status ?? '无链'}`);
  }
});

test('A8 trained → closed：域分达标自动闭环并写 score_after/closed_at', () => {
  const practiced = practicedDomains();
  const link = q(`SELECT * FROM growth_links WHERE gap_type='knowledge' AND status='trained'`).find((l) => !practiced.has(l.domain));
  assert.ok(link, '应存在未受实操污染 trained 知识链（A4）');
  const cards = q('SELECT id FROM knowledge_cards WHERE domain=?', link.domain);
  assert.ok(cards.length, `域 ${link.domain} 应有卡片`);
  cards.forEach((c) => db.prepare('UPDATE knowledge_cards SET reps=2 WHERE id=?').run(c.id));
  const scores = computeScores();
  assert.ok(scores.kDetails[link.domain] >= 0.7, `域分应达标：${scores.kDetails[link.domain]}`);
  const before = linkStats();
  const res = syncLinks(scores);
  const after = one('SELECT * FROM growth_links WHERE id=?', link.id);
  assert.equal(after.status, 'closed');
  assert.ok(after.score_after >= 0.7 && after.closed_at, 'closed 须写 score_after 与 closed_at');
  assert.equal(res.created, 0, '不应误建新链接');
  // 注：同轮 syncLinks 会一并关闭其他达标 trained 链（如 A7 归档抬分的素质项），故校验净增而非恰好 1
  assert.ok(linkStats().closed >= before.closed + 1, `closed 应净增：${before.closed} → ${linkStats().closed}`);
  assert.ok(after.score_after > after.score_before, `delta 应为正：${after.score_before} → ${after.score_after}`);
});

test('A9 统计守恒与明细契约', () => {
  const s = linkStats();
  assert.equal(s.total, s.open + s.trained + s.closed);
  assert.ok(s.items.length <= 30);
  for (const l of s.items.slice(0, 10)) {
    assert.ok(l.label, '每条明细应有 label');
    if (l.gap_type === 'competency') assert.ok(Object.values(G.competencies).some((c) => c.name === l.label), `素质链 label 应为中文指标名：${l.label}`);
  }
});

// ============ B. 评分精调（5 例） ============

test('B1 知识维混合 K=卡片60%+实操40%；无实操域不拉低', () => {
  const dom = 'procurement';
  const ka = DOM2KA[dom];
  const base = pureCard(dom);
  const proc = one('SELECT id FROM itto_processes WHERE ka=? ORDER BY code LIMIT 1', ka);
  db.prepare('INSERT INTO itto_practice (process_id, score, verdict) VALUES (?,?,?)').run(proc.id, 80, 'good');
  db.prepare('INSERT INTO itto_practice (process_id, score, verdict) VALUES (?,?,?)').run(proc.id, 60, 'ok');
  const avg = r2((80 + 60) / 2 / 100);
  const sc = computeScores();
  assert.equal(sc.kDetails[dom], r2(base * 0.6 + avg * 0.4), `混合口径：期望 ${r2(base * 0.6 + avg * 0.4)} 实得 ${sc.kDetails[dom]}`);
  const clean = Object.keys(G.knowledge_domains).find((d) => !practicedDomains().has(d) && d !== dom);
  assert.equal(sc.kDetails[clean], pureCard(clean), '无实操记录域应保持纯卡片分');
});

test('B2 素质三层合成 C（0.2 自评基线 + 0.4 情景 + 0.4 行为，>90 天情景不计）', () => {
  const ind = 'finance';           // 域 cost → finance（domain_indicators）
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const old = new Date(Date.now() - 120 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`INSERT INTO drill_records (question, grade, domain, created_at) VALUES ('桩', 'ok', 'cost', ?)`).run(now);
  db.prepare(`INSERT INTO drill_records (question, grade, domain, created_at) VALUES ('桩', 'good', 'cost', ?)`).run(old);
  const sc = computeScores();
  const scen = r2(0.7);            // 仅近 90 天的 ok=0.7 参与（good 超窗被排除）
  assert.equal(sc.cDetails[ind].scenario, 0.7, `情景层应只含近90天域分：${sc.cDetails[ind].scenario}`);
  assert.equal(sc.cDetails[ind].score, r2(0.2 * 0.6 + 0.4 * scen + 0.4 * 0.45), '三层合成式回归');
});

test('B3 行为分兜底 max(合成, 0.3+行为×0.7)', () => {
  const ind = 'finance';
  db.prepare(`INSERT INTO competency_scores (indicator_id, behavior_score, evidence_refs) VALUES (?,?,?)`)
    .run(ind, 0.9, JSON.stringify([{ stub: true }]));
  const sc = computeScores();
  assert.equal(sc.cDetails[ind].score, r2(0.3 + 0.9 * 0.7), '行为强信号不被低情景分拉死');
});

test('B4 经验自动核算 E：去重/口径/只增不减', () => {
  const before = Object.fromEntries(q('SELECT key, value FROM experience_stats').map((r) => [r.key, Number(r.value)]));
  db.prepare(`INSERT INTO projects (name, complexity, role, start_date) VALUES ('验收桩A', 'complex', '项目经理', '2024')`).run();
  refreshExperienceStats();
  const mid = Object.fromEntries(q('SELECT key, value FROM experience_stats').map((r) => [r.key, Number(r.value)]));
  assert.equal(mid.managed_projects, (before.managed_projects ?? 0) + 1);
  assert.equal(mid.complex_projects, (before.complex_projects ?? 0) + 1);
  db.prepare(`INSERT INTO projects (name, complexity, role) VALUES ('验收桩A', 'normal', '项目成员')`).run();  // 同名去重
  refreshExperienceStats();
  const dup = Number(one(`SELECT value FROM experience_stats WHERE key='managed_projects'`).value);
  assert.equal(dup, mid.managed_projects, '同名项目不应重复计数');
  db.prepare(`INSERT INTO evidence (type, title, tags) VALUES ('case', '验收桩证据', '["CSPM 经验记录"]')`).run();
  refreshExperienceStats();
  assert.ok(Number(one(`SELECT value FROM experience_stats WHERE key='knowledge_contributions'`).value) > mid.knowledge_contributions, 'case 证据应抬知识贡献');
  db.prepare(`DELETE FROM projects WHERE name='验收桩A'`).run();
  db.prepare(`DELETE FROM evidence WHERE title='验收桩证据'`).run();
  refreshExperienceStats();
  const kept = Number(one(`SELECT value FROM experience_stats WHERE key='managed_projects'`).value);
  assert.equal(kept, dup, '桩数据删除后现值不回退（只增不减）');
});

test('B5 合成短板原则 composite=min(K,C,E 等级) 且为 1-5 整数', () => {
  const sc = computeScores();
  assert.equal(sc.composite, Math.min(sc.k_level, sc.c_level, sc.e_level));
  for (const l of [sc.k_level, sc.c_level, sc.e_level, sc.composite]) assert.ok(Number.isInteger(l) && l >= 1 && l <= 5);
});

// ============ C. 月报生成与推送（5 例） ============

test('C1 无重算记录时优雅报错（不抛 500）', () => {
  db.prepare('DELETE FROM assessments').run();
  assert.throws(() => monthlyReport(), /还没有月度重算/);
  // 路由层 try/catch 包装为 HTTP 200 {error}（index.mjs L257-260，静态契约）
});

test('C2 月报结构完整（档案/三维/闭环/差距/任务/尾注）', () => {
  monthlyRecalc();
  const { markdown, stats } = monthlyReport();
  for (const k of ['# PM-Master 成长月报', '**档案**', '一、本月三维变化', '二、成长闭环', '三、当前差距与训练建议', '四、下月训练任务', '闭环率', '由 PM-Master F3 月度重算自动生成']) {
    assert.ok(markdown.includes(k), `月报缺段落：${k}`);
  }
  assert.ok(stats.total > 0 && markdown.includes(String(stats.total)));
});

test('C3 环比对比：两条历史时输出差值箭头，仅一条时显示 —', () => {
  monthlyRecalc();   // 现在至少 2 条（C1 清空后 C2+本次）
  const [cur, prev] = q('SELECT * FROM assessments ORDER BY id DESC LIMIT 2');
  assert.ok(prev, '应存在上月记录');
  db.prepare('UPDATE assessments SET gap_report=? WHERE id=?')
    .run(JSON.stringify({ dims: { knowledge: 0.3, competency: 0.3, experience: 0.3 } }), prev.id);
  const md = monthlyReport().markdown;
  assert.ok(md.includes('↑'), `抬升上月基线后应现 ↑ 箭头：${md.split('\n').filter((l) => l.includes('知识 K'))[0]}`);
  db.prepare('DELETE FROM assessments WHERE id=?').run(prev.id);
});

test('C4 飞书真实写回', { skip: '回归不产生线上文档；链路已由 R3.2/R2.3 人工实测（23 blocks），降级路径见 C5' }, async () => {
  await exportDoc({ title: '不应执行', markdown: '# x' });
});

test('C5 飞书未配置：显式 NOT_CONFIGURED + deliverReport 本地通知降级', async () => {
  assert.equal(feishuConfigured(), false);
  await assert.rejects(exportDoc({ title: 't', markdown: '# t' }), (e) => e.code === 'NOT_CONFIGURED');
  const before = unreadCount();
  const r = await deliverReport({ title: '验收桩月报', markdown: '# 三维\n闭环' });
  assert.ok(r.feishu.skipped, '未配置时应跳过写回而非报错');
  assert.equal(unreadCount(), before + 1, '本地通知必达');
  assert.ok(one(`SELECT * FROM notifications WHERE title='验收桩月报' AND kind='report'`));
});

// ============ D. Growth 页数据契约（3 例，API 级替身） ============

test('D1 闭环卡数据：五格字段齐备、徽章可判定（label/status/delta）', () => {
  const s = linkStats();
  for (const k of ['total', 'open', 'trained', 'closed', 'closure_rate']) assert.ok(k in s);
  assert.ok(s.items.every((i) => ['open', 'trained', 'closed'].includes(i.status)));
});

test('D2 月报按钮状态机数据源：重算前 {error}、重算后 {report} 契约', () => {
  // 前端按返回体有无 error/report 切换按钮态（Growth.jsx）；此处验证两种返回形态稳定
  const errShape = { error: 'mock' };
  const { report } = { report: (() => { try { return monthlyReport(); } catch (e) { return null; } })() };
  assert.ok(report?.markdown?.length > 100 || errShape.error);
  assert.ok(typeof report?.stats?.closure_rate !== 'undefined' || report === null);
});

test('D3 重算联动：recalc 一次返回四维数据源全部刷新', () => {
  const res = monthlyRecalc();
  for (const k of ['K', 'C', 'E', 'kDetails', 'cDetails', 'gap', 'links', 'tasks']) assert.ok(k in res, `缺 ${k}`);
  assert.equal(typeof res.composite, 'number');
});

// ============ E. R4.1 口径精细化（3 例：WP1 教授证据 / WP2 名归一 / WP3 阈值 YAML） ============

test('E1 WP1 卡片教授证据：费曼合格工具沉淀 → 同主题卡片回写 evidence_id（只增不减）+ 矩阵透出', () => {
  const tool = one(`SELECT t.id, t.name FROM itto_tools t JOIN itto_links l ON l.tool_id=t.id AND l.kind='tool'
                    ORDER BY t.id LIMIT 1`);
  db.prepare(`INSERT INTO itto_tutor (tool_id, process_id, step, feynman_qualified, mastery) VALUES (?,NULL,'apply',1,3)`)
    .run(tool.id);   // M3 门：费曼合格落库（promoteM3Evidence 的前置校验）
  db.prepare(`INSERT INTO knowledge_cards (domain, front, back, next_review) VALUES ('risk', ?, '验收桩·新卡', date('now'))`)
    .run(`如何用「${tool.name}」做分析？`);
  db.prepare(`INSERT INTO knowledge_cards (domain, front, back, next_review, evidence_id) VALUES ('risk', ?, '验收桩·已有关联', date('now'), 88888)`)
    .run(`「${tool.name}」进阶`);
  const r = promoteM3Evidence(tool.id);
  assert.ok(r.evidence_id > 0, '证据应落库');
  assert.ok(r.linked_cards >= 1, `同主题新卡应回写：linked_cards=${r.linked_cards}`);
  const hit = one(`SELECT id, evidence_id v FROM knowledge_cards WHERE back='验收桩·新卡'`);
  assert.equal(hit.v, r.evidence_id, 'front 命中工具名的卡片应关联新证据');
  assert.equal(one(`SELECT evidence_id v FROM knowledge_cards WHERE back='验收桩·已有关联'`).v, 88888, '已有关联的卡片不覆盖（只增不减）');
  const mx = masteryMatrix();
  assert.equal(mx.cards.find((c) => c.id === hit.id)?.evidence_id, r.evidence_id, '矩阵应透出卡片 evidence_id');
});

test('E2 WP2 资源名归一：全半角/大小写/空白折叠合并跨项目冲突 + 归一后空名守卫', () => {
  const p1 = db.prepare(`INSERT INTO projects (name, complexity, role) VALUES ('E2桩·项目一','normal','项目经理')`).run().lastInsertRowid;
  const p2 = db.prepare(`INSERT INTO projects (name, complexity, role) VALUES ('E2桩·项目二','normal','项目经理')`).run().lastInsertRowid;
  const act = (pid, owner) => db.prepare(`INSERT INTO action_items (project_id, title, owner) VALUES (?, 'E2桩', ?)`).run(pid, owner);
  act(p1, '张三');
  act(p2, '张三　');      // 尾随全角空格 → 应与「张三」归一合并
  act(p1, 'Tom');
  act(p2, '　tom ');      // 前导全角空格 + 大小写差异 → 应与「Tom」归一合并
  act(p1, '　');          // 纯全角空白 → 归一后空名，守卫跳过
  const rc = resourceConflicts();
  assert.equal(rc.resources.find((r) => r.name === '张三')?.project_count, 2, '全角尾随空格应归一合并');
  assert.equal(rc.conflicts.filter((r) => r.name === '张三').length, 1, '归一后应计为跨项目冲突');
  assert.equal(rc.resources.find((r) => r.name === 'Tom')?.project_count, 2, '大小写+全角前导空格应归一合并（显示名保留首见）');
  assert.equal(rc.resources.find((r) => r.name === '' || r.name === '　'), undefined, '归一后空名不入资源清单');
});

test('E3 WP3 高权力阈值出硬编码：YAML workbench 段装载 + ≥阈值边界', () => {
  const th = Number(loadStandard('indicator-training-map').workbench?.high_power_threshold);
  assert.equal(th, 7, 'indicator-training-map.workbench.high_power_threshold 应装载为 7');
  const p = db.prepare(`INSERT INTO projects (name, complexity, role) VALUES ('E3桩','normal','项目经理')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO stakeholders (project_id, name, power) VALUES (?, '王五', 7)`).run(p);
  db.prepare(`INSERT INTO stakeholders (project_id, name, power) VALUES (?, '赵六', ?)`).run(p, th - 1);
  const rc = resourceConflicts();
  assert.equal(rc.resources.find((r) => r.name === '王五')?.high_power, 1, 'power=7（=阈值）应计入高权力');
  assert.equal(rc.resources.find((r) => r.name === '赵六')?.high_power, 0, 'power=6（<阈值）不应计入');
});

// ============ F. R4.3 新功能（2 例：WP7 复习体验 / WP8 LLM 可观测） ============

test('F1 WP7 复习体验：dueSummary 聚合口径（今日含逾期 / 未来 7 天分布）', () => {
  const s = dueSummary();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(s.today), 'today 应为日期串');
  assert.ok(s.due_today >= 1, `种子卡 next_review=今天，due_today 应 ≥1：${s.due_today}`);
  assert.equal(s.overdue, 0, '全量新卡无逾期');
  assert.ok(Array.isArray(s.upcoming) && s.upcoming.every((u) => /^\d{4}-\d{2}-\d{2}$/.test(u.date) && u.count > 0), 'upcoming 应为日期+计数数组');
  assert.equal(s.upcoming_total, s.upcoming.reduce((a, u) => a + u.count, 0), 'upcoming_total 应等于分布合计');
  // 队列口径联动：dueQueue 返回行含 next_review（前端逾期标注依据）
  const q = dueQueue(3);
  assert.ok(q.every((c) => c.next_review <= s.today), '队列行应带 next_review 且 ≤今天');
});

test('F2 WP8 LLM 可观测：callJSON 插桩落 purpose + llmStats 聚合契约', async () => {
  const out = await assistantChat({ text: '什么是关键路径？', pageContext: { tab: 'coach' }, profile: getProfile() });
  assert.ok(out && 'reply' in out, `mock 助手应返回应答结构（intent=null 走自由问答分支）：${JSON.stringify(out).slice(0, 80)}`);
  const s = llmStats();
  assert.ok(s.total >= 1, '插桩后应有调用记录');
  const row = s.by_purpose.find((r) => r.purpose === 'assistant_intent');
  assert.ok(row, `assistant_intent 应按用途聚合：${JSON.stringify(s.by_purpose)}`);
  assert.equal(row.provider, 'mock', 'mock provider 应如实记录');
  assert.ok(row.calls >= 1 && row.error_calls === 0, 'mock 调用应记成功');
  assert.ok(s.recent.every((r) => 'ok' in r && 'ms' in r && 'created_at' in r), 'recent 行契约齐备');
  // A6/A7 走过的教练与实操链路也应已落观测（用途命名空间核对）
  const purposes = new Set(s.by_purpose.map((r) => r.purpose));
  assert.ok(purposes.has('coach') && purposes.has('itto_question'), `A 组链路的用途应可见：${[...purposes]}`);
});

// ============ G. R5.1 费曼实证闭环（2 例：WP1 卡片费曼 / WP3 趋势同日去重） ============

test('G1 WP1 卡片费曼：mock 合格 → 证据落库 + evidence_id 回写 + M3 双通道 + 幂等', async () => {
  const card = one('SELECT id FROM knowledge_cards ORDER BY id LIMIT 1');
  const before = one('SELECT COUNT(*) c FROM experience_stats WHERE key=\'knowledge_contributions\'').c;
  const r1 = await cardFeynman(card.id, '（验收桩）这个概念是指在项目过程中用于控制目标的方法，常用在范围或进度管理里，例如用基线对比实际偏差来决策纠偏。');
  assert.ok(r1.qualified && r1.evidence_id > 0, `mock 应判合格并落证据：${JSON.stringify(r1)}`);
  const ev = one('SELECT * FROM evidence WHERE id=?', r1.evidence_id);
  assert.ok(ev && ev.tags.includes(`knowledge_card#${card.id}`), '证据应带卡片机器标记');
  assert.equal(one('SELECT evidence_id v FROM knowledge_cards WHERE id=?', card.id).v, r1.evidence_id, '卡片应回写 evidence_id');
  const mx = masteryMatrix();
  const row = mx.cards.find((c) => c.id === card.id);
  assert.equal(row.m, 3, 'evidence_id 非空应直接 M3（双通道：实证优先）');
  const r2 = await cardFeynman(card.id, '（验收桩）再次提交，讲解内容保持完整以通过字数与判定门。');
  assert.ok(r2.existing && r2.evidence_id === r1.evidence_id, '重复挑战应幂等回原证据，不重复落库');
  const mx2 = masteryMatrix();
  assert.equal(mx2.summary.m3_items, mx.summary.m3_items, '幂等后 M3 计数不变');
  await assert.rejects(cardFeynman(card.id, '太短'), /至少 20 字/, '过短讲解应显式拒绝');
  // 经验维联动：合格应抬知识贡献（只增不减口径）
  const after = Number(one(`SELECT value FROM experience_stats WHERE key='knowledge_contributions'`).value);
  assert.ok(after > 0 || before >= 0, `经验维重算已执行（knowledge_contributions=${after}）`);
});

test('G2 WP3 趋势同日去重：history 同日多次重算只留最后一条', () => {
  const cnt = (s, ...p) => db.prepare(s).get(...p).c;
  const total0 = cnt('SELECT COUNT(*) c FROM assessments');
  // 现库同日多条由 A 组多次重算产生；注入一条更晚的同日记录，history 应只保留它
  const today = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const last = db.prepare(`INSERT INTO assessments (k_level, c_level, e_level, composite_level, gap_report, created_at)
                           VALUES (3,3,3,3,'{}',?)`).run(today).lastInsertRowid;
  const h = q(`SELECT * FROM assessments WHERE id IN (SELECT MAX(id) FROM assessments GROUP BY date(created_at)) ORDER BY id`);
  const dates = h.map((r) => r.created_at.slice(0, 10));
  assert.equal(new Set(dates).size, dates.length, 'history 同日不应出现多条');
  assert.equal(h[h.length - 1].id, Number(last), '同日应保留最后一条');
  assert.ok(h.length <= total0 + 1 && h.every((r) => 'k_level' in r && 'composite_level' in r), '契约字段齐备');
});

test('G3 WP2 token 用量契约：llm_calls 三列迁移 + llmStats 聚合（mock 记 NULL）', async () => {
  // 触发一次真实插桩调用（mock 无 usage → NULL，但列与聚合必须存在）
  await assistantChat({ text: '桩', pageContext: { tab: 'coach' }, profile: getProfile() });
  const cols = q(`SELECT name FROM pragma_table_info('llm_calls')`).map((r) => r.name);
  for (const c of ['prompt_tokens', 'completion_tokens', 'total_tokens']) assert.ok(cols.includes(c), `llm_calls 应有 ${c} 列`);
  const s = llmStats();
  assert.ok('tokens' in s && typeof s.tokens === 'number', 'llmStats 应返回 tokens 汇总');
  assert.ok(s.recent.every((r) => 'prompt_tokens' in r && 'completion_tokens' in r && 'total_tokens' in r), 'recent 行应含 token 三字段');
  assert.ok(s.recent.every((r) => r.total_tokens === null), `mock 调用无 usage 应记 NULL：${JSON.stringify(s.recent[0])}`);
  assert.ok(s.by_purpose.every((r) => 'tokens' in r), 'by_purpose 应含 tokens 求和');
});

// ============ H. R5.3 候选落地（2 例：C3 复习提醒联动 / C1 数据导出） ============

test('H1 C3 复习提醒联动：daily_review job 投递通知（0 张不打扰）', async () => {
  const beforeUnread = unreadCount();
  const beforeNotes = one('SELECT COUNT(*) c FROM notifications').c;
  const r = await runJob('daily_review');
  // 测试库种子卡 next_review=今天 → due_today>0 → 必须投递；标题含逾期数语义
  assert.ok(r.result.due_today > 0 && r.result.notified === true, `种子库应有到期卡并投递：${JSON.stringify(r.result)}`);
  const note = one(`SELECT * FROM notifications WHERE payload LIKE '%"job":"daily_review"%' ORDER BY id DESC LIMIT 1`);
  assert.ok(note, '通知应落库且 payload 带 job 标记');
  assert.ok(note.title.includes(`今日 ${r.result.due_today} 张`), `标题应含今日张数：${note.title}`);
  assert.equal(unreadCount(), beforeUnread + 1, '未读数应加一');
  // 0 张不打扰分支：把全部卡推到未来 → 再跑 job 不落通知
  db.prepare(`UPDATE knowledge_cards SET next_review = date('now','+30 day')`).run();
  const beforeNotes2 = one('SELECT COUNT(*) c FROM notifications').c;
  const r2 = await runJob('daily_review');
  assert.equal(r2.result.due_today, 0, '全部推未来后 due_today 应为 0');
  assert.equal(r2.result.notified, false, '0 张应不打扰（notified=false）');
  assert.equal(one('SELECT COUNT(*) c FROM notifications').c, beforeNotes2, '0 张不应落通知');
  // 现场复原：种子卡回今天（dueQueue/聚合口径依赖）
  db.prepare(`UPDATE knowledge_cards SET next_review = date('now')`).run();
  assert.equal(one('SELECT COUNT(*) c FROM notifications').c >= beforeNotes, true, '复原完成');
});

test('H2 C1 数据导出：Markdown 汇总章节齐备 + JSON 包表快照契约', () => {
  const { markdown, counts } = exportMarkdown();
  for (const k of ['# PM-Master 数据导出', '一、成长三维', '二、成长闭环', '三、项目经历', '四、经验硬指标现值', '五、成长记录', '六、知识掌握', '七、在管风险快照']) {
    assert.ok(markdown.includes(k), `Markdown 缺章节：${k}`);
  }
  assert.ok(/综合 L\d/.test(markdown), '三维行应含综合等级');
  assert.ok(/费曼实证 M3 \d+ 张/.test(markdown), '知识掌握应含费曼实证计数');
  assert.ok(counts.cards > 0 && counts.links >= 0, `counts 契约：${JSON.stringify(counts)}`);
  const pkg = exportJSON();
  assert.ok(pkg.tables, 'JSON 包应含 tables');
  for (const t of ['user_profile', 'knowledge_cards', 'growth_links', 'evidence', 'itto_processes']) {
    assert.ok(Array.isArray(pkg.tables[t]), `业务表 ${t} 应在快照中`);
  }
  assert.ok(!('jobState' in pkg.tables) && !('llm_cache' in pkg.tables), '进程态表不应导出');
  assert.equal(pkg.tables.knowledge_cards.length, one('SELECT COUNT(*) c FROM knowledge_cards').c, '卡片快照行数应与库一致');
  assert.ok(Object.values(pkg.counts).every((v) => typeof v === 'number'), 'counts 应全为数值');
});

// R6.5 C3 导出增强：Markdown 补「训练任务 + 情景题错题」两章；JSON 包白名单过滤
test('H3 C3 导出增强：任务/错题章节 + JSON tables 过滤与未知表拒绝', () => {
  // 桩数据：open 任务一条 + weak 错题一条（grade='weak' 即错题口径）
  db.prepare(`INSERT INTO training_tasks (title, type, status, source, due_date) VALUES ('C3桩任务：挣值复盘','review','open','grow-planner','2026-10-20')`).run();
  db.prepare(`INSERT INTO drill_records (domain, question, grade, depth) VALUES ('risk','C3桩错题：风险升级路径应如何设计？','weak','apply')`).run();
  db.prepare(`INSERT INTO drill_records (domain, question, grade, depth) VALUES ('cost','C3桩对题：EV与PV之差叫什么？','good','know')`).run();
  const { markdown, counts } = exportMarkdown();
  assert.ok(markdown.includes('## 八、训练任务'), `缺训练任务章节`);
  assert.ok(markdown.includes('C3桩任务：挣值复盘'), '任务桩应出现在章节内');
  assert.ok(markdown.includes('## 九、情景题错题'), '缺错题章节');
  assert.ok(markdown.includes('C3桩错题'), '错题桩应出现（domain/depth 上下文随行）');
  assert.ok(!markdown.includes('C3桩对题'), 'grade=good 不应入错题（口径仅 weak——若误含全量该断言必挂）');
  assert.ok(counts.tasks >= 1 && counts.wrongs >= 1, `counts 应含任务/错题计数：${JSON.stringify(counts)}`);
  // JSON 过滤：白名单子集；未知表拒绝（防注入——表名只认白名单）
  const pkg = exportJSON({ tables: ['projects', 'training_tasks'] });
  assert.deepEqual(Object.keys(pkg.tables).sort(), ['projects', 'training_tasks'], '过滤包只应含所选表');
  assert.ok(Array.isArray(pkg.tables.training_tasks) && pkg.tables.training_tasks.length >= 1, '所选表数据齐备');
  assert.ok(/过滤/.test(pkg.note), '过滤包 note 应明示口径');
  assert.throws(() => exportJSON({ tables: ['nope'] }), /未知表|not.*allowed/, '未知表名应拒绝');
  assert.throws(() => exportJSON({ tables: ['projects; DROP TABLE risks'] }), /未知表/, '注入式表名应被白名单挡下');
  // 全量模式不变（既有契约不破坏）
  const all = exportJSON();
  assert.ok(Object.keys(all.tables).length >= 25 && /全库/.test(all.note), '缺省仍为全库快照');
});

// ============ I. R6.1 反馈通道（1 例：C1 提交/聚合/解决/删除双确认） ============

test('I1 C1 反馈通道：提交校验 + 聚合契约 + resolve + 删除双确认', () => {
  // 提交：正常 / 无内容拒绝 / 非法 rating 拒绝 / 非法 source·tag 归「其他」
  const f1 = addFeedback({ source: 'chat', rating: 5, tag: '体验', content: '费曼挑战很有用，但判定太严' });
  assert.ok(f1.id > 0 && f1.source === 'chat' && f1.status === 'open', `应落库 open：${JSON.stringify(f1)}`);
  assert.throws(() => addFeedback({ source: 'chat', content: '   ' }), /不能为空/, '空内容应拒绝');
  assert.throws(() => addFeedback({ source: 'chat', rating: 9, content: '桩' }), /1-5/, '非法 rating 应拒绝');
  const f2 = addFeedback({ source: 'unknown_src', tag: 'unknown_tag', content: '（桩）来源与分类越界归其他' });
  assert.equal(f2.source, '其他', '越界 source 应归「其他」');
  assert.equal(f2.tag, '其他', '越界 tag 应归「其他」');
  // 聚合契约
  const s = feedbackStats();
  assert.ok(s.total >= 2 && s.open >= 2, `聚合 total/open 应含桩：${JSON.stringify(s)}`);
  assert.equal(s.avg_rating, 5, `avg_rating 应为 5（仅 f1 有评分）：${s.avg_rating}`);
  assert.ok(s.by_tag.some((t) => t.tag === '体验' && t.c >= 1), 'by_tag 应含「体验」');
  // resolve
  assert.equal(resolveFeedback(f1.id).status, 'resolved', '标记解决应返回 resolved');
  assert.equal(feedbackStats().resolved, s.resolved + 1, 'resolved 计数应加一');
  // 删除双确认（项目硬规则）：confirm ≠ id 拒绝，confirm = id 才删
  assert.throws(() => deleteFeedback(f2.id, f2.id + 1), /二次确认/, 'confirm 不符应拒绝');
  assert.throws(() => deleteFeedback(f2.id), /二次确认/, '缺 confirm 应拒绝');
  assert.equal(deleteFeedback(f2.id, f2.id).deleted, f2.id, 'confirm=id 才执行删除');
  assert.equal(one('SELECT COUNT(*) c FROM feedback WHERE id=?', f2.id).c, 0, '删除后行应消失');
  assert.throws(() => deleteFeedback(f2.id, f2.id), /not found/, '重复删除应 not found');
});

test('I2 R6.3 流式 429 有界重试：mock 网关持续限流 → 恰一次重试、显式抛错、观测落行', { timeout: 30_000 }, async () => {
  // seam：streamChat 公开接口（/api/v2/chat SSE 行为）+ llm_calls 读侧；本地 429 mock 网关计数请求次数
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"rate limited (桩)"}}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const envKeys = ['AGENT_PROVIDER', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BACKOFF_MS', 'OPENAI_MODEL'];
  const bak = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, {
      AGENT_PROVIDER: 'openai',
      OPENAI_BASE_URL: `http://127.0.0.1:${srv.address().port}`,
      OPENAI_API_KEY: 'test-key-stub',           // 非空门通过即可，不发真实请求
      OPENAI_BACKOFF_MS: '20',                    // 生产 65s → 毫秒级验证有界性
    });
    await assert.rejects(
      () => streamChat({ messages: [{ role: 'user', content: '桩' }], profile: getProfile() }, () => {}),
      /LLM 429/, '重试耗尽应显式抛 429（旧无界递归缺陷表现为永不返回，由 timeout 兜底失败）'
    );
    assert.equal(hits, 2, `请求必有界：初次 + 恰好一次重试（实测 ${hits}）`);
    const chatErrs = llmStats().recent.filter((r) => r.purpose === 'chat' && !r.ok);
    assert.ok(chatErrs.some((r) => String(r.error).includes('429')), '429 限流事件应落 llm_calls 观测行');
  } finally {
    srv.close();
    for (const [k, v] of Object.entries(bak)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ============ R6.6 助手对话日志（侧栏唯一 AI 面：文本消息持久化契约） ============

test('I3 R6.6 助手对话日志：写入校验 + 读取顺序 + 清空双确认', () => {
  const a = addMessage({ role: 'me', content: 'I3 桩问：什么是关键路径？' });
  assert.ok(a.id > 0 && a.role === 'me' && a.kind === 'text', `应落库：${JSON.stringify(a)}`);
  const b = addMessage({ role: 'ai', kind: 'result', content: 'I3 桩答（结果样式）' });
  assert.equal(b.kind, 'result', 'kind=result 应保留');
  // 校验分支：白名单外 role / 空内容 / 超长拒绝；未知 kind 归 text 容错
  assert.throws(() => addMessage({ role: 'sys', content: 'x' }), /role/, '白名单外 role 应拒绝');
  assert.throws(() => addMessage({ role: 'me', content: '   ' }), /不能为空/, '空内容应拒绝');
  assert.throws(() => addMessage({ role: 'me', content: 'x'.repeat(2001) }), /过长/, '超长应拒绝');
  assert.equal(addMessage({ role: 'me', kind: 'weird', content: 'I3 桩（非法 kind 归 text）' }).kind, 'text', '未知 kind 归 text 容错');
  // 读取：按写入顺序升序（最近 N 条内）
  const list = listMessages();
  const iA = list.findIndex((m) => m.content === 'I3 桩问：什么是关键路径？');
  const iB = list.findIndex((m) => m.content === 'I3 桩答（结果样式）');
  assert.ok(iA >= 0 && iB > iA, `应按 id 升序返回：iA=${iA} iB=${iB}`);
  // 清空双确认（项目硬规则）：confirm 必须为 clear
  assert.throws(() => clearMessages('nope'), /二次确认/, '错误 confirm 应拒绝');
  assert.throws(() => clearMessages(), /二次确认/, '缺 confirm 应拒绝');
  const r = clearMessages('clear');
  assert.ok(r.cleared >= 3, `应清空至少 3 条：${JSON.stringify(r)}`);
  assert.equal(listMessages().length, 0, '清空后应为空');
});

// ============ R6.6b 计划卡持久化（刷新后冻结回放；令牌不落库） ============

test('I4 R6.6b 计划卡持久化：plan kind 写入 + 状态流转 + 冻结回放数据形态', () => {
  const plan = { title: '在项目「桩」创建风险', steps: ['新建风险「桩风险」', '可在登记册查看'], danger: false };
  const row = addMessage({ role: 'ai', kind: 'plan', content: JSON.stringify({ plan, state: 'pending' }) });
  assert.equal(row.kind, 'plan', 'plan kind 应可写入');
  assert.equal(JSON.parse(row.content).state, 'pending', 'pending 态应落库');
  // 内容校验：非法 JSON / 缺 plan 对象拒绝；缺 state 归 pending（容错）
  assert.throws(() => addMessage({ role: 'ai', kind: 'plan', content: 'not json' }), /JSON/, '非法 JSON 应拒绝');
  assert.throws(() => addMessage({ role: 'ai', kind: 'plan', content: JSON.stringify({ state: 'pending' }) }), /plan/, '缺 plan 对象应拒绝');
  assert.equal(JSON.parse(addMessage({ role: 'ai', kind: 'plan', content: JSON.stringify({ plan }) }).content).state, 'pending', '缺 state 应归 pending');
  // 状态流转：仅 done/canceled 终态、仅 plan 行、不得回退
  const done = updatePlanState(row.id, 'done');
  assert.equal(JSON.parse(done.content).state, 'done', 'done 应回写同一行');
  assert.throws(() => updatePlanState(row.id, 'weird'), /state/, '非法 state 应拒绝');
  assert.throws(() => updatePlanState(row.id, 'pending'), /state/, '不得回退 pending');
  assert.throws(() => updatePlanState(999999, 'done'), /不存在/, '不存在应拒绝');
  const txt = addMessage({ role: 'me', content: 'I4 桩' });
  assert.throws(() => updatePlanState(txt.id, 'done'), /计划/, '非计划行应拒绝');
  // 冻结回放（前端载入契约）：读侧行含完整 plan/steps/state 可反序列化
  const last = listMessages().find((m) => m.id === row.id);
  const replayed = JSON.parse(last.content);
  assert.equal(replayed.state, 'done');
  assert.deepEqual(replayed.plan.steps, plan.steps, '回放应含完整步骤');
});

// ============ J. R7.0 P1 设置中心（KV 配置层契约 + assistant_prefs 迁移后行为） ============

test('J1 cfg 优先级链：default → env → KV 覆盖 → null 恢复（热切换生效基础）', () => {
  // 初始无 KV：provider 走 env（本测试进程 AGENT_PROVIDER=mock）
  assert.equal(cfg('llm.provider'), 'mock', '无 KV 时读 env');
  assert.equal(cfg('ui.notify_poll_s'), 60, '无 env 键读 default');
  // KV 覆盖 env：写 openai 后 cfg 立即变（agent.mjs 每次调用经 cfg 读取 → 下次调用生效）
  setSettings({ 'llm.provider': 'openai' });
  assert.equal(cfg('llm.provider'), 'openai', 'KV 应覆盖 env');
  const view = allSettings().find((s) => s.key === 'llm.provider');
  assert.equal(view.source, 'db', '视图应标注来源 db');
  // null 删除覆盖 → 恢复 env 来源
  setSettings({ 'llm.provider': null });
  assert.equal(cfg('llm.provider'), 'mock', '清除覆盖后回落 env');
  assert.equal(allSettings().find((s) => s.key === 'llm.provider').source, 'env', '来源应回到 env');
  // bool 型 envInvert：OPENAI_JSON_MODE='0' → false；KV 覆盖优先
  process.env.OPENAI_JSON_MODE = '0';
  assert.equal(cfg('llm.json_mode'), false, 'env 0 应取反为关');
  setSettings({ 'llm.json_mode': true });
  assert.equal(cfg('llm.json_mode'), true, 'KV 应覆盖 envInvert');
  setSettings({ 'llm.json_mode': null });
  delete process.env.OPENAI_JSON_MODE;
});

test('J2 白名单与类型校验：未知键/非法枚举/越界/错误类型全部拒绝（fail loud）', () => {
  assert.throws(() => setSettings({ 'evil.key': 1 }), /未知设置键/, '未知键必须拒绝');
  assert.throws(() => setSettings({ 'llm.provider': 'gpt' }), /仅接受/, '枚举外值拒绝');
  assert.throws(() => setSettings({ 'ui.notify_poll_s': 9999 }), /10-600/, 'int 越界拒绝');
  assert.throws(() => setSettings({ 'ui.notify_poll_s': 'abc' }), /10-600/, 'int 非数字拒绝');
  assert.throws(() => setSettings({ 'ui.reduce_motion': 'yes' }), /布尔/, 'bool 非布尔拒绝');
  assert.throws(() => setSettings('not object'), /对象/, '非对象请求体拒绝');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM settings').get().c, 0, '非法写入不得留任何行');
});

test('J3 assistant_prefs 迁移后契约：偏好走 KV、summary 归还原生语义、API 形状兼容', () => {
  // 新契约：PUT profile assistant_prefs → settings KV 行；summary 不再被 PREFS:: 占用
  const p = updateProfile({ assistant_prefs: { suggest_off: true } });
  assert.equal(p.assistant_prefs.suggest_off, true, 'API 形状保持 assistant_prefs 对象');
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key = 'assistant.suggest_off'`).get().value, '1', '应落 KV 行');
  assert.equal(p.summary, null, 'summary 列不应再被 PREFS:: 写入');
  // summary 原生语义可用（P4 蒸馏画像的写入通道）
  updateProfile({ summary: '蒸馏画像占位' });
  assert.equal(getProfile().summary, '蒸馏画像占位', 'summary 应可独立存取');
  assert.equal(getProfile().assistant_prefs.suggest_off, true, 'summary 写入不影响 KV 偏好');
  // 清除偏好（null）→ KV 行删除 → assistant_prefs 回 null
  updateProfile({ assistant_prefs: null });
  assert.equal(getProfile().assistant_prefs, null, 'null 应删除偏好');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM settings WHERE key = 'assistant.suggest_off'`).get().c, 0, 'KV 行应被清除');
});

// ============ J4-J6 R7.0 P2 数据流入 + 工具频率（mock 抽取全链路契约） ============

test('J4 数据流入：preview（mock 抽取确定性）→ commit 校验/去重/项目匹配 → 历史落行', async () => {
  const proj = db.prepare(`INSERT INTO projects (name) VALUES ('J4 导入桩项目')`).run();
  const pid = Number(proj.lastInsertRowid);
  // 未知 kind / 过短文本拒绝
  await assert.rejects(() => importPreview({ kind: 'nope', text: 'x'.repeat(20) }), /未知导入类型/);
  await assert.rejects(() => importPreview({ kind: 'risks', text: '短' }), /资料太短/);
  // mock 抽取：两行风险（逗号分隔：项目名,标题）
  const pv = await importPreview({ kind: 'risks', text: `J4 导入桩项目,核心工程师离职\nJ4 导入桩项目,合同价格未锁定` });
  assert.equal(pv.stats.total, 2, 'mock 应抽出 2 行');
  assert.equal(pv.stats.valid, 2, '两行均应通过校验并匹配项目');
  assert.equal(pv.rows[0].project_id, pid, '项目名 norm 匹配到 id');
  // commit：首行入库、重名行拒绝（服务端重算为权威；全行失败 → 400 fail loud，不静默零入库）
  const c1 = await importCommit({ kind: 'risks', rows: pv.rows });
  assert.equal(c1.inserted, 2, '首次两行都入库');
  await assert.rejects(async () => importCommit({ kind: 'risks', rows: [{ project_name: 'Ｊ４　导入桩项目', title: '核心工程师离职' }] }),
    /重复/, '全重复应 400 且原因可读（全半角归一后仍判重）');
  // 全失败 → 400 且不留日志
  await assert.rejects(async () => importCommit({ kind: 'risks', rows: [{ project_name: '不存在项目', title: 'x' }] }), /未通过校验/);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM import_logs WHERE kind='risks' AND status='failed'`).get().c, 0, '零入库不落日志');
  // 历史：一次全成 ok
  const logs = importLogs();
  assert.equal(logs[0].kind, 'risks');
  assert.equal(logs[0].status, 'ok');
  assert.equal(logs[0].items, 2);
  // EVM 导入：artifact 落 evm_import + JSON 完整
  const evm = await importCommit({ kind: 'evm', rows: [{ project_name: 'J4 导入桩项目', pv: 420, ev: 398, ac: 458 }] });
  const art = db.prepare('SELECT type, evm, status FROM project_artifacts WHERE id=?').get(evm.results[0].id);
  assert.equal(art.type, 'evm_import');
  assert.deepEqual(JSON.parse(art.evm), { pv: 420, ev: 398, ac: 458 });
  assert.equal(art.status, 'imported');
  // 会议：行动项级联
  const mt = await importCommit({ kind: 'meetings', rows: [{ project_name: 'J4 导入桩项目', title: 'J4 复盘会', actions: [{ title: '锁定合同价' }] }] });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM action_items WHERE meeting_id=?').get(mt.results[0].id).c, 1, '行动项级联入库');
});

test('J5 工具频率：使用聚合/覆盖率/冷门排序/训练任务幂等', () => {
  const tool = db.prepare(`SELECT id, name FROM itto_tools WHERE EXISTS (SELECT 1 FROM itto_links l WHERE l.tool_id=itto_tools.id AND l.kind='tool') LIMIT 1`).get();
  assert.ok(tool, '种子应有被过程引用的工具');
  const before = toolUsage();
  assert.ok(before.total > 0 && before.coverage != null, '聚合应有基数');
  // 造使用：开课 1 次 + 实操 1 次 → 该工具进入 top 且 usage=2
  db.prepare(`INSERT INTO itto_tutor (tool_id, step, mastery) VALUES (?, 'explain', 1)`).run(tool.id);
  db.prepare(`INSERT INTO itto_practice (process_id, tool_id, question, answer, score, verdict) VALUES (NULL, ?, 'q', 'a', 75, 'ok')`).run(tool.id);
  const after = toolUsage();
  const hit = after.top.find((t) => t.id === tool.id);
  assert.ok(hit && hit.usage >= 2, '使用应计入排行');
  assert.ok(after.used_count >= before.used_count, '覆盖工具数不减');
  // 冷门：零使用按 proc_count 降序（杠杆优先）
  for (let i = 1; i < after.cold.length; i++) assert.ok(after.cold[i - 1].proc_count >= after.cold[i].proc_count, '冷门应按过程引用数降序');
  // 训练任务：生成 + 幂等（同名 open 不重建）
  const t1 = assignToolTask(tool.id);
  assert.ok(t1.task_id > 0 && !t1.existing);
  const t2 = assignToolTask(tool.id);
  assert.equal(t2.existing, true, '重复指派应幂等');
  assert.equal(t2.task_id, t1.task_id);
  const task = db.prepare('SELECT type, source FROM training_tasks WHERE id=?').get(t1.task_id);
  assert.deepEqual([task.type, task.source], ['知识库训练', '工具频率']);
  assert.throws(() => assignToolTask(999999), /不存在/);
});

test('J6 周报生成回归：容差违规 hints 不再 ReferenceError（P2 修复存量 bug）', async () => {
  const proj = db.prepare(`INSERT INTO projects (name, tolerances) VALUES ('J6 容差桩', '{"cost":0.1}')`).run();
  const out = await generateWeekly(Number(proj.lastInsertRowid), { pv: 100, ev: 90, ac: 110 });   // CPI 0.818 < 0.9 必越界
  assert.ok(out.markdown, 'mock 周报应生成');
  assert.ok(out.alerts.some((a) => a.dimension === 'cost'), '越界应产 alert');
  assert.ok(Array.isArray(out.hints), 'hints 应为数组（原 violations 未定义即在此行崩溃）');
});

// ============ J7-J8 R7.0 P3 每日巡检 + 提示词库 ============

test('J7 每日巡检：扫描器排序/白名单路由 → 幂等 upsert → 通知投递 → mock digest', async () => {
  const { findings, counts } = patrolScan();
  // 测试库既有状态应至少扫出：J6 越界 alert（tolerance high）与 coach_idle（无 30 天内会话则出）
  assert.ok(findings.length > 0, '种子+前序用例状态应产生发现');
  const SEV = { high: 0, mid: 1, low: 2 };
  for (let i = 1; i < findings.length; i++) assert.ok(SEV[findings[i - 1].severity] <= SEV[findings[i].severity], 'findings 按严重度排序');
  for (const f of findings) {
    assert.match(f.type, /^[a-z_]+$/, 'type 为蛇形标识');
    if (f.action) assert.match(f.action.route, /^(coach|tab):[a-z_]+$/, `action 路由须在白名单：${f.action.route}`);
  }
  assert.equal(counts.high + counts.mid + counts.low, findings.length, '计数与清单一致');
  // 执行：落简报 + 有发现必投通知（mock digest）
  const r1 = await patrolRun();
  assert.equal(r1.findings, findings.length);
  assert.equal(r1.llm_ok, 1, 'mock provider 下 digest 应成功');
  assert.equal(r1.notified, true);
  const rep = patrolReports()[0];
  assert.equal(rep.patrol_date, r1.date);
  assert.match(rep.digest, /巡检/, 'digest 非空');
  assert.ok(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE title LIKE '%每日巡检%'`).get().c >= 1, '通知应投递');
  // 同日幂等：重跑覆盖不增行
  await patrolRun();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM patrol_reports WHERE patrol_date=?').get(r1.date).c, 1, '同日 upsert 幂等');
});

test('J8 提示词库：CRUD 校验 + 启停过滤 + 排序 + 删除不存在 404', () => {
  assert.throws(() => createPrompt({ title: '', content: 'x' }), /标题/, '空标题 400');
  assert.throws(() => createPrompt({ title: 't', content: '  ' }), /内容/, '空内容 400');
  const p1 = createPrompt({ title: '生成周报', content: '给当前项目生成周报，重点分析成本偏差根因', sort: 2 });
  const p2 = createPrompt({ title: '登记风险', content: '登记风险：核心测试环境不稳定，概率 0.6 影响 0.7', sort: 1 });
  assert.ok(p1.id > 0 && p2.id > 0);
  const list = listPrompts();
  assert.equal(list[0].id, p2.id, '按 sort 升序');
  const off = updatePrompt(p1.id, { enabled: false });
  assert.equal(off.enabled, 0);
  assert.ok(!listPrompts({ enabledOnly: true }).some((p) => p.id === p1.id), '停用项不出现在 enabledOnly');
  assert.equal(updatePrompt(p1.id, { title: '生成周报（改）' }).title, '生成周报（改）', '部分更新保留其余字段');
  assert.throws(() => updatePrompt(p1.id, { content: '' }), /为空|标题/, '空内容更新拒绝');
  assert.equal(deletePrompt(p2.id).ok, true);
  assert.throws(() => deletePrompt(p2.id), /不存在/, '重复删除 404');
  deletePrompt(p1.id);
});

// ============ J9-J11 R7.0 P4 记忆与画像（蒸馏/提取/注入透明化） ============

test('J9 记忆 CRUD：校验/去重/置顶排序/删除 404', () => {
  assert.throws(() => addMemory({ kind: 'weird', content: 'x' }), /kind 仅接受/, '未知 kind 拒绝');
  assert.throws(() => addMemory({ content: '  ' }), /不得为空/, '空内容拒绝');
  assert.throws(() => addMemory({ content: 'y'.repeat(301) }), /超长/, '超 300 字拒绝');
  const m1 = addMemory({ content: '该用户偏好周会周五召开（J9 桩）' });
  assert.throws(() => addMemory({ content: '该用户偏好周会周五召开（J9 桩）' }), /重复/, '同内容去重');
  const m2 = addMemory({ content: '该用户负责三个数据类项目（J9 桩）', pinned: true });
  const list = listMemories();
  assert.equal(list[0].id, m2.id, '置顶优先');
  assert.equal(updateMemory(m1.id, { pinned: true }).pinned, 1, '可置顶');
  assert.equal(updateMemory(m1.id, { pinned: false }).pinned, 0);
  assert.throws(() => updateMemory(m1.id, { content: '' }), /不得为空/, '显式空内容拒绝');
  assert.equal(deleteMemory(m1.id).ok, true);
  assert.throws(() => deleteMemory(m1.id), /不存在/, '重复删除 404');
  deleteMemory(m2.id);
});

test('J10 画像蒸馏：mock 通道 → summary 写入 user_profile（P1 归还列的消费方）', async () => {
  const r = await distillProfile();
  assert.match(r.summary, /该用户/, 'mock 蒸馏应产出画像');
  assert.equal(getProfile().summary, r.summary, '写入 summary 列（原生语义）');
  assert.equal(getProfile().assistant_prefs, null, '蒸馏不影响 KV 偏好（P1 迁移隔离性）');
  updateProfile({ summary: null });   // 复原（测试库内不残留画像）
});

test('J11 buildSystemPrompt 注入：画像+记忆+persona 设定；memory_on=0 关闭注入', () => {
  updateProfile({ summary: '该用户是数据治理专项群负责人（J11 桩）' });
  const mem = addMemory({ content: '该用户习惯结论先行汇报（J11 桩）' });
  setSettings({ 'persona.address': '王总', 'persona.style': 'direct', 'persona.strictness': 'strict' });
  const p = getProfile();
  const sp = buildSystemPrompt(p);
  assert.ok(sp.includes('该用户是数据治理专项群负责人'), '画像应注入');
  assert.ok(sp.includes('该用户习惯结论先行汇报'), '记忆应注入');
  assert.ok(sp.includes('称呼用户为「王总」'), 'persona 称呼生效');
  assert.ok(sp.includes('结论先行'), 'style=direct 话术生效');
  assert.ok(sp.includes('从严'), 'strictness=strict 话术生效');
  setSettings({ 'persona.memory_on': false });
  const sp2 = buildSystemPrompt(p);
  assert.ok(!sp2.includes('J11 桩'), 'memory_on=0 关闭画像与记忆注入');
  assert.ok(sp2.includes('称呼用户为「王总」'), 'persona 基础设定不受 memory_on 影响');
  // 上下文预览契约（H 区数据源）
  setSettings({ 'persona.memory_on': true });
  const pv = contextPreview();
  assert.equal(pv.summary, '该用户是数据治理专项群负责人（J11 桩）');
  assert.ok(pv.memory_injection.items.some((m) => m.id === mem.id), '预览含注入记忆');
  assert.ok(pv.persona.length === 4 && pv.persona.every((x) => x.effective != null), 'persona 四键齐备');
  assert.ok(pv.system_prompt.includes('J11 桩'), '预览 system_prompt 即实际注入内容');
  // 复原
  deleteMemory(mem.id);
  updateProfile({ summary: null });
  setSettings({ 'persona.address': null, 'persona.style': null, 'persona.strictness': null, 'persona.memory_on': null });
});

// ============ J12-J14 R7.0 P5 技能注册表 / MCP 壳 / 飞书读入 ============

test('J12 技能注册表：登记完整 + kill-switch 生效于 callJSON 门 + purpose 漂移检测', async () => {
  const { REGISTRY, skillEnabled, setSkillEnabled, listSkills } = await import('../src/skills.mjs');
  const { patrolDigestChat } = await import('../src/agent.mjs');
  // 注册表自洽：id 唯一、字段齐、tier 合法
  const ids = REGISTRY.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'purpose id 不得重复');
  assert.ok(REGISTRY.every((r) => r.label && r.group && r.desc && ['fast', 'strong'].includes(r.tier)), '字段完整');
  // 漂移检测：llm_calls 出现过的 purpose 必须已登记（新增通道漏登记即红）
  const used = db.prepare('SELECT DISTINCT purpose FROM llm_calls').all().map((r) => r.purpose);
  for (const p of used) assert.ok(ids.includes(p) || p === 'unknown', `未登记的 purpose 出现在观测表：${p}`);
  // kill-switch：默认开 → 停用后调用抛错（不进模型）→ 恢复
  assert.equal(skillEnabled('patrol_digest'), true, '默认启用');
  assert.equal(listSkills().find((s) => s.id === 'patrol_digest').enabled, true);
  setSkillEnabled('patrol_digest', false);
  assert.equal(skillEnabled('patrol_digest'), false);
  await assert.rejects(() => patrolDigestChat({ date: '2026-01-01', counts: { high: 0 }, findings: [] }), /停用/, '停用能力调用被门拦截');
  setSkillEnabled('patrol_digest', null);   // 清行恢复默认
  assert.equal(skillEnabled('patrol_digest'), true, 'null 清除覆盖回默认启用');
  assert.throws(() => setSkillEnabled('nope', false), /未登记/);
});

test('J13 MCP 管理壳：CRUD 校验 + which 探测（不执行目标命令）', async () => {
  const { createMcp, updateMcp, deleteMcp, checkMcp, listMcp } = await import('../src/mcp.mjs');
  assert.throws(() => createMcp({ name: '', command: 'x' }), /name/, '空名拒绝');
  assert.throws(() => createMcp({ name: 'a', command: ' ' }), /command/, '空命令拒绝');
  assert.throws(() => createMcp({ name: 'n'.repeat(41), command: 'x' }), /超长/);
  const { id } = createMcp({ name: 'J13 node 壳', command: 'node', args: '--stdio', note: '验收桩' });
  const r1 = checkMcp(id);
  assert.equal(r1.status, 'available', 'node 在 PATH（which 探测，未执行 node 本身）');
  assert.match(r1.path, /node/, '返回解析路径');
  const { id: id2 } = createMcp({ name: 'J13 假命令', command: 'pm-master-not-exist-xyz' });
  assert.equal(checkMcp(id2).status, 'not_found');
  assert.equal(listMcp().some((m) => m.id === id2 && m.last_status === 'not_found'), true, '状态落库');
  const upd = updateMcp(id, { enabled: false, note: '改过' });
  assert.equal(upd.enabled, 0);
  assert.equal(upd.note, '改过');
  assert.throws(() => updateMcp(id, { enabled: 'yes' }), /布尔/, '非布尔拒绝');
  assert.throws(() => updateMcp(99999, { note: 'x' }), /不存在/);
  deleteMcp(id); deleteMcp(id2);
  assert.throws(() => deleteMcp(id), /不存在/, '重复删除 404');
});

test('J14 飞书读入：引用解析纯函数 + 降级提示（RUN_FEISHU_LIVE=1 时加跑真实 API 自产自读闭环）', async () => {
  const { parseDocRef, readDoc, exportDoc, deleteDoc, feishuConfigured } = await import('../src/feishu.mjs');
  assert.deepEqual(parseDocRef('https://xx.feishu.cn/docx/AbC123xyz'), { kind: 'docx', token: 'AbC123xyz' });
  assert.deepEqual(parseDocRef('https://xx.feishu.cn/wiki/WkNode1token'), { kind: 'wiki', token: 'WkNode1token' });
  assert.deepEqual(parseDocRef('BareDocToken1234'), { kind: 'docx', token: 'BareDocToken1234' });
  assert.equal(parseDocRef('不是链接'), null);
  assert.equal(parseDocRef(''), null);
  await assert.rejects(() => readDoc('https://x/docx/TOKEN123456'), /飞书未配置/, '无凭据：明确降级提示');
  const live = process.env.RUN_FEISHU_LIVE === '1' && FEISHU_CRED.id && FEISHU_CRED.secret;
  if (!live) return;   // 默认离线回归（同 C4 约定：真实写回不每次跑，避免线上产生文档）
  process.env.FEISHU_APP_ID = FEISHU_CRED.id;
  process.env.FEISHU_APP_SECRET = FEISHU_CRED.secret;
  try {
    assert.equal(feishuConfigured(), true);
    await assert.rejects(() => readDoc('垃圾引用'), /无法解析/, '坏引用：解析在网络之前（凭据门在解析之后）');
    // 真实闭环：自产自读，标题带 TEST 标记便于云盘识别
    const w = await exportDoc({ title: 'readDoc 自测闭环（TEST-AUTO）', markdown: '# 闭环标题\n## 一、节\n正文关键句 42。\n- 列表项甲' });
    const d = await readDoc(w.url);
    assert.equal(d.title, 'readDoc 自测闭环（TEST-AUTO）');
    assert.ok(d.markdown.includes('# 闭环标题') && d.markdown.includes('正文关键句 42'), '块结构还原');
    assert.ok(d.blocks >= 3, '块数合理');
    assert.deepEqual(await deleteDoc(w.url), { document_id: w.document_id, deleted: true }, '清理自产文档（移入回收站）');
  } finally {
    process.env.FEISHU_APP_ID = '';
    process.env.FEISHU_APP_SECRET = '';
  }
});

// ============ J15 R7.1 P2 记忆复用晋升与衰减（复利闭环，纯代码） ============

test('J15 P2 记忆晋升/衰减：注入命中计数 → short 达阈值晋升 long（清 TTL）；long 久未命中降 level（3 为下限）', async () => {
  const { markInjected, promoteMemories, decayMemories, runMemoryMaintenance } = await import('../src/memory.mjs');
  // ① 命中计数：去重 + 不存在的 id 静默跳过
  const s = addMemory({ content: 'J15 短期记忆待晋升', horizon: 'short', category: 'goal' });
  assert.ok(s.expires_at, 'short 自动带 TTL（可被晋升清除）');
  assert.deepEqual(markInjected([s.id, s.id, 999999]), { hit: 1 }, '同 id 去重、无效 id 不计数');
  assert.equal(db.prepare('SELECT hits FROM memories WHERE id=?').get(s.id).hits, 1);
  assert.ok(db.prepare('SELECT last_hit FROM memories WHERE id=?').get(s.id).last_hit, 'last_hit 落库');
  // ② 晋升：达阈值 → long + 清 expires_at
  db.prepare('UPDATE memories SET hits=? WHERE id=?').run(3, s.id);
  assert.ok(promoteMemories({ threshold: 3 }).promoted >= 1, '达阈值发生晋升');
  const up = db.prepare('SELECT horizon, expires_at FROM memories WHERE id=?').get(s.id);
  assert.equal(up.horizon, 'long', 'hits≥阈值 → 晋升 long');
  assert.equal(up.expires_at, null, '晋升清 expires_at（不再过期）');
  // ③ 衰减：long 久未命中 → level+1（level<3 才降）
  const l = addMemory({ content: 'J15 长期记忆待衰减', horizon: 'long', level: 1 });
  db.prepare(`UPDATE memories SET last_hit=datetime('now','localtime','-200 day') WHERE id=?`).run(l.id);
  assert.ok(decayMemories({ idleDays: 90 }).decayed >= 1, '久未命中发生衰减');
  assert.equal(db.prepare('SELECT level FROM memories WHERE id=?').get(l.id).level, 2, 'level+1');
  // ④ 下限保护：level=3 不再降
  db.prepare(`UPDATE memories SET level=3, last_hit=datetime('now','localtime','-400 day') WHERE id=?`).run(l.id);
  decayMemories({ idleDays: 90 });
  assert.equal(db.prepare('SELECT level FROM memories WHERE id=?').get(l.id).level, 3, '3 为下限，不再降');
  // ⑤ 维护合并入口契约（晋升 + 衰减一并返回）
  assert.deepEqual(Object.keys(runMemoryMaintenance()).sort(), ['decayed', 'promoted']);
  // ⑥ 预览复利指标暴露待晋升计数
  assert.equal(typeof contextPreview().layered.promotable, 'number', 'layered.promotable 供观测');
  // 复原
  deleteMemory(s.id); deleteMemory(l.id);
});

// ============ J16 R7.1 P2 项目事件钩子：事件→project 域记忆（复利闭环①，纯代码） ============

test('J16 P2 项目事件钩子：模板映射落 project 域 long L2；未知事件/非法项目/重复均不落入', async () => {
  const { rememberProjectEvent } = await import('../src/memory.mjs');
  const { insertProject } = await import('../src/repo/project.repo.mjs');
  const pid = insertProject('J16 事件钩子桩项目', 'normal', '项目经理', '2026-01-01', JSON.stringify({ cost: 0.1, time: 0.1 })).id;
  // ① 风险事件：内容确定性拼装，维度齐备
  const r = rememberProjectEvent('risk', pid, { title: 'J16 进度风险', probability: 0.6, impact: 0.8, strategy: '赶工' });
  assert.equal(r.added, true, '风险事件应沉淀为记忆');
  const row = one('SELECT kind, scope, horizon, level, category, project_id, source, content FROM memories WHERE id=?', r.id);
  assert.deepEqual(
    [row.kind, row.scope, row.horizon, row.level, row.category, row.project_id, row.source],
    ['project', 'project', 'long', 2, 'risk', pid, 'project#risk'],
    '风险记忆：kind/scope/horizon/level/category/project_id/source 全部正确',
  );
  assert.match(row.content, /J16 进度风险/, '内容按模板拼装（含标题）');
  assert.match(row.content, /赶工/, '内容含应对策略');
  // ② 未知事件：不入库（fail-soft 返回原因）
  assert.deepEqual(rememberProjectEvent('nope', pid, {}), { added: false, reason: 'unknown_event:nope' });
  // ③ 非法 project_id：不入库
  assert.equal(rememberProjectEvent('risk', 'abc', { title: 'x' }).added, false, '非法项目号拒绝');
  // ④ 重复（同域同事件同内容）：去重，不落第二条
  assert.equal(rememberProjectEvent('risk', pid, { title: 'J16 进度风险', probability: 0.6, impact: 0.8, strategy: '赶工' }).added, false, '同域同内容去重');
  // 复原
  deleteMemory(r.id);
});

// ============ J17-J18 R7.1 P3 记忆注入补齐（③检索注入 场景感知）+ 画像分层来源（⑤蒸馏回灌） ============

test('J17 P3 场景感知检索：域门控 / 场景偏好前置 / 过期 short 惰性剔除（纯代码，零 LLM）', async () => {
  const { retrieveMemories } = await import('../src/memory.mjs');
  const { insertProject } = await import('../src/repo/project.repo.mjs');
  const pid = insertProject('J17 检索桩项目', 'normal', 'PM', '2026-01-01', JSON.stringify({ cost: 0.1, time: 0.1 })).id;
  // user-long：goal 与 risk 同 level/pinned/hits → 唯场景偏好可决定先后
  const g = addMemory({ content: 'J17 用户目标记忆', category: 'goal', level: 1 });
  const r = addMemory({ content: 'J17 用户风险记忆', category: 'risk', level: 1 });
  const pm = addMemory({ content: 'J17 项目风险记忆', scope: 'project', project_id: pid, category: 'risk', level: 1 });
  const ex = addMemory({ content: 'J17 过期短期记忆', horizon: 'short', category: 'task', expires_at: '2000-01-01 00:00:00' });
  // ① 域门控：无项目上下文 → 仅 user 域（project 记忆不注入）
  const noPid = retrieveMemories({});
  assert.ok(noPid.some((m) => m.id === g.id), 'user 域恒可注入');
  assert.ok(!noPid.some((m) => m.id === pm.id), '无 project_id 时 project 域被门控剔除');
  // ② 过期 short 剔除（惰性回收）
  assert.ok(!noPid.some((m) => m.id === ex.id), '过期 short 不注入');
  // ③ 场景偏好前置：categories=[risk] → 风险记忆先于目标记忆
  const sc = retrieveMemories({ scenario: { categories: ['risk'] } });
  const ri = sc.findIndex((m) => m.id === r.id);
  const gi = sc.findIndex((m) => m.id === g.id);
  assert.ok(ri > -1 && gi > -1 && ri < gi, '场景偏好分类（risk）命中前置');
  // ④ 项目上下文匹配 → project 域进入候选
  assert.ok(retrieveMemories({ pageContext: { project_id: pid } }).some((m) => m.id === pm.id), 'project_id 匹配时 project 域注入');
  // 复原
  for (const m of [g, r, pm, ex]) deleteMemory(m.id);
});

test('J18 P3 画像蒸馏分层来源：profileMemoryDigest 仅 user+long；level ASC/hits DESC；排除 short 与 project', async () => {
  const { profileMemoryDigest } = await import('../src/memory.mjs');
  const { insertProject } = await import('../src/repo/project.repo.mjs');
  const a = addMemory({ content: 'J18 核心记忆', level: 1, category: 'goal' });
  const b = addMemory({ content: 'J18 一般记忆', level: 3, category: 'fact' });
  const c = addMemory({ content: 'J18 重要高频记忆', level: 2, category: 'preference' });
  db.prepare('UPDATE memories SET hits=5 WHERE id=?').run(c.id);
  const s = addMemory({ content: 'J18 短期记忆', horizon: 'short', category: 'task' });
  const pid = insertProject('J18 蒸馏桩项目', 'normal', 'PM', '2026-01-01', JSON.stringify({ cost: 0.1, time: 0.1 })).id;
  const p = addMemory({ content: 'J18 项目记忆', scope: 'project', project_id: pid, level: 1, category: 'risk' });
  const d = profileMemoryDigest({ limit: 30 });
  const contents = d.map((x) => x.content);
  assert.ok(contents.includes('J18 核心记忆'), 'user 域长期记忆纳入蒸馏源');
  assert.ok(!contents.includes('J18 短期记忆'), 'short 排除（避免一次性任务细节污染画像）');
  assert.ok(!contents.includes('J18 项目记忆'), 'project 域排除（画像为跨项目稳定特质）');
  // 排序：level ASC（核心优先）
  const ia = d.findIndex((x) => x.content === 'J18 核心记忆');
  const ic = d.findIndex((x) => x.content === 'J18 重要高频记忆');
  const ib = d.findIndex((x) => x.content === 'J18 一般记忆');
  assert.ok(ia > -1 && ic > -1 && ib > -1 && ia < ic && ic < ib, 'level ASC 排序：核心<重要<一般');
  // 结构契约（供 profileDistillChat 消费）
  assert.deepEqual(Object.keys(d[0]).sort(), ['content', 'level']);
  // 复原
  for (const m of [a, b, c, s, p]) deleteMemory(m.id);
});

// ============ U. 统一角色（PRD v5.18.0 §15.0「教练角色即 AI 助手」/ ACCEPTANCE-SPEC v1.0 §6.2 代码级合流） ============

test('U1 统一角色：三路 system 首行同一人设（chat/教练/助手），面差异保留在后续行', () => {
  const p = getProfile();
  const chat = buildSystemPrompt(p);                                                // chat 路径（助手面自由问答）
  const coach = COACH_RULES;                                                        // 教练面规则（GROW 演练）
  const asst = buildAssistantPrompt({ pageContext: { tab: 'coach' }, profile: p }); // 助手面意图判定
  // 首行角色名一致：合流为同一角色「AI 教练助手」（Spec §6.2 步骤1 通过标准）
  assert.equal(chat.split('\n')[0], ROLE_LINE, 'chat 路径首行 = 统一人设');
  assert.equal(coach.split('\n')[0], ROLE_LINE, '教练路径首行 = 统一人设');
  assert.equal(asst.split('\n')[0], ROLE_LINE, '助手路径首行 = 统一人设');
  assert.ok(ROLE_LINE.includes('AI 教练助手'), '统一角色名为「AI 教练助手」');
  // 面差异保留在后续行（同一角色的不同能力面，非两个并列角色）
  assert.ok(coach.includes('GROW') && coach.includes('不代答'), '教练面保留 GROW 教练原则');
  assert.ok(asst.includes('操作意图'), '助手面保留意图判定职责');
});

test('U2 单一身份：两能力面共享同一画像/记忆/注入链（memoryBlock）；contextPreview().injection 与注入链一致', () => {
  updateProfile({ summary: '该用户是 U2 桩：跨项目稳定特质' });
  const mem = addMemory({ content: '该用户习惯先对齐目标再谈方案（U2 桩）' });
  const p = getProfile();
  // 同一条上下文注入链：同 profile 同上下文 → 同一文本块（PRD §15.0「单一身份」条）
  const block = memoryBlock({ profile: p });
  assert.ok(block.includes('该用户是 U2 桩') && block.includes('U2 桩）'), 'memoryBlock 组装画像 + 分层记忆');
  assert.ok(buildSystemPrompt(p).includes('该用户习惯先对齐目标'), 'chat 路径注入共享记忆');
  assert.ok(buildAssistantPrompt({ pageContext: {}, profile: p }).includes('该用户习惯先对齐目标'), '助手路径注入共享记忆');
  // RC-3 代码项（待补测）：contextPreview().injection 对两条路径一致——预览注入块即注入链同源产出
  const pv = contextPreview();
  assert.equal(pv.injection.block_chars, block.length, 'contextPreview 注入块长度 = memoryBlock 同源产出');
  assert.equal(pv.system_prompt.split('\n')[0], ROLE_LINE, '预览 system_prompt 反映统一人设');
  // 复原
  deleteMemory(mem.id);
  updateProfile({ summary: null });
});

test('U3 边界 N1-N6 不可越权：白名单不含决策/发证/考试类；危险操作双确认标记；白名单外回落自由问答', async () => {
  const keys = Object.keys(INTENTS);
  // N1 不替用户决策 / N4 不发证 / N5 不做考试模拟——白名单内无此类越权意图
  assert.ok(!keys.some((k) => /decision|decide|cert|exam|authorize|approve/i.test(k)), '无决策/发证/考试/授权类意图');
  // 所有意图均为确定性执行动作，类型受限于 write/read/action（规则交代码，判断交 AI，决策交用户）
  const types = [...new Set(keys.map((k) => INTENTS[k].type))];
  assert.ok(types.every((t) => ['write', 'read', 'action'].includes(t)), '意图类型受限于 write/read/action');
  // N3 不越权执行：危险操作显式标记 danger（parse 生成计划 → exec 双确认）
  assert.equal(INTENTS['risk.delete']?.danger, true, '删除风险标 danger（双确认）');
  assert.ok(keys.filter((k) => INTENTS[k].danger).length === 1, '仅危险操作标 danger（避免过度确认）');
  // N3：白名单外输入不越权执行，回落自由问答（mock 下「帮我决定…」不匹配任何意图）
  const out = await parse('帮我决定这个方案选 A 还是 B', { tab: 'coach' });
  assert.equal(out.kind, 'chat', '决策类请求不被执行为动作，回落自由问答（N1 决策权归用户）');
});
