// R2.4 W1.2 四步教学法：讲(Explain)→示(Demonstrate)→练(Practice)→用(Apply) + 费曼闭环(M3)
// 步骤推进是纯代码状态机；LLM 只做内容生成（讲/示/出题/判分/费曼评定）——规则判断分离
// 题目与演示复用 R2.2 itto 出题/判分能力；会话暂存内存（同 itto 实操题 pending 模式），完成落 itto_tutor 留痕
import { randomUUID } from 'node:crypto';
import { db, getProfile } from './db.mjs';
import { tutorChat, tutorFeynmanChat, ittoQuestionChat, ittoGradeChat } from './agent.mjs';
import { notFound, conflict } from './errors.mjs';   // R6.4 错误风格
import { markTrained, kaToDomain } from './growth-links.mjs';
import { applyHintsFor } from './context-hints.mjs';
import { masteryLabel, toolMasteryLevel } from './mastery.mjs';

const pending = new Map();   // token → { tool, process, step, explain, demonstrate, questionCtx, tutorRowId, exp }
const TTL_MS = 30 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (now > v.exp) pending.delete(k);
}

// 工作台真实数据快照（第②步「示」的演示素材；无项目时返回 null，导师降级为通用示例）
function gatherWorkbenchData() {
  const project = db.prepare('SELECT id, name, complexity FROM projects ORDER BY id DESC LIMIT 1').get();
  if (!project) return null;
  const lastWeekly = db.prepare(`SELECT evm FROM project_artifacts WHERE project_id=? AND type='weekly' ORDER BY id DESC LIMIT 1`).get(project.id);
  return {
    project: { name: project.name, complexity: project.complexity },
    evm: lastWeekly ? JSON.parse(lastWeekly.evm ?? 'null') : null,
    open_risks: db.prepare('SELECT title, probability, impact, strategy FROM risks WHERE project_id=? AND status=\'open\' LIMIT 5').all(project.id),
    open_alerts: db.prepare('SELECT dimension, message FROM alerts WHERE project_id=? AND status=\'open\' LIMIT 3').all(project.id),
  };
}

function toolWithProcess(toolId) {
  const tool = db.prepare('SELECT * FROM itto_tools WHERE id=?').get(Number(toolId));
  if (!tool) throw notFound('tool not found');
  const process = db.prepare(`SELECT p.* FROM itto_links l JOIN itto_processes p ON p.id=l.process_id
                              WHERE l.tool_id=? ORDER BY p.code LIMIT 1`).get(tool.id) ?? null;
  return { tool, process };
}

function depthOf(target) {
  if (target < 3) return 'recognize';
  if (target < 5) return 'apply';
  return 'integrate';
}

// ---------- ① 开课：讲 ----------
export async function startTutor({ tool_id } = {}) {
  sweep();
  const { tool, process } = toolWithProcess(tool_id);
  const explain = await tutorChat({ mode: 'explain', tool, profile: getProfile() });
  // R3.4：开课即留痕（mastery=0 → M1 已认识），否则矩阵里「讲解过」与「未接触」无法区分
  const row = db.prepare(`INSERT INTO itto_tutor (tool_id, process_id, step, mastery) VALUES (?,?,?,?)`)
    .run(tool.id, process?.id ?? null, 'explain', 0);
  const token = randomUUID();
  pending.set(token, { tool, process, step: 'explain', explain, tutorRowId: row.lastInsertRowid, exp: Date.now() + TTL_MS });
  return {
    token, step: 'explain', mastery: masteryLabel(1),
    tool: { id: tool.id, name: tool.name, category: tool.category }, explain,
  };
}

