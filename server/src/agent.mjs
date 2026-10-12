// Agent 引擎适配层（PRD 9.2）：引擎访问收敛于此，防上游 SDK 迭代
// provider: mock（默认，零依赖跑通）| openai（OpenAI 兼容接口：DeepSeek/Kimi/OpenAI 等）
// P1 计划：pi SDK provider（@mariozechner/pi-coding-agent SessionManager）以同一接口接入
// R4.3 WP8：全部模型调用经 callJSON/streamChat 统一落 llm_calls 观测表（429 退避也落行，限流可见）
import { levelRequirements } from './standard.mjs';
import { db } from './db.mjs';
import { cfg } from './settings.mjs';   // R7.0 P1：LLM 配置热切换（KV > env），密钥/base_url 仍走 env
import { skillEnabled } from './skills.mjs';   // R7.0 P5：技能注册表 kill-switch（skills 仅依赖 db，无环）

// 观测落库（失败不反噬主流程）：purpose=调用用途, ms 含 429 退避等待; tokens={prompt_tokens,completion_tokens,total_tokens}|null（R5.2 WP2）
function logCall(purpose, provider, model, ms, ok, error, tokens = null) {
  try {
    db.prepare('INSERT INTO llm_calls (purpose, provider, model, ok, ms, error, prompt_tokens, completion_tokens, total_tokens) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(String(purpose ?? 'unknown'), String(provider), model ?? null, ok ? 1 : 0, Math.round(ms), error ?? null,
        tokens?.prompt_tokens ?? null, tokens?.completion_tokens ?? null, tokens?.total_tokens ?? null);
  } catch { /* 观测失败静默（不阻断业务调用） */ }
}

// 观测读侧：按用途×提供方聚合（token 求和，NULL 不计）+ 逐日用量 + 最近调用
// R7.0 P1 设置中心：参数化（days 窗口 / purpose 过滤 / limit 上限），无参调用与旧行为一致
export function llmStats({ days = 30, purpose = null, limit = 50 } = {}) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const byPurpose = db.prepare(`SELECT purpose, provider, COUNT(*) calls, SUM(ok) ok_calls,
                                SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) error_calls, ROUND(AVG(ms)) avg_ms,
                                SUM(total_tokens) tokens
                                FROM llm_calls GROUP BY purpose, provider ORDER BY calls DESC`).all();
  const daily = db.prepare(`SELECT date(created_at) date, COUNT(*) calls, SUM(total_tokens) tokens,
                            SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) errors
                            FROM llm_calls WHERE created_at >= datetime('now',?)
                            GROUP BY date(created_at) ORDER BY date`).all(`-${d} day`);
  const recent = purpose
    ? db.prepare('SELECT id, purpose, provider, model, ok, ms, error, prompt_tokens, completion_tokens, total_tokens, created_at FROM llm_calls WHERE purpose = ? ORDER BY id DESC LIMIT ?').all(String(purpose), lim)
    : db.prepare('SELECT id, purpose, provider, model, ok, ms, error, prompt_tokens, completion_tokens, total_tokens, created_at FROM llm_calls ORDER BY id DESC LIMIT ?').all(lim);
  return {
    total: db.prepare('SELECT COUNT(*) c FROM llm_calls').get().c,
    errors: db.prepare('SELECT COUNT(*) c FROM llm_calls WHERE ok=0').get().c,
    tokens: db.prepare('SELECT SUM(total_tokens) t FROM llm_calls').get().t ?? 0,
    by_purpose: byPurpose,
    daily,
    recent,
  };
}

const STYLE_HINT = {
  coach: '语气专业、教练式（先提问澄清，再给方案）。',
  direct: '语气专业、直接（结论先行，少反问，给可执行建议）。',
  concise: '语气专业、极简（只给要点与关键依据，不展开铺垫）。',
};
const STRICT_HINT = {
  lenient: '评定与反馈以鼓励为主，答到要点即认可。',
  standard: '评定与反馈标准口径：肯定正确处，明确指出差距。',
  strict: '评定与反馈从严：高门槛认可，重点指出差距与改进方向。',
};

export function buildSystemPrompt(profile) {
  // 动态上下文注入（PRD AI native 原则3）：等级+目标+剧本，约百 token
  // R7.0 P4：persona（称呼/风格/严格度）+ 蒸馏画像（summary）+ 工作记忆 top5（置顶优先）；可经 persona.memory_on 关闭
  const req = levelRequirements(profile.target_level, profile.track);
  const journey = req.adaptation.journey[`L${profile.current_level}`] ?? '';
  const lines = [
    '你是 PM-Master 工作台的 AI 教练，服务项目管理专业人员的成长（GB/T 41831-2022 五级体系）。',
    `用户档案：当前 L${profile.current_level}，目标 L${profile.target_level}，通道 ${profile.track === 'pmo' ? 'PMO' : '项目/项目群组'}，成长剧本「${journey}」。`,
    '回答要结合用户等级定制深度：知识解释对齐该级认知要求（know/apply/integrate），建议对齐该级证据要求。',
  ];
  if (cfg('persona.memory_on')) {
    if (profile.summary) lines.push(`【用户画像】${String(profile.summary).slice(0, 500)}`);
    const mem = db.prepare('SELECT content FROM memories ORDER BY pinned DESC, id DESC LIMIT 5').all();
    if (mem.length) lines.push(`【工作记忆】\n${mem.map((m) => `- ${String(m.content).slice(0, 300)}`).join('\n')}`);
  }
  lines.push(`【交互设定】称呼用户为「${cfg('persona.address') || '你'}」。${STYLE_HINT[cfg('persona.style')] ?? STYLE_HINT.coach}${STRICT_HINT[cfg('persona.strictness')] ?? STRICT_HINT.standard}`);
  return lines.join('\n');
}

