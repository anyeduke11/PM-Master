// R4.2 WP4/WP5 · 浏览器层渲染回归（node:test + playwright-core + 本机 Chrome，零大额下载）
// 运行：cd server && npm run test:e2e
// 隔离：自起 server（PM_DB_PATH 独立测试库 + AGENT_PROVIDER=mock）与 vite dev（VITE_API_TARGET 指向隔离服务），
//       R5.2 WP4：端口动态取空闲（启动前探测，消除固定 8795/8796 被占的脆弱性）；测试结束杀进程组 + 删测试库
// 覆盖：F1 冷启动跳过→主壳渲染 / F2 Growth 页闭环卡五格与 API 一致（D1-D3 浏览器层替身收口）/
//       F3 知识库掌握度矩阵四档计数与 API 一致 / F4 通知点击转已读（铃铛角标→面板→条目样式，v4.7① 收口）/
//       F5-F7 R5.2 WP5 三条 LLM 交互路径（mock）：教练对话流归档 / 强化营卡片复习 / 四步教学全流程 /
//       F8 R6.2 WP1 移动端响应式（375×812 窄屏：强化营+成长路径无横向溢出，桌面 F1-F7 即回归锚）/
//       F9-F10 R6.6 AI 面整合（侧栏为唯一 AI 面：流式问答+刷新持久化 / 意图计划执行+清空双确认）
process.env.AGENT_PROVIDER = 'mock';

import { rmSync } from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = join(ROOT, 'server', 'data', 'test-e2e.db');
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

// R5.2 WP4：动态端口（listen 0 → OS 分配空闲口；strictPort 保留，端口竞态由重跑兜底）
const getFreePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  srv.on('error', reject);
});

let API, WEB;
let serverProc, viteProc, browser, page;
const j = async (url, opts) => (await fetch(url, opts)).json();

async function until(fn, ms = 30_000, step = 300) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* 未就绪继续轮询 */ }
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, step));
  }
}

