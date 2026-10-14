// R7.0 P4 记忆与画像：条目级工作记忆 CRUD + 教练归档自动提取 + 画像蒸馏服务 + 上下文预览
// R7.1 P1 记忆分层分级：四维度（scope/horizon/level/category）+ 域门控/场景感知检索（纯代码，见 docs/MEMORY-ARCHITECTURE.md）
// 规则/判断分离：蒸馏/提取走 agent.mjs callJSON（LLM 只生成内容）；注入组装、去重、检索、预览为纯代码。
import { db, getProfile, updateProfile } from './db.mjs';
import { profileDistillChat, memoryExtractChat, buildSystemPrompt } from './agent.mjs';
import { computeScores } from './growth.mjs';
import { cfg, allSettings } from './settings.mjs';
import { badRequest, notFound } from './errors.mjs';

const KINDS = ['note', 'coach', 'chat', 'project'];
const SCOPES = ['user', 'project'];
const HORIZONS = ['long', 'short'];
const CATEGORIES = ['identity', 'style', 'preference', 'goal', 'weakness', 'fact', 'decision', 'risk', 'stakeholder', 'task'];
const SHORT_TTL_DAYS = 14;   // short 记忆默认存活期（P2 晋升后清 expires_at）
const DEFAULT_BUDGETS = { userLong: 4, projectLong: 3, short: 2 };   // 分层注入配额（对齐 PRD「上下文约 500 token」）
const PROMOTE_HITS = 3;      // R7.1 P2：short 记忆被真实注入命中 ≥ 阈值 → 晋升 long（清 expires_at）
const DECAY_IDLE_DAYS = 90;  // R7.1 P2：long 记忆连续未命中 ≥ 天数 → 降 level（3 为下限，不再降）
const LEVEL_MAX = 3;