// ================= R7.0 P4 画像蒸馏 + 记忆提取 =================
// 蒸馏：档案+能力分+近期证据 → 一段可注入上下文的画像（强模型，低频高价值；产出人可编辑后再入库）
export async function profileDistillChat({ profile, scores, evidence }) {
  const out = await callJSON({
    system: [
      '你是 PM-Master 画像蒸馏器。基于给定档案、三维能力分与近期证据清单，提炼一段「AI 教练持续了解用户」的画像：',
      '≤200 字中文，第三人称「该用户」开头；覆盖：角色与等级现状、强项（引用高分指标）、当前短板与目标差距、',
      '工作重心（从证据项目/场景归纳）、一条培养建议。只依据给定数据，不臆造；数据缺失的维度直接省略。',
      '严格只输出 JSON：{"summary":"画像正文"}',
    ].join('\n'),
    profile,
    history: [{ role: 'user', content: JSON.stringify({ profile, scores, evidence }) }],
    maxTokens: 2000, purpose: 'profile_distill',
  });
  return { summary: String(out?.summary ?? '').slice(0, 500) };
}

// 记忆提取：教练会话归档 → 值得长期记住的用户事实/偏好（快模型；产出即入库，用户可在设置删除）
export async function memoryExtractChat({ scenario, artifactSummary, ratings }) {
  const out = await callJSON({
    system: [
      '你是 PM-Master 记忆提取器。从一次 GROW 教练会话的归档产物中提取「值得 AI 长期记住的用户事实」',
      '（工作情境、管理风格、明确表达的偏好/目标/困扰；不提取一次性任务细节与常识）。',
      '每条 ≤80 字中文、独立成条、第三人称（「该用户…」）；最多 3 条，没有值得记的给空数组。',
      '严格只输出 JSON：{"memories":["…"]}',
    ].join('\n'),
    profile: { current_level: 4, target_level: 5, track: 'project' },
    history: [{ role: 'user', content: JSON.stringify({ scenario, artifact_summary: artifactSummary, ratings }) }],
    maxTokens: 1200, model: cfg('llm.model_fast'), purpose: 'memory_extract',
  });
  return { memories: (Array.isArray(out?.memories) ? out.memories : []).map((m) => String(m).slice(0, 300)).filter(Boolean).slice(0, 3) };
}

// 流式生成：onDelta(token) 逐段回调；返回完整文本（WP8：chat 用途观测；R6.2 WP2：SSE usage 计 token，网关不支持则 NULL）
export async function streamChat({ messages, profile }, onDelta) {
  const provider = cfg('llm.provider');
  const t0 = Date.now();
  let usage = null;
  try {
    // R7.0 P5 kill-switch：助手流式回复同样受技能注册表停用控制（purpose='chat'）
    if (!skillEnabled('chat')) throw new Error('「chat」AI 能力已在设置·技能注册表停用');
    const full = provider === 'openai'
      ? await streamOpenAI(messages, profile, onDelta, (u) => { usage = u; })
      : await streamMock(messages, profile, onDelta);
    logCall('chat', provider, provider === 'openai' ? cfg('llm.model') : null, Date.now() - t0, true, null, usage);
    return full;
  } catch (e) {
    logCall('chat', provider, provider === 'openai' ? cfg('llm.model') : null, Date.now() - t0, false, String(e.message ?? e).slice(0, 200), usage);
    throw e;
  }
}

async function streamMock(messages, profile, onDelta) {
  // Mock：按词流式输出一段结合档案的教练式回复，验证 SSE 管线
  const last = messages.filter((m) => m.role === 'user').pop()?.content ?? '';
  const req = levelRequirements(profile.target_level, profile.track);
  const reply =
    `（mock provider · 已注入你的档案上下文：L${profile.current_level}→L${profile.target_level}，目标级剧本「${req.adaptation.journey[`L${profile.current_level}`] ?? ''}」）\n\n` +
    `收到：「${last.slice(0, 60)}」。作为教练我先确认两点：① 这件事你最想达成的首要目标是什么？② 它关联到目标级 L${profile.target_level} 的哪项要求（素质/知识/经验）？\n` +
    `基于你的等级，这件事适合对标 ${req.levelDef.short}级要求来训练——比如通过一次 GROW 教练会话沉淀行为证据。\n` +
    `（配置 AGENT_PROVIDER=openai + OPENAI_* 环境变量可切换真实 LLM；pi SDK provider 在 P1 以同一接口接入。）`;
  const chunks = reply.match(/[\s\S]{1,6}/g) ?? [];
  for (const c of chunks) { onDelta(c); await sleep(12); }
  return reply;
}

async function streamOpenAI(messages, profile, onDelta, usageSink, attempt = 1) {
  const base = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 未配置');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: cfg('llm.model'),
      stream: true,
      // R6.2 WP2：请求 usage 回传（OpenAI 规范 stream_options.include_usage；不支持的网关会忽略或报错——报错则降级去重试不带该参数）
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: buildSystemPrompt(profile) }, ...messages],
    }),
  });
  if (!res.ok) {
    // 429 限流：与 callJSON 同款分级退避（快/强无区分，chat 走强模型）后单次重试；限流事件落观测行
    // R6.3 bug 修复：attempt 限一次重试（持续 429 下不再无限递归挂住 SSE 连接，第二次直接抛错走前端 error 事件显式失败）
    // 退避时长 OPENAI_BACKOFF_MS 可注入（默认 65s 生产窗；回归测试用毫秒级验证有界性）
    if (res.status === 429 && attempt < 2) {
      const backoff = cfg('llm.backoff_ms');
      logCall('chat', 'openai', cfg('llm.model'), backoff, 0, `HTTP 429 限流（${Math.round(backoff / 1000)}s 退避后重试）`);
      await new Promise((r) => setTimeout(r, backoff));
      return streamOpenAI(messages, profile, onDelta, usageSink, 2);
    }
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  let full = '';
  for await (const line of res.body) {
    const s = line.toString().trim();
    if (!s.startsWith('data: ') || s === 'data: [DONE]') continue;
    try {
      const chunk = JSON.parse(s.slice(6));
      // include_usage 模式：最后一个 chunk choices 为空、仅带 usage
      if (chunk.usage) { usageSink?.(chunk.usage); continue; }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) { full += delta; onDelta(delta); }
    } catch { /* keep-alive 行忽略 */ }
  }
  return full;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 教练结构化调用（P1） =================
