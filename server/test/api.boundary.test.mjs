// R6.3 全站测试 · HTTP 边界回归（TDD 红先绿后）
// seam：fastify app.inject（公开 API 边界，无端口/无浏览器）；PM_NO_LISTEN 机制同 acceptance
// 背景：2026-10-10 全站侦察发现 7 处「200 假成功/脏数据入库」缺陷，本文件为其永久回归锚
process.env.AGENT_PROVIDER = 'mock';
process.env.PM_NO_LISTEN = '1';

import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DB = join(DATA, 'test-boundary.db');
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.PM_DB_PATH = DB;

const { db, getProfile } = await import('../src/db.mjs');
const { seedCards, seedItto } = { seedCards: (await import('../src/seeds.mjs')).seedCards, seedItto: (await import('../src/itto.mjs')).seedItto };
seedCards(); seedItto();
const { app } = await import('../src/index.mjs');

const inj = async (method, url, payload) => app.inject({ method, url, payload });
const one = (s, ...p) => db.prepare(s).get(...p);

let projectId, taskId, cardId, notifId;
before(async () => {
  projectId = (await inj('POST', '/api/v2/projects', { name: '边界桩项目' })).json().id;
  cardId = one('SELECT id FROM knowledge_cards ORDER BY id LIMIT 1').id;
});

// ── J1 复习卡拒绝非法 grade（原缺陷：nonsense 落 last_grade 污染调度数据） ──
test('J1 复习卡 grade 白名单：非 good/ok/weak 拒绝且不落库', async () => {
  const r = await inj('POST', `/api/v2/drill/cards/${cardId}/review`, { grade: 'nonsense' });
  assert.notEqual(r.statusCode, 200, `非法 grade 不应 200 假成功：${r.body.slice(0, 100)}`);
  assert.equal(one('SELECT last_grade g FROM knowledge_cards WHERE id=?', cardId).g, null, 'last_grade 不应被写入');
  assert.ok((await inj('POST', `/api/v2/drill/cards/${cardId}/review`, { grade: 'good' })).statusCode === 200, '合法 grade 仍可用');
});

// ── J2 情景题拒绝未知知识域（原缺陷：notadomain 静默走默认出题，depth 兜底） ──
test('J2 情景题未知域拒绝', async () => {
  const r = await inj('POST', '/api/v2/drill/scenario/notadomain');
  assert.notEqual(r.statusCode, 200, `未知域不应出题：${r.body.slice(0, 100)}`);
  const ok = await inj('POST', '/api/v2/drill/scenario/risk');
  assert.equal(ok.statusCode, 200, '合法域正常');
});

// ── J3 空名项目拒绝（原缺陷：name='' 建出 id=4 空名行） ──
test('J3 空名/纯空格项目拒绝，正常名仍创建', async () => {
  const r = await inj('POST', '/api/v2/projects', { name: '   ' });
  assert.notEqual(r.statusCode, 200, `空名不应 200：${r.body.slice(0, 100)}`);
  assert.equal(one(`SELECT COUNT(*) c FROM projects WHERE TRIM(name)=''`).c, 0, '不应产生空名行');
});

// ── J4 不存在资源的状态更新拒绝（原缺陷：tasks/notifications UPDATE 0 行仍 {ok:true}） ──
test('J4a 不存在任务改状态拒绝', async () => {
  const r = await inj('POST', '/api/v2/drill/tasks/999999/status', { status: 'done' });
  assert.notEqual(r.statusCode, 200, '不存在任务不应 ok:true 假成功');
});
test('J4b 不存在通知标已读拒绝', async () => {
  const r = await inj('POST', '/api/v2/notifications/999999/read');
  assert.notEqual(r.statusCode, 200, '不存在通知不应假成功');
});

// ── J5 经验现值拒绝负数/非数字（原缺陷：-5 与 'abc' 均 200，后者写 null 毁现值） ──
test('J5 经验硬指标拒绝负数与 NaN', async () => {
  assert.notEqual((await inj('PUT', '/api/v2/records/experience-stats', { managed_projects: -5 })).statusCode, 200, '负数应拒绝');
  assert.notEqual((await inj('PUT', '/api/v2/records/experience-stats', { managed_projects: 'abc' })).statusCode, 200, 'NaN 应拒绝');
  const ok = await inj('PUT', '/api/v2/records/experience-stats', { managed_projects: 3 });
  assert.equal(ok.statusCode, 200, '合法数字仍可用');
});