// ---------- CRUD ----------
// 分层读取：limit + 可选筛选（scope/horizon/project_id/category/level；全部缺省时与原行为一致按置顶/新近）
export function listMemories(limit = 50, filters = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const where = [];
  const args = [];
  if (SCOPES.includes(filters.scope)) { where.push('scope = ?'); args.push(filters.scope); }
  if (HORIZONS.includes(filters.horizon)) { where.push('horizon = ?'); args.push(filters.horizon); }
  if (CATEGORIES.includes(filters.category)) { where.push('category = ?'); args.push(filters.category); }
  if (filters.level != null && Number.isInteger(Number(filters.level))) { where.push('level = ?'); args.push(Number(filters.level)); }
  if (filters.project_id != null) { where.push('project_id = ?'); args.push(Number(filters.project_id)); }
  const sql = `SELECT * FROM memories${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, level DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, n);
}

export function addMemory({ kind = 'note', content, source = 'manual', pinned = false, scope = 'user', horizon = 'long', level = 2, category = 'fact', project_id = null, expires_at = null }) {
  if (!KINDS.includes(kind)) throw badRequest(`kind 仅接受 ${KINDS.join('/')}`);
  if (!SCOPES.includes(scope)) throw badRequest(`scope 仅接受 ${SCOPES.join('/')}`);
  if (!HORIZONS.includes(horizon)) throw badRequest(`horizon 仅接受 ${HORIZONS.join('/')}`);
  if (!CATEGORIES.includes(category)) throw badRequest(`category 仅接受 ${CATEGORIES.join('/')}`);
  const lv = Number(level);
  if (![1, 2, 3].includes(lv)) throw badRequest('level 仅接受 1(核心)/2(重要)/3(一般)');
  const pid = scope === 'project' ? Number(project_id) : null;
  if (scope === 'project' && !Number.isInteger(pid)) throw badRequest('scope=project 必须携带 project_id');
  const c = String(content ?? '').trim();
  if (!c) throw badRequest('记忆内容不得为空');
  if (c.length > 300) throw badRequest('记忆内容超长（≤300 字）');
  if (db.prepare('SELECT id FROM memories WHERE content=? AND scope=? AND IFNULL(project_id,0)=IFNULL(?,0)').get(c, scope, pid)) {
    throw badRequest('重复（同域同内容记忆已存在）');
  }
  const exp = horizon === 'short'
    ? (expires_at ?? db.prepare(`SELECT datetime('now','localtime', ? ) v`).get(`+${SHORT_TTL_DAYS} day`).v)
    : null;   // long 不过期
  const info = db.prepare('INSERT INTO memories (kind, content, source, pinned, scope, horizon, level, category, project_id, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(kind, c, String(source ?? 'manual').slice(0, 60), pinned ? 1 : 0, scope, horizon, lv, category, pid, exp);
  return db.prepare('SELECT * FROM memories WHERE id=?').get(Number(info.lastInsertRowid));
}

export function updateMemory(id, patch) {
  const row = db.prepare('SELECT * FROM memories WHERE id=?').get(Number(id));
  if (!row) throw notFound(`记忆不存在：id=${id}`);
  const scope = 'scope' in patch ? patch.scope : row.scope;
  if (!SCOPES.includes(scope)) throw badRequest(`scope 仅接受 ${SCOPES.join('/')}`);
  const next = {
    content: 'content' in patch ? String(patch.content ?? '').trim().slice(0, 300) : row.content,
    pinned: 'pinned' in patch ? (patch.pinned ? 1 : 0) : row.pinned,
    scope,
    horizon: 'horizon' in patch ? patch.horizon : row.horizon,
    level: 'level' in patch ? Number(patch.level) : row.level,
    category: 'category' in patch ? patch.category : row.category,
    project_id: scope === 'project' ? Number('project_id' in patch ? patch.project_id : row.project_id) : null,
    expires_at: 'expires_at' in patch ? (patch.expires_at || null) : row.expires_at,
  };
  if (!next.content) throw badRequest('记忆内容不得为空');
  if (!HORIZONS.includes(next.horizon)) throw badRequest(`horizon 仅接受 ${HORIZONS.join('/')}`);
  if (![1, 2, 3].includes(next.level)) throw badRequest('level 仅接受 1/2/3');
  if (!CATEGORIES.includes(next.category)) throw badRequest(`category 仅接受 ${CATEGORIES.join('/')}`);
  if (next.scope === 'project' && !Number.isInteger(next.project_id)) throw badRequest('scope=project 必须携带 project_id');
  db.prepare(`UPDATE memories SET content=?, pinned=?, scope=?, horizon=?, level=?, category=?, project_id=?, expires_at=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(next.content, next.pinned, next.scope, next.horizon, next.level, next.category, next.project_id, next.expires_at, row.id);
  return db.prepare('SELECT * FROM memories WHERE id=?').get(row.id);
}

// ---------- 场景感知检索（域门控 + 场景排序 + 分层配额；纯代码，零 LLM） ----------
// pageContext={tab,project_id}；scenario={categories?}（教练/对话场景的偏好分类，命中者前置）
// 返回按优先级排序的记忆行（不含过期 short）。注意：函数体不 import agent.mjs 的运行时值，与 agent 的循环引用为良性（仅函数声明绑定）。
export function retrieveMemories({ pageContext = {}, scenario = null, budgets = DEFAULT_BUDGETS } = {}) {
  const pid = Number(pageContext?.project_id);
  const hasPid = Number.isInteger(pid);
  // ① 域门控：user 恒可注入；project 仅当页面上下文 project_id 匹配
  const rows = hasPid
    ? db.prepare(`SELECT * FROM memories WHERE scope='user' OR (scope='project' AND project_id=?)`).all(pid)
    : db.prepare(`SELECT * FROM memories WHERE scope='user'`).all();
  // ② 过期惰性回收（short 到期不注入）
  const now = db.prepare(`SELECT datetime('now','localtime') v`).get().v;
  const live = rows.filter((m) => !(m.horizon === 'short' && m.expires_at && m.expires_at < now));
  // ③ 场景偏好排序（scenario.categories 命中前置，不做硬过滤以免丢失通用上下文）
  const pref = new Set(Array.isArray(scenario?.categories) ? scenario.categories : []);
  const rank = (m) => (pref.has(m.category) ? 1 : 0);
  const cmp = (a, b) => rank(b) - rank(a) || b.level - a.level || b.pinned - a.pinned || b.hits - a.hits || b.id - a.id;
  // ④ 分层配额：user-long / project-long / short（user+project 合并）
  const pick = (pred, cap) => live.filter(pred).sort(cmp).slice(0, cap);
  const userLong = pick((m) => m.scope === 'user' && m.horizon === 'long', budgets.userLong ?? 4);
  const projLong = pick((m) => m.scope === 'project' && m.horizon === 'long', budgets.projectLong ?? 3);
  const short = pick((m) => m.horizon === 'short', budgets.short ?? 2);
  return [...userLong, ...projLong, ...short];
}