const COACH_RULES = [
  '你是 PM-Master 的 GROW 教练。遵守教练式原则：不跳跃、不代答、不评判；关键节点复述确认；用提问引导。',
  '当前处于 GROW 某一步骤，你只负责：① 对用户刚才的回答给出简短教练式回应（确认+提炼，≤80字）；② 输出下一步骤的提问（按给定 stepInfo 主题定制，贴合用户情境）。',
  '嵌入思维模型自然提示（如二阶思维/BATNA/金字塔原理），每轮至多1个。',
  '严格只输出 JSON：{"reply":"对回答的回应","collected":{"键":"提炼的事实/目标/根因等"},"ask":"下一步提问"}',
].join('\n');

export async function coachChat({ profile, scenario, phase, stepInfo, history, userContent }) {
  // W-OUT：生成完整方案（大输出）
  if (userContent === '__GENERATE_WILL__') {
    const will = await callJSON({
      system: [
        COACH_RULES.split('\n').slice(0, 1)[0],
        '现在生成 W 阶段完整产物：结构化行动方案（动作/时间/责任人 SMART）+ 关键话术（开场/主体/收尾）+ 检查清单。用 Markdown，≤300字，直接可用。',
        '严格只输出 JSON：{"will":"完整方案文本"}',
      ].join('\n'),
      profile, history, purpose: 'coach_will',
    });
    return { will: will?.will ?? null };
  }
  const out = await callJSON({
    system: `${COACH_RULES}\n场景：${scenario.name}（组合 ${Array.isArray(scenario.combo) ? scenario.combo.join('+') : scenario.combo}）；当前步骤主题：${stepInfo || phase}`,
    profile, history, purpose: 'coach',
  });
  // 键名容错：部分模型输出 message/response 代替 reply
  const reply = out?.reply ?? out?.message ?? out?.response ?? '';
  return { reply: String(reply), collected: out?.collected ?? {}, ask: out?.ask ?? '' };
}

export async function ratingChat({ profile, scenario, history }) {
  const out = await callJSON({
    system: [
      '你是 PM-Master 的会话评定器（E 阶段）。基于会话全程，仅对给定指标逐个评定：良好/合格/待提升。',
      '每条评定必须引用会话中的具体依据（用户原话或行为）。禁止评定列表之外的指标。',
      `可评指标：${scenario.indicators.join(', ')}`,
      '严格只输出 JSON：{"ratings":[{"indicator":"指标id","grade":"良好|合格|待提升","evidence":"依据引用"}],"artifact_summary":"本次会话产物一句话摘要"}',
    ].join('\n'),
    profile, history, maxTokens: 800, purpose: 'rating',
  });
  return { ratings: out?.ratings ?? [], artifact_summary: out?.artifact_summary ?? '' };
}

// ================= P2 工作台结构化调用 =================
export async function weeklyChat({ profile, context }) {
  const out = await callJSON({
    system: [
      '你是 PM-Master 的周报撰写助手。基于给定项目数据生成 Markdown 周报草稿，结构：',
      '## 一、关键进展（帕累托：聚焦20%关键成果）## 二、挣值视图（引用给定 EVM 数据，超容差需显著标注并建议例外上报）## 三、风险与问题（引用风险清单）## 四、干系人动态（参与度差距）## 五、下周计划（引用行动项）',
      '语言精炼专业；若数据含 openAlerts，在开头加 ⚠️ 例外预警提示（引用 PRINCE2 例外管理逻辑，建议进入「例外应对」教练场景）。',
      '严格只输出 JSON：{"markdown":"周报全文"}',
    ].join('\n'),
    profile, history: [{ role: 'user', content: JSON.stringify(context) }], maxTokens: 5000, purpose: 'weekly',
  });
  return { markdown: out?.markdown ?? null };
}

export async function riskChat({ profile, risk }) {
  const out = await callJSON({
    system: [
      '你是 PM-Master 的风险推演教练（二阶思维微训练）。对给定风险做三阶效应推演，最后一行给出一个引导用户思考的提问。',
      '严格只输出 JSON：{"first":"一阶效应","second":"二阶效应","third":"三阶效应","question":"引导提问"}',
    ].join('\n'),
    profile, history: [{ role: 'user', content: JSON.stringify(risk) }], maxTokens: 1200, purpose: 'risk_second_order',
  });
  return out ?? {};
}

