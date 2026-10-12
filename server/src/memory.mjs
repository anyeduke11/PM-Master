// R7.0 P4 记忆与画像：条目级工作记忆 CRUD + 教练归档自动提取 + 画像蒸馏服务 + 上下文预览
// 规则/判断分离：蒸馏/提取走 agent.mjs callJSON（LLM 只生成内容）；注入组装、去重、预览为纯代码。
import { db, getProfile, updateProfile } from './db.mjs';
import { profileDistillChat, memoryExtractChat, buildSystemPrompt } from './agent.mjs';
import { computeScores } from './growth.mjs';
import { cfg, allSettings } from './settings.mjs';
import { badRequest, notFound } from './errors.mjs';

const KINDS = ['note', 'coach', 'chat'];

// ---------- CRUD ----------
export function listMemories(limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  return db.prepare('SELECT * FROM memories ORDER BY pinned DESC, id DESC LIMIT ?').all(n);
}

export function addMemory({ kind = 'note', content, source = 'manual', pinned = false }) {
  if (!KINDS.includes(kind)) throw badRequest(`kind 仅接受 ${KINDS.join('/')}`);
  const c = String(content ?? '').trim();
  if (!c) throw badRequest('记忆内容不得为空');
  if (c.length > 300) throw badRequest('记忆内容超长（≤300 字）');
  if (db.prepare('SELECT id FROM memories WHERE content=?').get(c)) throw badRequest('重复（同内容记忆已存在）');
  const info = db.prepare('INSERT INTO memories (kind, content, source, pinned) VALUES (?,?,?,?)')
    .run(kind, c, String(source ?? 'manual').slice(0, 60), pinned ? 1 : 0);
  return db.prepare('SELECT * FROM memories WHERE id=?').get(Number(info.lastInsertRowid));
}

export function updateMemory(id, patch) {
  const row = db.prepare('SELECT * FROM memories WHERE id=?').get(Number(id));
  if (!row) throw notFound(`记忆不存在：id=${id}`);
  const next = {
    content: 'content' in patch ? String(patch.content ?? '').trim().slice(0, 300) : row.content,
    pinned: 'pinned' in patch ? (patch.pinned ? 1 : 0) : row.pinned,
  };
  if (!next.content) throw badRequest('记忆内容不得为空');
  db.prepare(`UPDATE memories SET content=?, pinned=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(next.content, next.pinned, row.id);
  return db.prepare('SELECT * FROM memories WHERE id=?').get(row.id);
}

export function deleteMemory(id) {
  const info = db.prepare('DELETE FROM memories WHERE id=?').run(Number(id));
  if (info.changes === 0) throw notFound(`记忆不存在：id=${id}`);
  return { ok: true };
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

// ---------- 画像蒸馏（强模型；结果写 user_profile.summary——P1 归还的原生语义列） ----------
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
  const { summary } = await profileDistillChat({ profile, scores, evidence });
  if (!summary) throw badRequest('蒸馏返回空画像，未写入（可重试）');
  updateProfile({ summary });
  return { summary, profile: getProfile() };
}

// ---------- 上下文预览（「AI 现在知道什么」：设置 H 区透明化） ----------
export function contextPreview() {
  const profile = getProfile();
  const personaKeys = ['persona.address', 'persona.style', 'persona.strictness', 'persona.memory_on'];
  const view = allSettings().filter((s) => personaKeys.includes(s.key))
    .map((s) => ({ key: s.key, label: s.label, effective: s.effective, source: s.source }));
  const mem = listMemories(5);
  return {
    profile: { current_level: profile.current_level, target_level: profile.target_level, track: profile.track },
    summary: profile.summary ?? null,
    persona: view,
    memory_injection: cfg('persona.memory_on')
      ? { injected: Math.min(mem.length, 5), total: db.prepare('SELECT COUNT(*) c FROM memories').get().c, items: mem.map((m) => ({ id: m.id, content: m.content.slice(0, 120), pinned: Boolean(m.pinned) })) }
      : { injected: 0, total: db.prepare('SELECT COUNT(*) c FROM memories').get().c, items: [], note: 'persona.memory_on=0，画像与记忆不注入' },
    system_prompt: buildSystemPrompt(profile),   // 实际注入的完整 system prompt（透明化）
  };
}