// ---------- ③ 记忆注入组装（复利闭环；纯代码，零 LLM） ----------
// 供 chat（buildSystemPrompt）/教练（coachChat）/助手（assistantChat）三条 LLM 路径复用：返回可拼入 system prompt 的文本块。
// 关闸（persona.memory_on=0）或无内容时返回 ''（调用方用 filter(Boolean) 拼接）；scenario={categories?} 场景偏好分类（命中前置，不硬过滤）。
// recordHits=true（仅真实 LLM 注入路径传）时记一次「复用命中」并顺带跑晋升/衰减维护；预览/只读路径传 false 不记账。
export function memoryBlock({ profile = {}, pageContext = {}, scenario = null, recordHits = false } = {}) {
  if (!cfg('persona.memory_on')) return '';
  const lines = [];
  if (profile.summary) lines.push(`【用户画像】${String(profile.summary).slice(0, 500)}`);
  const mem = retrieveMemories({ pageContext, scenario });
  if (recordHits) {
    try { markInjected(mem.map((m) => m.id)); runMemoryMaintenance(); } catch { /* 记忆维护失败不阻断对话 */ }
  }
  if (mem.length) {
    const tag = (m) => `${m.scope === 'project' ? `项目#${m.project_id}` : '用户'}·${m.horizon === 'short' ? '短期' : '长期'}`;
    lines.push(`【工作记忆】\n${mem.map((m) => `- [${tag(m)}] ${String(m.content).slice(0, 300)}`).join('\n')}`);
  }
  return lines.join('\n');
}

export function deleteMemory(id) {
  const info = db.prepare('DELETE FROM memories WHERE id=?').run(Number(id));
  if (info.changes === 0) throw notFound(`记忆不存在：id=${id}`);
  return { ok: true };
}

// ---------- P2 复用晋升 + 衰减（复利闭环，纯代码；见 docs/MEMORY-ARCHITECTURE.md §5） ----------
// 命中计数：仅真实 LLM 注入路径调用（buildSystemPrompt recordHits=true）；预览/只读不记账
export function markInjected(ids = []) {
  const uniq = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  if (!uniq.length) return { hit: 0 };
  const st = db.prepare(`UPDATE memories SET hits = hits + 1, last_hit = datetime('now','localtime') WHERE id = ?`);
  let hit = 0;
  for (const id of uniq) hit += st.run(id).changes;
  return { hit };
}

// 晋升：short 且 hits ≥ 阈值 → long + 清 expires_at（被反复复用即转长期）
export function promoteMemories({ threshold = PROMOTE_HITS } = {}) {
  const t = Math.max(1, Number(threshold) || PROMOTE_HITS);
  const info = db.prepare(`UPDATE memories SET horizon='long', expires_at=NULL, updated_at=datetime('now','localtime') WHERE horizon='short' AND hits >= ?`).run(t);
  return { promoted: info.changes };
}

// 衰减：long 且（从未命中或 last_hit 久远）→ level + 1（上限 3，不再降）
export function decayMemories({ idleDays = DECAY_IDLE_DAYS } = {}) {
  const d = Math.max(1, Number(idleDays) || DECAY_IDLE_DAYS);
  const info = db.prepare(`UPDATE memories SET level = level + 1, updated_at=datetime('now','localtime') WHERE horizon='long' AND level < ? AND IFNULL(last_hit, created_at) < datetime('now','localtime', ?)`).run(LEVEL_MAX, `-${d} day`);
  return { decayed: info.changes };
}