// ================= P3 强化营结构化调用 =================
export async function drillChat({ profile, kind, depth, domain, card, question, model_answer, answer }) {
  const sys = kind === 'gen'
    ? [
        `你是 PM-Master 强化营出题器。为「${domain}」出一道情景应用题，认知深度要求：${depth}。`,
        '题干：真实项目情境（2-3 句）；model_answer：参考答案要点（3 条内）；不提供选项（主观作答）。',
        '严格只输出 JSON：{"question":"题干","model_answer":"参考要点"}',
      ].join('\n')
    : [
        `你是 PM-Master 强化营判分器。认知深度：${depth}。对比参考要点与学生作答，评定 good/ok/weak。`,
        'feedback：1-2 句针对性反馈（指出对什么/缺什么）。严格只输出 JSON：{"grade":"good|ok|weak","feedback":"反馈"}',
      ].join('\n');
  const history = kind === 'gen'
    ? [{ role: 'user', content: JSON.stringify({ domain, depth, card_hint: card }) }]
    : [{ role: 'user', content: JSON.stringify({ question, model_answer, answer }) }];
  // 出题/判分为高频轻任务：走快模型（OPENAI_MODEL_FAST），避开强模型 RPM 窗
  const out = await callJSON({ system: sys, profile, history, maxTokens: 2000, model: cfg('llm.model_fast'), purpose: kind === 'gen' ? 'drill_gen' : 'drill_grade' });
  return out ?? {};
}

async function callJSON({ system, profile, history, maxTokens, model, purpose = 'unknown' }) {
  const provider = cfg('llm.provider');
  const t0 = Date.now();
  let usage = null;   // R5.2 WP2：openai usage 回传收集（mock/pi 无 usage → NULL）
  try {
    // R7.0 P5 kill-switch：技能注册表（设置·L 区）停用的能力不进模型调用——失败照样落 llm_calls 可观测
    if (!skillEnabled(purpose)) throw new Error(`「${purpose}」AI 能力已在设置·技能注册表停用`);
    let out;
    if (provider === 'openai') out = await callOpenAIJSON({ system, profile, history, maxTokens, model, purpose, usageSink: (u) => { usage = u; } });
    else if (provider === 'pi') out = await callPiJSON({ system, profile, history });
    else out = mockJSON(system, profile, history);
    logCall(purpose, provider, provider === 'openai' ? (model ?? cfg('llm.model')) : null, Date.now() - t0, true, null, usage);
    return out;
  } catch (e) {
    logCall(purpose, provider, provider === 'openai' ? (model ?? cfg('llm.model')) : null, Date.now() - t0, false, String(e.message ?? e).slice(0, 200), usage);
    throw e;
  }
}

// ================= W4 风险评估 AI（抽取/报告） =================
export async function raExtractChat({ scenario, standard, asset_label, extra_fields, text }) {
  const out = await callJSON({
    system: [
      `你是「${standard}」${scenario === 'pia' ? '个人信息保护评估' : scenario === 'fin_data' ? '金融数据安全风险评估' : '信息安全风险评估'}的资深评估师。`,
      `从用户粘贴的资料（资产清单/访谈纪要/系统文档）中抽取两类候选（供人工确认）：`,
      `1) assets：资产/处理活动，字段 {name,type,confidentiality,integrity,availability${scenario === 'fin_data' ? ',data_level' : ''}}——赋值 1-5 需给出理由充分的建议值；`,
      `2) findings：风险链候选 {asset_name(匹配资产名),threat_desc,threat_freq(1-5),vuln_desc,vuln_sev(1-5),measures_existing${Object.keys(extra_fields ?? {}).length ? ',' + Object.keys(extra_fields).join(',') : ''}}；`,
      `只抽取资料有依据的内容，不臆造；每条附 basis(依据原文片段≤30字)。资产≤15条、风险项≤12条。`,
      '严格只输出 JSON：{"assets":[...],"findings":[...],"summary":"资料概况一句话"}',
    ].join('\n'),
    profile: { current_level: 4, target_level: 5, track: 'project' },
    history: [{ role: 'user', content: String(text).slice(0, 8000) }],
    maxTokens: 3000, model: cfg('llm.model_fast'), purpose: 'ra_extract',
  });
  return out ?? {};
}

export async function raReportChat({ detail }) {
  const isPia = detail.project.scenario.includes('个人信息');
  const out = await callJSON({
    system: [
      `你是「${detail.project.standard}」评估报告撰写专家。基于评估数据生成 Markdown 报告，结构：`,
      isPia
        ? '## 一、评估概述(处理活动/依据 PIPL§55-56) ## 二、处理活动清单 ## 三、合法·必要·告知同意分析 ## 四、个人权益影响风险与分布 ## 五、高风险项与处置建议 ## 六、结论与改进承诺'
        : '## 一、执行摘要 ## 二、评估范围与资产概况 ## 三、风险分析与分布(引用计算数据) ## 四、高风险项 Top(含处置建议) ## 五、处置计划汇总 ## 六、评估结论',
      '风险值引用给定数据不得改动；语言专业，符合金融监管报送口径；长度 600-900 字。',
      '严格只输出 JSON：{"markdown":"报告全文"}',
    ].join('\n'),
    profile: { current_level: 4, target_level: 5, track: 'project' },
    history: [{ role: 'user', content: JSON.stringify(detail) }],
    maxTokens: 4000, purpose: 'ra_report',
  });
  return out ?? {};
}