before(async () => {
  const apiPort = await getFreePort();
  const webPort = await getFreePort();
  API = `http://127.0.0.1:${apiPort}`;
  WEB = `http://127.0.0.1:${webPort}`;
  serverProc = spawn('node', ['src/index.mjs'], {
    cwd: join(ROOT, 'server'), detached: true,
    env: { ...process.env, PORT: String(apiPort), PM_DB_PATH: DB, AGENT_PROVIDER: 'mock', FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  viteProc = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'], {
    cwd: join(ROOT, 'web'), detached: true,
    env: { ...process.env, VITE_API_TARGET: API },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  viteProc.stdout.on('data', () => {});   // vite 就绪日志走 HTTP 探测，不刷屏
  viteProc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await until(async () => (await fetch(`${API}/api/health`)).ok);
  await until(async () => (await fetch(WEB)).ok);
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);
});

after(async () => {
  await browser?.close().catch(() => {});
  for (const p of [viteProc, serverProc]) { if (p?.pid) try { process.kill(-p.pid, 'SIGTERM'); } catch { /* 已退出 */ } }
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
});

const tab = (label) => page.locator('nav.tabs button', { hasText: label });

test('F1 冷启动：跳过向导 → 主壳与 8 个 tab 渲染', async () => {
  await page.goto(WEB);
  await page.getByRole('button', { name: /跳过 · 沿用当前档案/ }).click();
  await page.locator('header h1', { hasText: 'PM-Master · 项目经理成长工作台' }).waitFor();
  assert.equal(await tab('教练室').count(), 1);
  assert.equal(await tab('项目工作台').count(), 1);
  assert.equal(await tab('风险评估').count(), 1);
  assert.equal(await tab('成长记录').count(), 1);
  assert.equal(await tab('强化营').count(), 1);
  assert.equal(await tab('知识库').count(), 1);
  assert.equal(await tab('成长路径').count(), 1);
  assert.equal(await tab('设置').count(), 1);
  assert.equal(await page.locator('nav.tabs button').count(), 8, 'R7.0 P1 设置中心上线后应为 8 tab');
  assert.ok(await page.locator('.bell-btn').isVisible(), '通知铃铛应渲染');
});

test('F2 Growth 页渲染：闭环卡五格数字与 API 一致（D1-D3 浏览器层）', async () => {
  const rec = await j(`${API}/api/growth/recalc`, { method: 'POST' });   // 先造 assessments/links/tasks
  assert.ok(rec.links.created > 0, `重算应建链：${JSON.stringify(rec.links).slice(0, 80)}`);
  // F1 跳过向导后 Onboard onDone 已 setTab('growth')（App.jsx），此刻需先切走再切回强制 remount + load()
  await tab('项目工作台').click();
  await tab('成长路径').click();
  const card = page.locator('.card', { hasText: '成长闭环' });
  await card.locator('b').first().waitFor();
  const links = await j(`${API}/api/growth/links`);
  const nums = await card.locator('b').allTextContents();   // [全部, 差距, 训练中, 已闭环, 闭环率]
  assert.deepEqual(nums.slice(0, 4).map(Number), [links.total, links.open, links.trained, links.closed],
    `五格数字与 API 不一致：页面=${JSON.stringify(nums)} API=${JSON.stringify(links)}`);
  assert.equal(nums[4], `${Math.round(links.closure_rate * 100)}%`);
  // D3 渲染联动：三维合成三个进度条 + 训练任务卡随重算出现
  const dims = page.locator('.card', { hasText: '三维合成' });
  for (const n of ['知识 K', '素质 C', '经验 E']) assert.ok(await dims.locator(`span:has-text("${n}")`).first().isVisible(), `${n} 应渲染`);
  await page.locator('.card', { hasText: '训练任务' }).locator('input[type="checkbox"]').first().waitFor();
});

test('F3 知识库页渲染：掌握度矩阵四档计数与 API 一致', async () => {
  await tab('知识库').click();
  await page.locator('h3', { hasText: '掌握度矩阵 · M0—M3' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.mx-cell').length === 4, null, { timeout: 20_000 });
  const cells = page.locator('.mx-cell');
  assert.equal(await cells.count(), 4, '应渲染 M0-M3 四档');
  const mx = await j(`${API}/api/itto/mastery-matrix`);
  const texts = await cells.allTextContents();
  mx.counts.forEach((c, i) => {
    assert.ok(texts[i].includes(`${c.key} ${c.name}`), `第 ${i} 档应为 ${c.key}：${texts[i]}`);
    assert.ok(texts[i].includes(`工具 ${c.tools} · 卡片 ${c.cards}`), `${c.key} 计数应与 API 一致：${texts[i]}`);
  });
  // M3 档默认选中：纯新库无 M3 条目 → 空态文案；切 M0 档验证 chips 清单渲染（M0 用 itto-chips，M1-M3 才用 mx-row）
  assert.ok(await page.locator('small', { hasText: '该档暂无条目' }).isVisible(), 'M3 空档应显示空态');
  await page.locator('.mx-cell', { hasText: 'M0' }).click();
  const mxCard = page.locator('.card', { hasText: '掌握度矩阵' });
  await until(async () => (await mxCard.locator('.itto-chip').count()) === mx.counts[0].tools);
  assert.equal(await mxCard.locator('.itto-chip').count(), mx.counts[0].tools, 'M0 档 chips 应与 API 计数一致');
});

test('F4 WP5 通知点击转已读：角标 → 面板 → 条目样式与角标联动', async () => {
  // 通知走 scheduler monthly_report job（deliverReport 投递；/api/growth/monthly-report 只生成不投递）
  const run = await j(`${API}/api/scheduler/run/monthly_report`, { method: 'POST' });
  assert.ok(!run.last_error, `job 应成功：${JSON.stringify(run).slice(0, 160)}`);
  const before0 = await j(`${API}/api/notifications`);
  assert.ok(before0.unread >= 1, '月报投递应产生未读通知');

  await page.locator('.bell-btn').click();
  const panel = page.locator('.bell-panel');
  await panel.waitFor();
  const first = panel.locator('.bell-item').first();
  await first.waitFor();
  assert.ok(!await first.evaluate((el) => el.classList.contains('read')), '未读条目应无 read 类');
  assert.equal(await panel.locator('.bell-dot').count(), before0.unread, '未读蓝点数应等于未读数');

  const badge0 = await page.locator('.bell-badge').textContent();
  await first.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.bell-item');
    return el?.classList.contains('read');
  });
  assert.equal(await panel.locator('.bell-dot').count(), before0.unread - 1, '点击后该条蓝点应消失');
  const afterUnread = (await j(`${API}/api/notifications`)).unread;
  assert.equal(afterUnread, before0.unread - 1, 'API 未读数应减一');
  if (afterUnread > 0) assert.equal(await page.locator('.bell-badge').textContent(), String(afterUnread), `角标应从 ${badge0} 变为 ${afterUnread}`);
  else assert.equal(await page.locator('.bell-badge').count(), 0, '未读清零后角标应消失');
});

// ============ R5.2 WP5：三条 LLM 交互路径（mock） ============

test('F5 教练对话流：场景开场 → /skip 推进至 E → 归档落证据', async () => {
  await tab('教练室').click();
  const sc = page.locator('.sc', { hasText: '向上汇报' }).first();   // report 场景（L4 档全解锁）
  await sc.waitFor();
  await sc.click();
  await page.locator('#bar input:not([disabled])').waitFor();       // 输入框启用 = 会话已开
  // /skip 推进步骤直至 E 阶段（mock 快速；控制命令经 #bar input）
  for (let i = 0; i < 30; i++) {
    if (await page.getByRole('button', { name: '结束并归档' }).count()) break;
    await page.locator('#bar input').fill('/skip');
    await page.locator('#bar input').press('Enter');
    await until(async () => (await page.locator('#bar button').first().textContent()) === '发送');   // 等 busy 结束
  }
  await page.getByRole('button', { name: '结束并归档' }).click();
  const sys = page.locator('.m.sys', { hasText: '会话已归档' });
  await sys.waitFor();
  assert.ok(/证据 #\d+/.test(await sys.textContent()), `归档应提示证据编号：${await sys.textContent()}`);
});

test('F6 强化营答题：卡片复习 good → due_today 减一 + 聚合条联动', async () => {
  await tab('强化营').click();
  const counter = page.locator('small', { hasText: /待复习 \d+ 张/ }).first();
  await counter.waitFor();
  const s0 = await j(`${API}/api/drill/due-summary`);
  assert.ok(s0.due_today > 0, `种子卡应产生到期卡：${s0.due_today}`);
  await page.locator('.card', { hasText: '今日复习队列' }).locator('.rowitem').first().click();
  await page.getByRole('button', { name: '先心里作答，再看答案' }).click();
  await page.getByRole('button', { name: /清晰/ }).click();          // good → 间隔拉长，移出今日到期
  // 断言对象是 due_today（队列长度受 LIMIT 恒定，非正确信号）：API -1 + 聚合条同步（R6.8 pill→badge）
  await until(async () => (await j(`${API}/api/drill/due-summary`)).due_today === s0.due_today - 1);
  await page.locator('.badge', { hasText: `今日应复习 ${s0.due_today - 1}` }).waitFor({ timeout: 10_000 });
});

test('F7 四步教学：讲→示→练→用 全流程（mock）→ M2 会应用', async () => {
  await tab('知识库').click();
  await page.getByPlaceholder(/搜索工具关键词/).fill('挣值');
  const teachBtn = page.getByRole('button', { name: '教学', exact: true }).first();   // R6.8 图标化后去 🎓；exact 防误命中矩阵「无教学记录」
  await teachBtn.waitFor({ timeout: 15_000 });                      // 400ms 防抖 + fetch
  await teachBtn.click();
  const tutorCard = page.locator('.card', { hasText: '四步教学 · ' });
  await tutorCard.waitFor();
  await page.getByRole('button', { name: '看懂了 → 用我的真实项目演示' }).click();
  const nextBtn = page.getByRole('button', { name: '明白了 → 给我出个实练任务' });
  await nextBtn.waitFor();
  await nextBtn.click();
  const ans = page.getByPlaceholder('按任务要求作答，导师将按 rubric 批改…');
  await ans.waitFor();
  await ans.fill('（验收桩）选用挣值分析：PV/EV/AC 计算 SPI/CPI，与容差比对后决定纠偏与例外上报。');
  await page.getByRole('button', { name: '提交批改' }).click();
  await page.locator('.itto-res').waitFor();
  assert.ok((await page.locator('.itto-res').textContent()).includes('75'), 'mock 判分应为 75');
  assert.ok(await tutorCard.locator('.pill', { hasText: 'M2' }).first().isVisible(), '练成应升 M2 会应用');
});

test('F8 WP1 移动端响应式：375×812 窄屏强化营/成长路径无横向溢出', async () => {
  const mobile = await browser.newPage({ viewport: { width: 375, height: 812 } });   // iPhone 尺寸
  mobile.setDefaultTimeout(20_000);
  try {
    await mobile.goto(WEB);
    // 同库共享 profile（桌面 F1 已跳过初始化）→ 直接进主壳；等 header 即可
    await mobile.locator('header h1').waitFor();
    // 断言器：文档 scrollWidth 不超过视口（无横向溢出）
    const noOverflow = () => mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    // tabs 窄屏为横向滚动容器（靠右 tab 在视口外）：scrollIntoView 再点
    const tabTap = async (label) => {
      const t = mobile.locator('nav.tabs button', { hasText: label });
      await t.scrollIntoViewIfNeeded();
      await t.click();
    };
    // 强化营（手机复习主场景）
    await tabTap('强化营');
    await mobile.locator('.card', { hasText: '今日复习队列' }).first().waitFor();
    await mobile.waitForFunction(() => document.readyState === 'complete');
    assert.ok(await noOverflow(), `强化营 375px 应无横向溢出：scrollWidth=${await mobile.evaluate(() => document.documentElement.scrollWidth)}`);
    // 成长路径（双栏 grid → 单列 + 雷达图窄屏）
    await tabTap('成长路径');
    await mobile.locator('.card', { hasText: '三维合成' }).first().waitFor();
    await mobile.waitForTimeout(600);   // ECharts init 动画
    assert.ok(await noOverflow(), `成长路径 375px 应无横向溢出：scrollWidth=${await mobile.evaluate(() => document.documentElement.scrollWidth)}`);
    // 主壳头 8 tab 横向滚动条可用（自身 overflow-x:auto 不计入 body 溢出）
    assert.equal(await mobile.locator('nav.tabs button').count(), 8, '8 tab 应渲染');
  } finally {
    await mobile.close();
  }
});

// ============ R6.6 AI 面整合：侧栏为唯一 AI 面（流式 + 持久化 + 意图链路） ============

test('F9 R6.6 侧栏流式问答 + 刷新后历史持久化', async () => {
  // 桌面侧栏默认展开（F1 已过初始化）
  const asst = page.locator('.asst');
  await asst.waitFor();
  const input = asst.locator('.asst-bar input');
  await input.fill('什么是关键路径？');
  await input.press('Enter');
  // 流式回显：mock 回复逐字写入（waitFor 阶段断言完整句）
  await until(async () => ((await asst.locator('.asst-m.ai').last().textContent()) ?? '').includes('mock provider'));
  await until(async () => ((await asst.locator('.asst-bar button').textContent()) ?? '') === '发送', 15_000);   // busy 结束
  await until(async () => (await j(`${API}/api/assistant/messages`)).some((m) => m.role === 'ai'), 10_000);      // 落库完成
  // 刷新 → 历史自库载入（持久化锚）
  await page.reload();
  await page.locator('header h1').waitFor();
  await page.locator('.asst').waitFor();
  await page.locator('.asst-m.me', { hasText: '什么是关键路径？' }).waitFor({ timeout: 10_000 });
  assert.ok(await page.locator('.asst-m', { hasText: 'mock provider' }).count() >= 1, '刷新后 ai 回复应保留');
});

test('F10 R6.6 侧栏意图链路：登记风险计划→执行 + 清空双确认', async () => {
  // 造项目（parse 无 pageContext 项目时以「最新项目」解析 project_id）
  const proj = await j(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '整合验收桩项目' }),
  });
  const asst = page.locator('.asst');
  const input = asst.locator('.asst-bar input');
  await input.fill('登记风险：核心工程师离职');
  await input.press('Enter');
  const plan = asst.locator('.asst-plan');
  await plan.waitFor();
  assert.ok((await plan.textContent()).includes('核心工程师离职'), '计划卡应含风险标题（mock 意图分支）');
  await plan.getByRole('button', { name: '确认执行' }).click();
  await asst.locator('.asst-note.ok').first().waitFor();   // 已执行 ✓
  const risks = await j(`${API}/api/projects/${proj.id}/risks`);
  assert.ok(risks.some((r) => String(r.title).includes('核心工程师离职')), `风险应落库：${JSON.stringify(risks).slice(0, 120)}`);
  // R6.6b 计划卡冻结回放：刷新后重现（已执行态、无操作按钮——令牌不落库）
  await page.reload();
  await page.locator('header h1').waitFor();
  const frozen = page.locator('.asst-plan');
  await frozen.first().waitFor({ timeout: 10_000 });
  const frozenText = (await frozen.first().textContent()) ?? '';
  assert.ok(frozenText.includes('核心工程师离职'), '刷新后计划卡应重现');
  assert.ok(frozenText.includes('已执行'), '冻结卡应含已执行态');
  assert.equal(await frozen.first().getByRole('button', { name: '确认执行' }).count(), 0, '冻结卡不应有操作按钮');
  // 清空双确认：未输入「清空」前禁用 → 输入后可执行 → 库清空 + 页内历史清空
  await asst.locator('.asst-head button', { hasText: '清空' }).click();
  const box = asst.locator('.asst-clearbox');
  await box.waitFor();
  assert.ok(await box.getByRole('button', { name: '确认清空' }).isDisabled(), '未输入「清空」前应禁用');
  await box.locator('input').fill('清空');
  await box.getByRole('button', { name: '确认清空' }).click();
  await until(async () => (await j(`${API}/api/assistant/messages`)).length === 0, 10_000);
  // 页内历史气泡清空：UI 重渲染与库清空跨通道，轮询等待（断言读早会竞态——取证后定稿）
  await until(async () => (await asst.locator('.asst-m.me').count()) === 0, 5_000);
});

