// R5.3 C1 数据导出：全库可读格式（Markdown 汇总报告 + JSON 包），供交接/存档
// R6.5 C3 增强：Markdown 补训练任务与情景错题两章；JSON 支持白名单表过滤（?tables=）
// 纯代码只读聚合，零 LLM；JSON 包为各业务表快照（排除系统表），Markdown 为人读汇总
import { db, getProfile } from './db.mjs';
import { badRequest } from './errors.mjs';

// 导出的业务表快照（按域分组；系统表 jobState 等进程态不导）
const TABLES = [
  'user_profile', 'projects', 'stakeholders', 'risks', 'alerts', 'action_items', 'meetings', 'project_artifacts',
  'evidence', 'experience_stats', 'competency_scores', 'assessments', 'growth_links', 'training_tasks',
  'knowledge_cards', 'drill_records', 'itto_processes', 'itto_tools', 'itto_links', 'itto_practice', 'itto_tutor',
  'coach_sessions', 'ra_projects', 'notifications', 'llm_calls', 'feedback',
];

// R6.5 C3：tables 过滤只认白名单（表名要拼进 SQL，非法名显式拒绝——防注入）
export function exportJSON({ tables } = {}) {
  let selected = TABLES;
  if (tables != null) {
    const arr = (Array.isArray(tables) ? tables : String(tables).split(','))
      .map((t) => String(t).trim()).filter(Boolean);
    const bad = arr.filter((t) => !TABLES.includes(t));
    if (bad.length) throw badRequest(`未知表：${bad.join(',')}（可选：${TABLES.join('、')}）`);
    selected = [...new Set(arr)];
  }
  const snapshot = {};
  for (const t of selected) {
    try { snapshot[t] = db.prepare(`SELECT * FROM ${t}`).all(); }
    catch { /* 表不存在（版本演进）→ 跳过 */ }
  }
  const counts = Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, v.length]));
  return {
    exported_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    app: 'PM-Master · 项目经理成长工作台',
    note: tables != null
      ? `JSON 过滤快照（${selected.length}/${TABLES.length} 张表，按请求 tables 选择）`
      : '全库 JSON 快照（业务表；attachment/二进制不含）',
    counts,
    tables: snapshot,
  };
}