// ================= R2.1 全局 AI 助手（意图判定 + 自由问答） =================
export async function assistantChat({ text, pageContext, profile }) {
  const intentsHint = [
    'risk.create(登记风险:title必填,project,probability,impact,strategy)',
    'risk.escalate(升级风险:risk必填,project)',
    'risk.second_order(风险二阶推演:risk必填,project)',
    'risk.delete(删除风险,危险操作:risk必填,project)',
    'weekly.generate(生成周报:pv/ev/ac必填数字,project)',
    'weekly.export(导出周报:project)',
    'coach.start(教练演练:scenario,缺省report)',
    'task.add(新增行动项:title必填,owner,due_date,project)',
    'task.done(完成任务:task必填,project)',
    'stats.query(查询成长差距/项目统计:topic,project)',
    'card.search(搜知识卡片:q必填)',
  ].join('\n');
  const out = await callJSON({
    system: [
      '你是 PM-Master 工作台的全局 AI 助手。判断用户输入是否匹配以下某个操作意图，并抽取参数：',
      intentsHint,
      '规则：',
      '- 匹配则输出 {"intent":"意图id","params":{...}}；数字参数（probability/impact/pv/ev/ac）转数字。',
      '- 不匹配（概念提问/闲聊/咨询）则 intent=null，并在 reply 用简洁中文直接回答（可结合用户档案与当前页面上下文）。',
      `- 当前页面上下文：${pageContext?.tab ?? '未知'} 页${pageContext?.project_name ? `，正查看项目「${pageContext.project_name}」` : ''}——用户说"这个项目"即指它。`,
      '严格只输出 JSON：{"intent":"...|null","params":{...},"reply":"..."}',
    ].join('\n'),
    profile,
    history: [{ role: 'user', content: String(text).slice(0, 2000) }],
    maxTokens: 1500, model: cfg('llm.model_fast'), purpose: 'assistant_intent',
  });
  return out ?? {};
}

// ================= R7.0 P2 数据流入：粘贴文本 → 结构化行抽取（快模型；类型由用户先选，LLM 只抽字段） =================
const IMPORT_SCHEMA = {
  evm: '每行一条 EVM：{project_name, pv, ev, ac}（三数为正数，来自计划值/挣值/实际成本）',
  risks: '每行一条风险：{project_name, title(≤60字), probability(0-1), impact(0-1), strategy(可空)}',
  meetings: '每行一条会议：{project_name, title(≤60字), held_at(YYYY-MM-DD 可空), actions:[{title, owner, due_date}]（无行动项给 []）}',
  stakeholders: '每行一条干系人：{project_name, name, power(1-10), interest(1-10), current_engagement(支持/中立/反对等), desired_engagement}',
};

export async function importExtractChat({ kind, text }) {
  const out = await callJSON({
    system: [
      `你是 PM-Master 数据导入抽取器（${IMPORT_SCHEMA[kind] ?? IMPORT_SCHEMA.risks}）。`,
      '从用户粘贴的原始资料（表格复制文本/清单/纪要片段）中抽取结构化行：',
      '1) 只抽取资料中有依据的内容，不臆造；缺的字段给该类型合理默认值；',
      '2) project_name 取资料中出现的项目名（原文照抄，不改写）；',
      '3) 无法解析的行跳过并在 warnings 中说明原因（≤30字）。',
      '严格只输出 JSON：{"rows":[...],"warnings":["..."]}',
    ].join('\n'),
    profile: { current_level: 4, target_level: 5, track: 'project' },
    history: [{ role: 'user', content: JSON.stringify({ kind, text: String(text).slice(0, 30000) }) }],
    maxTokens: 3000, model: cfg('llm.model_fast'), purpose: 'import_extract',
  });
  return { rows: Array.isArray(out?.rows) ? out.rows.slice(0, 100) : [], warnings: (out?.warnings ?? []).map(String).slice(0, 10) };
}

// ================= R7.0 P3 巡检简报：findings（代码已判定）→ 一段优先级叙述（LLM 只写摘要，不做判定） =================
export async function patrolDigestChat({ date, counts, findings }) {
  const out = await callJSON({
    system: [
      '你是 PM-Master 每日巡检简报撰写器。给定巡检日期、严重度计数与发现清单（判定已由代码完成，不得增删改发现），',
      '写一段 100-200 字中文简报：先点最高优先级（高危优先，项目名照抄），再概括中低危分布，收尾给一句今日行动建议。',
      '语气专业克制，不用感叹号，不编造清单外的数据。',
      '严格只输出 JSON：{"digest":"简报正文"}',
    ].join('\n'),
    profile: { current_level: 4, target_level: 5, track: 'project' },
    history: [{ role: 'user', content: JSON.stringify({ date, counts, findings }) }],
    maxTokens: 1200, model: cfg('llm.model_fast'), purpose: 'patrol_digest',
  });
  return { digest: String(out?.digest ?? '') };
}

// ================= R2.2 ITTO 工具实操题（出题 + 判分，快模型） =================
const ITTO_DEPTH_HINT = {
  recognize: '「识别」：设计一个真实项目场景，让学生判断该场景中应使用什么工具/技术（考查工具识别）。',
  apply: '「应用」：结合用户档案等级设计一个真实 PM 情境，要求学生选择合适的工具/技术，并说明选用理由与该工具的局限。',
  integrate: '「整合」：设计一个多目标冲突的复杂情境，要求学生给出多工具组合方案，并说明组合间的权衡取舍。',
};

export async function ittoQuestionChat({ process: proc, depth, profile }) {
  // 参数重命名为 proc：避免遮蔽 Node 全局 process 导致 process.env 不可用
  const out = await callJSON({
    system: [
      `你是 PM-Master ITTO 实操出题器。围绕过程「${proc.name}」（${proc.ka || '项目管理'}知识域）出一道工具实操题，可用工具/技术：${(proc.tools ?? []).join('、') || '不限'}。`,
      `出题深度要求：${ITTO_DEPTH_HINT[depth] ?? ITTO_DEPTH_HINT.apply}`,
      'context=情境描述（2-4 句，含具体项目背景与矛盾点，贴合中国职场项目管理实际）；question=任务问题；reference=参考答案要点：期望工具 + 评分要点（3 条内）。',
      '严格只输出 JSON：{"question":"任务问题","context":"情境描述","reference":"参考答案要点"}',
    ].join('\n'),
    profile,
    history: [{ role: 'user', content: JSON.stringify({ process: proc.name, ka: proc.ka, tools: proc.tools, depth }) }],
    maxTokens: 2500, model: cfg('llm.model_fast'), purpose: 'itto_question',
  });
  return { question: String(out?.question ?? ''), context: String(out?.context ?? ''), reference: String(out?.reference ?? '') };
}