// ── J6 非法等级返回 400 级清晰错误（原缺陷：Cannot read properties of undefined 内部错） ──
test('J6 未知等级要求 4xx 且错误可读', async () => {
  const r = await inj('GET', '/api/v2/standard/requirements/9');
  assert.ok(r.statusCode >= 400 && r.statusCode < 500, `应 4xx 非 500 内部错：${r.statusCode}`);
  assert.doesNotMatch(r.json().message, /Cannot read properties/, '错误信息不应是裸类型错');
});

// ── J7 助手空输入本地短路（原缺陷：空 text 打到 LLM 浪费配额） ──
test('J7 助手空输入不调 LLM 直接提示', async () => {
  const r = await inj('POST', '/api/v2/assistant/parse', { text: '   ' });
  assert.equal(r.statusCode, 200, '短路应 200 友好提示（非报错）');
  const j = r.json();
  assert.ok(j.intent == null && !String(j.reply ?? '').includes('LLM'), `不应出现 LLM 错误透传：${JSON.stringify(j).slice(0, 120)}`);
});

// ════ K 组：R6.4 错误风格体系化（v5.9.2 登记不修项①② → 本轮转正） ════
// 约定：输入校验失败=400，资源不存在=409/404 按语义，body 保持 {statusCode,error,message} 形态（前端 RA.jsx 依赖 out.statusCode）

// ── K1 输入校验类失败统一 400（原：全部 throw→500） ──
test('K1 校验失败精确 400', async () => {
  const cases = [
    ['非法grade', 'POST', `/api/v2/drill/cards/${cardId}/review`, { grade: 'nope' }],
    ['未知域', 'POST', '/api/v2/drill/scenario/notadomain', undefined],
    ['空项目名', 'POST', '/api/v2/projects', { name: '' }],
    ['负经验值', 'PUT', '/api/v2/records/experience-stats', { managed_projects: -1 }],
    ['NaN经验值', 'PUT', '/api/v2/records/experience-stats', { managed_projects: 'abc' }],
    ['费曼短文本', 'POST', `/api/v2/drill/cards/${cardId}/feynman`, { explanation: '太短' }],
    ['benefit非数字', 'POST', `/api/v2/projects/${projectId}/benefit`, { benefit_target: 'abc' }],
    ['导出缺markdown', 'POST', '/api/v2/feishu/export-doc', { title: 't' }],
    ['未知标准库', 'GET', '/api/v2/standard/nope', undefined],
  ];
  for (const [name, m, p, b] of cases) {
    const r = await inj(m, p, b);
    assert.equal(r.statusCode, 400, `${name} 应 400（实得 ${r.statusCode}）：${r.body.slice(0, 80)}`);
  }
});

// ── K2 资源不存在统一 404（原缺陷：alerts ack / actions status 假成功 200；其余 throw→500） ──
test('K2 不存在资源精确 404 且不假成功', async () => {
  const cases = [
    ['不存在任务', 'POST', '/api/v2/drill/tasks/999999/status', { status: 'done' }],
    ['不存在通知', 'POST', '/api/v2/notifications/999999/read', undefined],
    ['不存在项目benefit', 'POST', '/api/v2/projects/999999/benefit', { benefit_target: 1 }],
    ['不存在卡片复习', 'POST', '/api/v2/drill/cards/999999/review', { grade: 'good' }],
    ['不存在预警ack', 'POST', '/api/v2/projects/alerts/999999/ack', undefined],
    ['不存在行动项', 'POST', '/api/v2/projects/actions/999999/status', { status: 'done' }],
  ];
  for (const [name, m, p, b] of cases) {
    const r = await inj(m, p, b);
    assert.equal(r.statusCode, 404, `${name} 应 404（实得 ${r.statusCode}）：${r.body.slice(0, 80)}`);
  }
});