// 维护入口：晋升 + 衰减一并执行（真实注入路径自动触发，无调度器依赖）
export function runMemoryMaintenance(opts = {}) {
  return { ...promoteMemories(opts), ...decayMemories(opts) };
}

// ---------- P2 项目事件钩子（复利闭环①「产生」；项目实战事件 → project 域记忆自动化，纯代码） ----------
// 内容确定性拼装（Rule 5），零 LLM。实体映射：risk→风险登记册；stakeholder→干系人；decision→会议纪要
// （代码库无独立决策表，决策以会议纪要 summary 为载体，见 docs/MEMORY-ARCHITECTURE.md §5 校准注）
const PROJECT_EVENT_TEMPLATES = {
  risk: (d) => `风险「${d.title}」（概率 ${d.probability} × 影响 ${d.impact}）${d.strategy ? `，应对：${d.strategy}` : ''}`,
  stakeholder: (d) => `干系人「${d.name}」（权力 ${d.power} / 利益 ${d.interest}，参与度 ${d.current_engagement} → ${d.desired_engagement}）`,
  decision: (d) => `决策（${d.title}）：${d.summary}`,
};

// 落库：scope=project / horizon=long / level=2(重要) / kind=project / source=project#<event>
// fail-soft：任何异常（重复/超长/未知事件）都返回 {added:false,reason}，不反噬事件主流程（同 extractFromSession）
export function rememberProjectEvent(event, projectId, data = {}) {
  const tmpl = PROJECT_EVENT_TEMPLATES[event];
  if (!tmpl) return { added: false, reason: `unknown_event:${event}` };
  const pid = Number(projectId);
  if (!Number.isInteger(pid)) return { added: false, reason: 'bad_project_id' };
  const content = String(tmpl(data) ?? '').trim().slice(0, 300);
  if (!content) return { added: false, reason: 'empty' };
  try {
    const row = addMemory({ kind: 'project', content, source: `project#${event}`, scope: 'project', horizon: 'long', level: 2, category: event, project_id: pid });
    return { added: true, id: row.id };
  } catch (err) { return { added: false, reason: err?.message ?? 'error' }; }
}

// ---------- 教练归档提取（closeSession 钩子；失败不反噬归档） ----------
export async function extractFromSession(scenario, closing) {
  if (!closing?.ratings?.length && !closing?.artifact_summary) return { added: 0 };
  const { memories } = await memoryExtractChat({
    scenario: { name: scenario?.name, indicators: scenario?.indicators },
    artifactSummary: closing.artifact_summary ?? '',
    ratings: (closing.ratings ?? []).slice(0, 5),
  });
  let added = 0;
  for (const m of memories) {
    try { addMemory({ kind: 'coach', content: m, source: `coach#${scenario?.session_id ?? ''}` }); added += 1; }
    catch { /* 重复/超长单条跳过（fail soft：不影响其余条目与归档） */ }
  }
  return { added, extracted: memories.length };
}

// ---------- ⑤ 画像蒸馏（强模型；结果写 user_profile.summary——P1 归还的原生语义列） ----------
// 分层来源：取 user 域长期记忆（排除短期，避免一次性任务细节污染画像），按 level ASC（核心优先）/hits DESC（高频复用优先）。
// 纯代码，零 LLM（Rule 5）；供 distillProfile 与单测消费。
export function profileMemoryDigest({ limit = 12 } = {}) {
  const n = Math.max(1, Math.min(30, Number(limit) || 12));
  return db.prepare(`SELECT content, level, hits FROM memories WHERE scope='user' AND horizon='long' ORDER BY level ASC, hits DESC, id DESC LIMIT ?`).all(n)
    .map((m) => ({ content: String(m.content).slice(0, 120), level: m.level }));
}