export async function ittoGradeChat({ question, context, reference, answer, profile }) {
  const out = await callJSON({
    system: [
      '你是 PM-Master ITTO 实操题判分器。对照参考答案要点判分：工具选择是否正确约 50 分 + 理由/组合质量约 50 分（口径灵活掌握，答出参考要点之外的有效内容也应给分）。',
      'verdict：good（≥80）/ ok（60-79）/ weak（<60）。',
      'comment：≤120 字，必须引用学生作答中的具体内容，指出与参考答案的差距与改进方向。',
      '严格只输出 JSON：{"score":0-100,"verdict":"good|ok|weak","comment":"点评"}',
    ].join('\n'),
    profile,
    history: [{ role: 'user', content: JSON.stringify({ question, context, reference, answer }) }],
    maxTokens: 2000, model: cfg('llm.model_fast'), purpose: 'itto_grade',
  });
  const score = Math.max(0, Math.min(100, Math.round(Number(out?.score)) || 0));
  const verdict = ['good', 'ok', 'weak'].includes(out?.verdict) ? out.verdict : (score >= 80 ? 'good' : score >= 60 ? 'ok' : 'weak');
  return { score, verdict, comment: String(out?.comment ?? '') };
}

// ================= R2.4 四步教学（W1.2：讲/示内容生成 + 费曼评定；练复用 itto 出题判分） =================

// mode=explain：结合用户真实项目语境讲概念；mode=demonstrate：用工作台真实数据现场演示工具
export async function tutorChat({ mode, tool, profile, data }) {
  const MODE_HINT = {
    explain: `你是 PM-Master 工具导师，执行四步教学法第①步「讲」。围绕工具「${tool.name}」（${tool.category || '项目管理'}类），结合用户档案中的真实项目背景讲解：是什么/解决什么问题/怎么用/常见误用。行文口语化，控制在 300 字内，贴合中国职场项目管理实际。`,
    demonstrate: `你是 PM-Master 工具导师，执行四步教学法第②步「示」。用下面提供的用户工作台真实数据，现场演示工具「${tool.name}」的完整应用过程：代入数据→逐步演算/推演→给出结论→点出该结果对项目的管理含义。演算过程展示关键步骤。`,
  };
  const out = await callJSON({
    system: [
      MODE_HINT[mode] ?? MODE_HINT.explain,
      'title=本步小标题（≤12字）；content=正文（Markdown，可含简单列表）；key_points=3 条要点（学完应记住什么）。',
      '严格只输出 JSON：{"title":"","content":"","key_points":["",""]}',
    ].join('\n'),
    profile,
    history: [{ role: 'user', content: JSON.stringify({ tool: tool.name, category: tool.category, workbench_data: data ?? null }) }],
    maxTokens: 2500, model: cfg('llm.model_fast'), purpose: mode === 'demonstrate' ? 'tutor_demonstrate' : 'tutor_explain',
  });
  return {
    title: String(out?.title ?? (mode === 'explain' ? '这是什么' : '真实数据演示')),
    content: String(out?.content ?? ''),
    key_points: Array.isArray(out?.key_points) ? out.key_points.map(String).slice(0, 3) : [],
  };
}

// 费曼闭环（M3 能教授）：用户向 AI 讲解工具，AI 判是否达到"能教会别人"标准
export async function tutorFeynmanChat({ tool, explanation, profile }) {
  const out = await callJSON({
    system: [
      `你是 PM-Master 费曼闭环评定器。学生刚学完工具「${tool.name}」，现在由他向你（扮演零基础新 PM）讲解这个工具。`,
      '判定标准：能讲清工具解决什么问题+使用步骤/要点+至少一个具体场景，允许口语化但不允许关键概念错误。',
      'qualified=true 仅当确实达到「能教授」水平（宁缺毋滥）；comment 必须先复述学生讲对了什么，再指出缺失或错误。',
      '严格只输出 JSON：{"qualified":true|false,"comment":"≤150字点评"}',
    ].join('\n'),
    profile,
    history: [{ role: 'user', content: JSON.stringify({ tool: tool.name, student_explanation: String(explanation ?? '').slice(0, 2000) }) }],
    maxTokens: 2000, model: cfg('llm.model_fast'), purpose: 'tutor_feynman',
  });
  return { qualified: Boolean(out?.qualified), comment: String(out?.comment ?? '') };
}

// R5.1 WP1 卡片费曼：强化营知识卡片「讲给 AI 听」→ 判定能教授（M3 实证通道）
export async function cardFeynmanChat({ card, explanation, profile }) {
  const out = await callJSON({
    system: [
      `你是 PM-Master 费曼闭环评定器（知识卡片版）。学生正在复习卡片「${card.front.slice(0, 80)}」，现在由他向你（扮演零基础新 PM）讲解这个知识点。`,
      '判定标准：能讲清概念是什么+为什么重要/何时用+至少一个具体场景或例子，允许口语化但不允许关键概念错误。',
      'qualified=true 仅当确实达到「能教授」水平（宁缺毋滥）；comment 必须先复述学生讲对了什么，再指出缺失或错误。',
      '严格只输出 JSON：{"qualified":true|false,"comment":"≤150字点评"}',
    ].join('\n'),
    profile,
    history: [{ role: 'user', content: JSON.stringify({ card_front: card.front, student_explanation: String(explanation ?? '').slice(0, 2000) }) }],
    maxTokens: 2000, model: cfg('llm.model_fast'), purpose: 'card_feynman',
  });
  return { qualified: Boolean(out?.qualified), comment: String(out?.comment ?? '') };
}