// ── K3 反馈通道 HTTP 层错误语义（I1 模块级已测，此为路由层状态码锚） ──
test('K3 feedback 校验 400 / 双确认 400 / 不存在 404', async () => {
  assert.equal((await inj('POST', '/api/v2/feedback', { content: '   ' })).statusCode, 400, '空内容应 400');
  assert.equal((await inj('POST', '/api/v2/feedback', { content: 'x'.repeat(2001) })).statusCode, 400, '超长应 400');
  assert.equal((await inj('POST', '/api/v2/feedback', { content: 'ok', rating: 9 })).statusCode, 400, '非法 rating 应 400');
  const id = (await inj('POST', '/api/v2/feedback', { content: 'K3 边界桩反馈' })).json().id;
  assert.equal((await inj('DELETE', `/api/v2/feedback/${id}?confirm=0`)).statusCode, 400, '双确认不符应 400');
  assert.equal((await inj('DELETE', `/api/v2/feedback/${id}?confirm=${id}`)).statusCode, 200, 'confirm=id 删除成功');
  assert.equal((await inj('DELETE', `/api/v2/feedback/${id}?confirm=${id}`)).statusCode, 404, '重复删除应 404');
});

// ── K5 导出 JSON tables 过滤路由透传（R6.5 C3：query 逗号解析 + 未知表 400） ──
test('K5 导出过滤透传：所选表齐备、未知表 400、markdown 不受影响', async () => {
  const all = (await inj('GET', '/api/v2/export/json')).json();
  const f = (await inj('GET', '/api/v2/export/json?tables=projects,user_profile')).json();
  assert.deepEqual(Object.keys(f.tables).sort(), ['projects', 'user_profile'], `过滤应只含所选两表：${JSON.stringify(Object.keys(f.tables))}`);
  assert.equal(f.counts.projects, all.counts.projects, '过滤不改行数口径');
  assert.equal((await inj('GET', '/api/v2/export/json?tables=nope')).statusCode, 400, '未知表应 400');
  const md = await inj('GET', '/api/v2/export/markdown');
  assert.equal(md.statusCode, 200, 'markdown 导出仍正常');
  assert.ok(md.body.includes('## 八、训练任务') && md.body.includes('## 九、情景题错题'), 'markdown 含 C3 新章节');
});

// ── K6 助手日志端点边界（R6.6：写入校验 400 / 清空缺 confirm 400 / 正确清空 200） ──
test('K6 日志端点边界：非法 role 400 / 缺 confirm 400 / 正确清空 200', async () => {
  assert.equal((await inj('POST', '/api/v2/assistant/messages', { role: 'nope', content: 'x' })).statusCode, 400, '非法 role 应 400');
  assert.equal((await inj('POST', '/api/v2/assistant/messages', { role: 'me', content: '   ' })).statusCode, 400, '空内容应 400');
  const ok = await inj('POST', '/api/v2/assistant/messages', { role: 'me', content: 'K6 桩消息' });
  assert.equal(ok.statusCode, 200, '合法写入应 200');
  assert.equal((await inj('DELETE', '/api/v2/assistant/messages')).statusCode, 400, '缺 confirm 应 400');
  assert.equal((await inj('DELETE', '/api/v2/assistant/messages?confirm=nope')).statusCode, 400, '错误 confirm 应 400');
  const list = (await inj('GET', '/api/v2/assistant/messages')).json();
  assert.ok(Array.isArray(list) && list.some((m) => m.content === 'K6 桩消息'), '列表应含写入项');
  assert.equal((await inj('DELETE', '/api/v2/assistant/messages?confirm=clear')).statusCode, 200, '确认清空应 200');
  assert.equal((await inj('GET', '/api/v2/assistant/messages')).json().length, 0, '清空后列表应为空');
});

// ── K7 计划卡状态端点（R6.6b：非法 state 400 / 不存在 404 / 非计划行 409 / 正常流转 200） ──
test('K7 计划卡状态端点边界', async () => {
  const content = JSON.stringify({ plan: { title: '创建风险', steps: ['一步'], danger: false }, state: 'pending' });
  const row = (await inj('POST', '/api/v2/assistant/messages', { role: 'ai', kind: 'plan', content })).json();
  assert.equal(row.kind, 'plan', 'plan 行应可写入（HTTP 层）');
  assert.equal((await inj('POST', '/api/v2/assistant/messages', { role: 'ai', kind: 'plan', content: 'not-json' })).statusCode, 400, '非法计划内容应 400');
  assert.equal((await inj('POST', `/api/v2/assistant/messages/${row.id}/plan-state`, { state: 'weird' })).statusCode, 400, '非法 state 应 400');
  assert.equal((await inj('POST', '/api/v2/assistant/messages/999999/plan-state', { state: 'done' })).statusCode, 404, '不存在应 404');
  const txt = (await inj('POST', '/api/v2/assistant/messages', { role: 'me', content: 'K7 桩' })).json();
  assert.equal((await inj('POST', `/api/v2/assistant/messages/${txt.id}/plan-state`, { state: 'done' })).statusCode, 409, '非计划行应 409');
  const done = await inj('POST', `/api/v2/assistant/messages/${row.id}/plan-state`, { state: 'done' });
  assert.equal(done.statusCode, 200, '正常流转应 200');
  assert.equal(JSON.parse(done.json().content).state, 'done', '返回行应含流转后状态');
});