export function exportMarkdown() {
  const p = getProfile();
  const one = (s, ...a) => db.prepare(s).get(...a);
  const rows = (s, ...a) => db.prepare(s).all(...a);
  const n = (s, ...a) => one(s, ...a)?.c ?? 0;

  // 三维最新
  const latest = one('SELECT * FROM assessments ORDER BY id DESC LIMIT 1');
  // 闭环
  const links = rows(`SELECT status, COUNT(*) c FROM growth_links GROUP BY status`);
  const linkMap = Object.fromEntries(links.map((r) => [r.status, r.c]));
  const linkTotal = links.reduce((a, b) => a + b.c, 0);
  // 项目
  const projects = rows('SELECT name, complexity, role, start_date, end_date FROM projects ORDER BY id');
  // 证据
  const evids = rows('SELECT type, title, created_at FROM evidence ORDER BY id DESC LIMIT 20');
  // 经验现值
  const exp = Object.fromEntries(rows('SELECT key, value FROM experience_stats').map((r) => [r.key, r.value]));
  // 知识库
  const cards = one(`SELECT COUNT(*) total, SUM(CASE WHEN reps>=2 THEN 1 ELSE 0 END) mastered, SUM(CASE WHEN evidence_id IS NOT NULL THEN 1 ELSE 0 END) evidenced FROM knowledge_cards`);
  const tutor = one(`SELECT COUNT(*) total, SUM(CASE WHEN mastery>=1 THEN 1 ELSE 0 END) taught, SUM(CASE WHEN mastery>=3 THEN 1 ELSE 0 END) m3 FROM itto_tutor`);
  // 风险
  const risks = one(`SELECT COUNT(*) total, SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open FROM risks`);
  // R6.5 C3：训练任务（open 优先）+ 情景题错题（判分 weak 口径，宁缺毋滥）
  const tasks = rows(`SELECT title, status, due_date, source FROM training_tasks
                      ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, id DESC LIMIT 30`);
  const taskTotal = n('SELECT COUNT(*) c FROM training_tasks');
  const wrongs = rows(`SELECT domain, depth, question, created_at FROM drill_records
                        WHERE grade='weak' ORDER BY id DESC LIMIT 20`);
  const wrongTotal = n(`SELECT COUNT(*) c FROM drill_records WHERE grade='weak'`);
  const md = [
    `# PM-Master 数据导出 · ${new Date().toISOString().slice(0, 10)}`,
    '',
    `> 档案：L${p.current_level} → 目标 L${p.target_level}（${p.track === 'pmo' ? 'PMO' : '项目'}通道）· 导出时间 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    '',
    '## 一、成长三维（最近一次月度重算）',
    latest
      ? `知识 K=L${latest.k_level} · 素质 C=L${latest.c_level} · 经验 E=L${latest.e_level} → **综合 L${latest.composite_level}**（${latest.created_at}）`
      : '（尚未重算）',
    '',
    '## 二、成长闭环',
    `共 ${linkTotal} 条：差距 ${linkMap.open ?? 0} · 训练中 ${linkMap.trained ?? 0} · 已闭环 ${linkMap.closed ?? 0}（闭环率 ${linkTotal ? Math.round(((linkMap.closed ?? 0) / linkTotal) * 100) : 0}%）`,
    '',
    '## 三、项目经历（' + projects.length + '）',
    ...projects.map((x) => `- ${x.name}（${x.complexity} · ${x.role ?? '—'} · ${x.start_date ?? '?'}~${x.end_date ?? '至今'}）`),
    projects.length === 0 && '（无项目记录）',
    '',
    '## 四、经验硬指标现值',
    ...Object.entries(exp).map(([k, v]) => `- ${k}: ${v}`),
    Object.keys(exp).length === 0 && '（无）',
    '',
    `## 五、成长记录（证据，最近 20 / 共 ${n('SELECT COUNT(*) c FROM evidence')}）`,
    ...evids.map((e) => `- [${e.type}] ${e.title}（${e.created_at?.slice(0, 10)}）`),
    evids.length === 0 && '（暂无）',
    '',
    '## 六、知识掌握',
    `知识卡片：${cards.total} 张 · 掌握（reps≥2）${cards.mastered ?? 0} · **费曼实证 M3 ${cards.evidenced ?? 0} 张**`,
    `工具教学：开课 ${tutor?.taught ?? 0}/${tutor?.total ?? 0} · **M3 能教授 ${tutor?.m3 ?? 0}**`,
    '',
    '## 七、在管风险快照',
    `风险 ${risks.total} 条（open ${risks.open ?? 0}）· 行动项 ${n(`SELECT COUNT(*) c FROM action_items`)} · 干系人 ${n(`SELECT COUNT(*) c FROM stakeholders`)}`,
    '',
    `## 八、训练任务（open 优先，最近 30 / 共 ${taskTotal}）`,
    ...tasks.map((t) => `- [${t.status}] ${t.title}（截止 ${t.due_date ?? '—'} · 来源 ${t.source ?? '—'}）`),
    tasks.length === 0 && '（无训练任务——月度重算后由 grow-planner 生成）',
    '',
    `## 九、情景题错题（判分 weak，最近 20 / 共 ${wrongTotal}）`,
    ...wrongs.map((w) => `- ${w.domain ?? '—'} · ${w.depth ?? '—'} · ${String(w.question ?? '').slice(0, 40)}…（${w.created_at?.slice(0, 10)}）`),
    wrongs.length === 0 && '（无错题记录）',
    '',
    '---',
    `配套 machine-readable：同请求返回 JSON 包（${TABLES.length} 张业务表，支持 ?tables= 过滤）；本报告为人读汇总。`,
  ].filter((x) => x !== false).join('\n');
  return { markdown: md, counts: { projects: projects.length, evidence: evids.length, cards: cards.total, links: linkTotal, tasks: taskTotal, wrongs: wrongTotal } };
}