// ================= 冷启动评估（F0：履历结构化） =================
export async function onboardChat({ text }) {
  const out = await callJSON({
    system: [
      '你是 PM-Master 冷启动评估器（GB/T 41831-2022 五级体系）。输入是用户的简历/项目经历粘贴文本（可能粗糙）。',
      '任务：结构化为成长档案初稿。等级判定用短板原则：经验硬指标（年限/项目数×复杂度）能支撑的最高级；信息不足时保守取低。',
      '复杂度口径：normal=一般项目 / complex=复杂项目 / program=项目群组 / portfolio=项目组合；项目按规模/跨职能/创新度判断。',
      '严格只输出 JSON：{"pm_domain_years":数字,"pm_years":数字,"track":"project|pmo","suggested_level":1-5,"level_reason":"一句话依据",',
      '"projects":[{"name":"","complexity":"normal|complex|program","role":"","start":"","end":""}],',
      '"experience_stats":{"work_years":数字,"normal_projects_as_lead":数字,"complex_projects_as_lead":数字,"programs_as_lead":数字,"pmo_years":数字,"knowledge_contributions":数字}}',
      'experience_stats 只填文本可推断的键；推断不了的键省略。projects 至多 10 条。',
    ].join('\n'),
    profile: { current_level: 1, target_level: 2, track: 'project' },   // 占位档案（此调用不注入等级偏好）
    history: [{ role: 'user', content: String(text).slice(0, 6000) }],
    maxTokens: 3000, purpose: 'onboard',
  });
  return out ?? {};
}

// ================= pi provider（pi.dev CLI print 模式；AGENT_PROVIDER=pi 启用） =================
import { spawnSync } from 'node:child_process';

function piPrompt({ system, profile, history }) {
  const transcript = (history ?? [])
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
    .join('\n\n');
  return [
    system,
    profile ? `【用户档案】L${profile.current_level}→L${profile.target_level}，通道 ${profile.track}。回答深度对齐该等级。` : '',
    transcript,
    '请直接输出 JSON（不要围栏、不要解释）。',
  ].filter(Boolean).join('\n\n');
}

async function callPiJSON(args) {
  return looseJSON(runPi(piPrompt(args)));
}

function runPi(prompt) {
  const piModel = cfg('pi.model');
  const modelArgs = piModel ? ['--model', piModel] : [];
  const r = spawnSync('pi', ['-p', ...modelArgs, prompt], {
    encoding: 'utf8',
    timeout: 180_000,
    cwd: process.env.PI_CWD ?? process.cwd(),
  });
  if (r.error) throw new Error(`pi 调用失败：${r.error.message}（确认已安装：npm i -g @mariozechner/pi-coding-agent）`);
  if (r.status !== 0) throw new Error(`pi 退出码 ${r.status}: ${String(r.stderr).slice(0, 200)}`);
  return r.stdout;
}