test('F11 R6.6b 未确认计划卡刷新后冻结回放（创建即落库，令牌不落库）', async () => {
  await j(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '冻结回放桩项目' }),
  });
  const asst = page.locator('.asst');
  const input = asst.locator('.asst-bar input');
  await input.fill('登记风险：冻结回放桩风险');
  await input.press('Enter');
  await asst.locator('.asst-plan').waitFor();
  // 不执行直接刷新：pending 卡以冻结态回放（无操作按钮 + 未确认标注）
  await page.reload();
  await page.locator('.asst').waitFor();
  const plan = page.locator('.asst-plan').first();
  await plan.waitFor({ timeout: 10_000 });
  const text = (await plan.textContent()) ?? '';
  assert.ok(text.includes('冻结回放桩风险'), '未确认计划卡应重现');
  assert.ok(text.includes('未确认'), '应标注未确认（刷新后令牌失效）');
  assert.equal(await plan.getByRole('button', { name: '确认执行' }).count(), 0, '冻结卡不应有操作按钮');
});

// ============ R6.7 科技风重构：双主题令牌系统 ============

test('F12 R6.7 主题切换：默认深色 → 切换亮色生效且刷新保持', async () => {
  const html = page.locator('html');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // body 底色有 .25s 过渡：断言须轮询到过渡落定（属性切换即读 computed 会拿过渡起点值）
  const isDarkBg = async () => parseInt((await bg()).slice(4), 10) < 60;
  const isLightBg = async () => parseInt((await bg()).slice(4), 10) >= 200;
  const themeBtn = page.locator('.theme-btn');
  await themeBtn.waitFor();
  // headless 视口与系统偏好无关：先归一到深色再测（显式点击仅当不在 dark）
  if ((await html.getAttribute('data-theme')) !== 'dark') await themeBtn.click();
  await until(async () => (await html.getAttribute('data-theme')) === 'dark');
  await until(isDarkBg);
  const darkBg = await bg();
  assert.ok(darkBg.startsWith('rgb'), `深色主题 body 底色应为冷暗色：${darkBg}`);
  // 切换亮色：变量生效（底色变亮）+ localStorage 持久化
  await themeBtn.click();
  await until(async () => (await html.getAttribute('data-theme')) === 'light');
  await until(isLightBg);
  const lightBg = await bg();
  assert.notEqual(lightBg, darkBg, '主题切换应改变 body 底色');
  assert.equal(await page.evaluate(() => localStorage.getItem('pm-theme')), 'light', '选择应持久化');
  // 刷新后保持亮色（初始化脚本先于渲染读取偏好）
  await page.reload();
  await page.locator('header h1').waitFor();
  assert.equal(await html.getAttribute('data-theme'), 'light', '刷新应保持亮色主题');
  // 切回深色并清偏好（还原 e2e 浏览器现场，后续用例不受影响）
  await page.locator('.theme-btn').click();
  await until(async () => (await html.getAttribute('data-theme')) === 'dark');
});