// ---------- 步骤推进（纯代码状态机） ----------
export async function advanceTutor(token, { answer } = {}) {
  sweep();
  const t = typeof token === 'string' ? pending.get(token) : null;
  if (!t) throw conflict('教学会话无效或已超时（30 分钟），请重新开课');

  // 讲 → 示：装配工作台真实数据现场演示
  if (t.step === 'explain') {
    const data = gatherWorkbenchData();
    t.demonstrate = await tutorChat({ mode: 'demonstrate', tool: t.tool, profile: getProfile(), data });
    t.step = 'demonstrate';
    return { step: 'demonstrate', demonstrate: t.demonstrate, data_used: Boolean(data) };
  }

  // 示 → 练：出实操任务（复用 ITTO 出题，深度随档案目标级）
  if (t.step === 'demonstrate') {
    const profile = getProfile();
    const procTools = t.process
      ? db.prepare(`SELECT t2.name FROM itto_links l JOIN itto_tools t2 ON t2.id=l.tool_id
                    WHERE l.process_id=? AND l.kind='tool' ORDER BY t2.id`).all(t.process.id).map((r) => r.name)
      : [t.tool.name];
    const procInfo = t.process
      ? { name: t.process.name, ka: t.process.ka, tools: procTools }
      : { name: t.tool.name, ka: '', tools: [t.tool.name] };
    const out = await ittoQuestionChat({ process: procInfo, depth: depthOf(Number(profile.target_level) || 1), profile });
    if (!out.question) throw new Error('出题失败（LLM 返回为空），请重试');
    t.questionCtx = { question: out.question, context: out.context, reference: out.reference };
    t.step = 'practice';
    return { step: 'practice', question: out.question, context: out.context };
  }

  // 练 + 作答 → 判分（复用 ITTO 判分）→ 用（落库 + 智能关联提示）
  if (t.step === 'practice') {
    if (!t.questionCtx) throw new Error('状态异常：缺少题目上下文，请重新开课');
    const out = await ittoGradeChat({ ...t.questionCtx, answer: String(answer ?? ''), profile: getProfile() });
    const passed = Number(out.score) >= 60;
    // 练成即训练信号（与 R2.3 闭环口径一致；R3.5 ka 归一到国标域 key）
    if (passed) { const dom = kaToDomain(t.process?.ka); if (dom) markTrained({ domain: dom }); }
    // 落库留痕（回填开课行；mastery 只升不降：0=讲解 → M1，1=练成 → M2）
    const mv = passed ? 1 : 0;
    if (t.tutorRowId) {
      db.prepare(`UPDATE itto_tutor SET step='apply', practice_score=?, practice_verdict=?, mastery=MAX(mastery, ?) WHERE id=?`)
        .run(out.score, out.verdict, mv, t.tutorRowId);
    } else {
      const info = db.prepare(`INSERT INTO itto_tutor (tool_id, process_id, step, practice_score, practice_verdict, mastery)
                               VALUES (?,?,?,?,?,?)`)
        .run(t.tool.id, t.process?.id ?? null, 'apply', out.score, out.verdict, mv);
      t.tutorRowId = info.lastInsertRowid;
    }
    t.step = 'apply';
    const applyHints = applyHintsFor(t.tool);
    return {
      step: 'apply', grade: { score: out.score, verdict: out.verdict, comment: out.comment }, reference: t.questionCtx.reference,
      mastery: masteryLabel(mv === 1 ? 2 : 1), passed,
      apply_hints: applyHints, tutor_id: t.tutorRowId,
    };
  }

  throw conflict('本课程已完结（apply），可再次开课或尝试费曼模式');
}

// ---------- 费曼闭环（M3 能教授）：允许讲完即测，也可 apply 后测 ----------
export async function feynman(token, explanation) {
  sweep();
  const t = typeof token === 'string' ? pending.get(token) : null;
  if (!t) throw conflict('教学会话无效或已超时（30 分钟），请重新开课');
  const out = await tutorFeynmanChat({ tool: t.tool, explanation: String(explanation ?? ''), profile: getProfile() });
  // 合格 → 落库/升级为 mastery=3（已落库则 UPDATE，未落库则 INSERT 纯费曼记录）
  if (out.qualified) {
    if (t.tutorRowId) {
      db.prepare('UPDATE itto_tutor SET feynman_qualified=1, mastery=3 WHERE id=?').run(t.tutorRowId);
    } else {
      db.prepare(`INSERT INTO itto_tutor (tool_id, process_id, step, feynman_qualified, mastery) VALUES (?,?,?,?,?)`)
        .run(t.tool.id, t.process?.id ?? null, 'apply', 1, 3);
    }
  }
  const lvl = toolMasteryLevel(db.prepare('SELECT MAX(mastery) m FROM itto_tutor WHERE tool_id=?').get(t.tool.id)?.m);
  return { ...out, tool_id: t.tool.id, mastery: masteryLabel(lvl) };
}