function mockJSON(system, profile, history) {
  const last = [...history].reverse().find((m) => m.role === 'user');
  const inWill = system.includes('__') || system.includes('完整方案');
  // R6.6 助手意图确定性分支（仅 mock：无密钥 e2e 可跑通「计划→确认→执行」全链路）
  if (system.includes('全局 AI 助手') && /登记风险/.test(last?.content ?? '')) {
    return { intent: 'risk.create', params: { title: String(last.content).split(/[：:]/)[1]?.trim().slice(0, 40) || '（mock）风险标题' } };
  }
  // R7.0 P4 画像蒸馏/记忆提取 mock 分支（J9/J10 回归锚：无密钥环境确定性产出）
  if (system.includes('画像蒸馏器')) {
    let req = {};
    try { req = JSON.parse(last?.content ?? '{}'); } catch { /* 保持空 */ }
    const p = req.profile ?? {};
    return { summary: `（mock 画像）该用户当前 L${p.current_level ?? '?'}，目标 L${p.target_level ?? '?'}（${p.track === 'pmo' ? 'PMO' : '项目'}通道），证据 ${req.evidence?.length ?? 0} 项，综合分 ${req.scores?.composite ?? '-'}，重点培养短板维度。` };
  }
  if (system.includes('记忆提取器')) {
    let req = {};
    try { req = JSON.parse(last?.content ?? '{}'); } catch { /* 保持空 */ }
    return { memories: [`该用户在「${req.scenario?.name ?? '教练会话'}」中聚焦：${String(req.artifact_summary ?? '行动方案').slice(0, 40)}`] };
  }
  // R7.0 P3 巡检简报 mock 分支（J7 回归锚：无密钥环境 digest 通道确定性）
  if (system.includes('巡检简报撰写器')) {
    let req = {};
    try { req = JSON.parse(last?.content ?? '{}'); } catch { /* 保持空 */ }
    const c = req.counts ?? {};
    return { digest: `（mock）${req.date ?? ''} 巡检：高危 ${c.high ?? 0}、中 ${c.mid ?? 0}、低 ${c.low ?? 0}，优先处理高危项。` };
  }
  // R7.0 P2 周报 mock 分支（J6 回归锚：验收确定性验证 generateWeekly 全链路含 hints）
  if (system.includes('周报撰写助手')) {
    const ctx = JSON.parse([...history].reverse().find((m) => m.role === 'user')?.content ?? '{}');
    return { markdown: `# （mock）${ctx.project?.name ?? '项目'} 周报\n\nEVM：SPI ${ctx.evm?.spi ?? '-'} / CPI ${ctx.evm?.cpi ?? '-'}；开放预警 ${ctx.openAlerts?.length ?? 0} 条。` };
  }
  // R7.0 P2 数据导入抽取确定性分支（仅 mock：无密钥环境可跑 preview→commit 全链路验收）
  if (system.includes('数据导入抽取器')) {
    let req = {};
    try { req = JSON.parse(last?.content ?? '{}'); } catch { /* 保持空 req 走 risks 缺省 */ }
    const kind = ['evm', 'risks', 'meetings', 'stakeholders'].includes(req.kind) ? req.kind : 'risks';
    const lines = String(req.text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[#|>*-]/.test(l));
    const rows = lines.slice(0, 20).map((l) => {
      const cells = l.split(/[\t,，;；]+/).map((c) => c.trim()).filter(Boolean);
      const nums = (l.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      if (kind === 'evm') return { project_name: cells[0] ?? '', pv: nums[0] ?? 0, ev: nums[1] ?? 0, ac: nums[2] ?? 0 };
      if (kind === 'meetings') return { project_name: cells[0] ?? '', title: cells[1] ?? l.slice(0, 40), held_at: null, actions: [] };
      if (kind === 'stakeholders') return { project_name: cells[0] ?? '', name: cells[1] ?? cells[0] ?? '', power: 5, interest: 5, current_engagement: '中立', desired_engagement: '支持' };
      return { project_name: cells[0] ?? '', title: cells[1] ?? l.slice(0, 40), probability: 0.5, impact: 0.7 };
    });
    return { rows, warnings: [] };
  }
  // R3.5 验收确定性分支：ITTO 出题/判分（无密钥环境可跑 A6/B1 实操链路）
  if (system.includes('实操出题器')) {
    return {
      question: '（mock）该情境下你会选用哪些工具/技术？说明选择理由与局限。',
      context: '（mock）某项目情境描述：进度与成本出现偏差，需要给出分析方案。',
      reference: '（mock）期望工具 + 评分要点三条。',
    };
  }
  if (system.includes('实操题判分器')) {
    return { score: 75, verdict: 'ok', comment: '（mock）工具选择正确，理由充分，组合质量尚可。' };
  }
  if (system.includes('费曼闭环评定器')) {
    return { qualified: true, comment: '（mock）复述准确：概念定义清楚，使用场景具体，关键要点无错漏，达到能教授水平。' };
  }
  if (system.includes('will') || /W 阶段完整产物/.test(system)) {
    return {
      will: `**行动方案**\n1. 【今日】按例外报告结构整理偏差事实与两方案对比（责任人：我）\n2. 【T+1】向 sponsor 汇报并锁定决策（话术见下）\n3. 【T+3】将合同价格锁定条款写入 lessons-learned\n\n**关键话术**\n- 开场：「先说结论：成本超容差13%，根因已锁定，两条路线需您今天定一条。」\n- 收尾：「如无异议，我按方案A推进并明日同步执行细节。」`,
    };
  }
  if (system.includes('评定器')) {
    const id = /可评指标：(\S+)/.exec(system)?.[1]?.split(',')[0];
    return {
      artifact_summary: `「${last?.content.slice(0, 12) ?? '教练'}」教练会话：明确目标→定位根因→选定策略并产出行动方案`,
      ratings: [
        { indicator: id ?? 'communication', grade: '良好', evidence: 'W 阶段产物含完整决策请求与话术，目标-底线在 G 阶段清晰界定' },
        { indicator: 'result_oriented', grade: '合格', evidence: '方案有明确时间节点，但未量化验收标准' },
      ],
    };
  }
  return {
    reply: `收到，我理解你的要点是：「${(last?.content ?? '').slice(0, 40)}」。已记录。`,
    collected: { [Date.now()]: (last?.content ?? '').slice(0, 30) },
    ask: '（mock）请继续按步骤主题作答，或输入控制命令跳过。',
  };
}

async function callOpenAIJSON({ system, profile, history, maxTokens, model, purpose, usageSink }) {
  const base = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 未配置（server/.env）');
  const body = {
    model: model ?? cfg('llm.model'),
    messages: [
      { role: 'system', content: `${system}\n\n【用户档案】L${profile.current_level}→L${profile.target_level}，通道 ${profile.track}。回答深度对齐该等级。` },
      ...history.map((m) => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
    ],
    temperature: 0.4,
    // 推理模型（如 deepseek-v4-flash）思考也耗 token，预算放大
    max_tokens: Math.max(maxTokens ?? 1200, cfg('llm.max_tokens_floor')),
  };
  // 仅在网关支持时启用 json_object（SenseNova token 网关支持；部分严格网关可关）
  if (cfg('llm.json_mode')) body.response_format = { type: 'json_object' };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  // 429 限流：按模型 RPM 窗退避重试（强模型走 cfg('llm.backoff_ms') 默认 65s；快模型 15s）；限流事件落观测行（WP8：从不可见变可观测）
  if (res.status === 429) {
    const backoff = model ? 15000 : cfg('llm.backoff_ms');
    logCall(purpose ?? 'unknown', 'openai', body.model, backoff, 0, `HTTP 429 限流（${backoff / 1000}s 退避后重试）`);
    await new Promise((r) => setTimeout(r, backoff));
    const res2 = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!res2.ok) throw new Error(`LLM ${res2.status}: ${(await res2.text()).slice(0, 200)}`);
    const j2 = await res2.json();
    usageSink?.(j2.usage ?? null);
    return looseJSON(j2.choices?.[0]?.message?.content ?? '');
  }
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  usageSink?.(j.usage ?? null);   // R5.2 WP2：usage 回传（部分网关可能缺省 → NULL）
  const content = j.choices?.[0]?.message?.content ?? '';
  return looseJSON(content);
}

// 宽松解析：剥 markdown 围栏 / 截取首尾大括号 / 容忍前后杂文
export function looseJSON(text) {
  if (!text) return null;
  let t = text.replace(/```(?:json)?/gi, '').trim();
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch { return null; }
}