// ── K8 飞书删除路由暴露（R7.0 补漏：deleteDoc 原先无 HTTP 入口） ──
test('K8 飞书删除端点：缺 ref 400 / 双确认不符 400 / 未配置明确降级 400', async () => {
  assert.equal((await inj('POST', '/api/v2/feishu/delete', { confirm: 'x' })).statusCode, 400, '缺 ref 应 400');
  assert.equal((await inj('POST', '/api/v2/feishu/delete', { ref: 'AbCdEf1234', confirm: 'other' })).statusCode, 400, 'confirm≠ref 应 400');
  const r = await inj('POST', '/api/v2/feishu/delete', { ref: 'AbCdEf1234', confirm: 'AbCdEf1234' });
  assert.equal(r.statusCode, 400, '未配置飞书应 400 明确降级（非 500）');
  assert.equal(r.json().code, 'NOT_CONFIGURED', '应返回可识别降级码');
});

// ── K4 错误 body 形态契约（前端 RA.jsx 等以 out.statusCode 判错，形态不得破坏） ──
test('K4 4xx 响应保持 {statusCode,error,message} 形态', async () => {
  const j = (await inj('POST', '/api/v2/projects', { name: '' })).json();
  assert.equal(j.statusCode, 400);
  assert.equal(j.error, 'Bad Request');
  assert.ok(typeof j.message === 'string' && j.message.length > 0, 'message 须可读');
  // 未标记的内部错误仍 500（不误伤：机制只升降级显式标记的错误）
  const nf = (await inj('GET', '/api/nonexistent-route')).json();
  assert.equal(nf.statusCode, 404, `路由不存在应 404：${JSON.stringify(nf).slice(0, 80)}`);
});

// ── K9 R7.1 P2 项目事件 → 项目级记忆钩子（HTTP 路由接线；复利闭环①） ──
test('K9 项目事件钩子：风险/干系人/会议纪要沉淀 project 域记忆；空 summary 不落入', async () => {
  await inj('POST', `/api/v2/projects/${projectId}/risks`, { title: 'K9 进度风险', probability: 0.6, impact: 0.8, strategy: '赶工' });
  const rm = one(`SELECT kind, scope, horizon, level, category, project_id FROM memories WHERE source='project#risk' AND project_id=?`, projectId);
  assert.ok(rm, '风险登记应沉淀 project 域记忆');
  assert.deepEqual([rm.kind, rm.scope, rm.horizon, rm.level, rm.category], ['project', 'project', 'long', 2, 'risk'], 'risk 记忆维度正确');

  await inj('POST', `/api/v2/projects/${projectId}/stakeholders`, { name: 'K9 干系人', power: 8, interest: 6 });
  assert.equal(one(`SELECT category FROM memories WHERE source='project#stakeholder' AND project_id=?`, projectId).category, 'stakeholder', '干系人应沉淀 stakeholder 记忆');

  await inj('POST', `/api/v2/projects/${projectId}/meetings`, { title: 'K9 决策会', summary: '决定采用方案 B' });
  assert.equal(one(`SELECT category FROM memories WHERE source='project#decision' AND project_id=?`, projectId).category, 'decision', '会议纪要应沉淀 decision 记忆');

  const cnt = one(`SELECT COUNT(*) c FROM memories WHERE source='project#decision' AND project_id=?`, projectId).c;
  await inj('POST', `/api/v2/projects/${projectId}/meetings`, { title: 'K9 无纪要会', summary: '' });
  assert.equal(one(`SELECT COUNT(*) c FROM memories WHERE source='project#decision' AND project_id=?`, projectId).c, cnt, '空 summary 不产生决策记忆');
});