export async function distillProfile() {
  const profile = getProfile();
  let scores = null;
  try {
    const s = computeScores();
    const cEntries = Object.entries(s.cDetails ?? {});
    scores = {
      K: s.K, C: s.C, E: s.E, k_level: s.k_level, c_level: s.c_level, e_level: s.e_level, composite: s.composite,
      top_indicators: cEntries.filter(([, v]) => v.score >= 0.7).sort((a, b) => b[1].score - a[1].score).slice(0, 5).map(([k, v]) => `${v.name}(${Math.round(v.score * 100)})`),
      weak_indicators: cEntries.filter(([, v]) => v.required && v.score < 0.7).sort((a, b) => a[1].score - b[1].score).slice(0, 5).map(([k, v]) => `${v.name}(${Math.round(v.score * 100)})`),
    };
  } catch { /* 分数未初始化：蒸馏仍可进行（缺维度自动省略） */ }
  const evidence = db.prepare('SELECT type, title, tags FROM evidence ORDER BY id DESC LIMIT 8').all()
    .map((e) => ({ type: e.type, title: String(e.title).slice(0, 80) }));
  const memories = profileMemoryDigest();   // ⑤ 分层长期记忆纳入蒸馏源（比一次性证据更稳定的行为画像）
  const { summary } = await profileDistillChat({ profile, scores, evidence, memories });
  if (!summary) throw badRequest('蒸馏返回空画像，未写入（可重试）');
  updateProfile({ summary });
  return { summary, profile: getProfile() };
}

// ---------- 上下文预览（「AI 现在知道什么」：设置 H 区透明化；R7.1 增分层视图 + 复利指标） ----------
export function contextPreview() {
  const profile = getProfile();
  const personaKeys = ['persona.address', 'persona.style', 'persona.strictness', 'persona.memory_on'];
  const view = allSettings().filter((s) => personaKeys.includes(s.key))
    .map((s) => ({ key: s.key, label: s.label, effective: s.effective, source: s.source }));
  const mem = retrieveMemories({});   // 默认域（无项目上下文）：user-long 配额内
  const total = db.prepare('SELECT COUNT(*) c FROM memories').get().c;
  const count = (w, ...a) => db.prepare(`SELECT COUNT(*) c FROM memories WHERE ${w}`).get(...a).c;
  return {
    profile: { current_level: profile.current_level, target_level: profile.target_level, track: profile.track },
    summary: profile.summary ?? null,
    persona: view,
    memory_injection: cfg('persona.memory_on')
      ? { injected: mem.length, total, items: mem.map((m) => ({ id: m.id, content: m.content.slice(0, 120), pinned: Boolean(m.pinned), scope: m.scope, horizon: m.horizon, level: m.level, category: m.category })) }
      : { injected: 0, total, items: [], note: 'persona.memory_on=0，画像与记忆不注入' },
    // 分层视图 + 复利指标（P2 晋升/衰减的观测底座）
    layered: {
      by_scope: { user: count(`scope='user'`), project: count(`scope='project'`) },
      by_horizon: { long: count(`horizon='long'`), short: count(`horizon='short'`) },
      by_level: { l1: count(`level=1`), l2: count(`level=2`), l3: count(`level=3`) },
      promoted: count(`horizon='long' AND hits>0`),      // 曾被复用（晋升/命中）的长期记忆
      hits_total: db.prepare('SELECT COALESCE(SUM(hits),0) h FROM memories').get().h,
      expired_short: count(`horizon='short' AND expires_at IS NOT NULL AND expires_at < datetime('now','localtime')`),
      promotable: count(`horizon='short' AND hits >= ?`, PROMOTE_HITS),   // R7.1 P2：待晋升（short 命中达阈值但尚未晋升）
    },
    // ③ 注入组装透明化：画像+记忆块占 system prompt 的篇幅（观测注入是否喧宾夺主）
    injection: (() => {
      const systemPrompt = buildSystemPrompt(profile);
      const block = memoryBlock({ profile });
      return { block_chars: block.length, prompt_chars: systemPrompt.length, ratio: systemPrompt.length ? Number((block.length / systemPrompt.length).toFixed(3)) : 0 };
    })(),
    system_prompt: buildSystemPrompt(profile),   // 实际注入的完整 system prompt（透明化）
  };
}
