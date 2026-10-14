// 定时任务调度（AI native：agent 主动工作；R3.2 加固：注册表统一 cron，调度循环遍历全部 job）
// cron 为简化式「分 时 日 月 周」，支持 * 与具体数字（单用户本地足够；多实例需替换 node-cron）
import { dueSummary } from './drill.mjs';
import { monthlyRecalc, monthlyReport } from './growth.mjs';
import { patrolRun } from './patrol.mjs';
import { deliverReport, notify } from './notify.mjs';
import { badRequest, conflict } from './errors.mjs';

const JOBS = {
  daily_review: {
    cron: '0 9 * * *', label: '每日 09:00 复习提醒',
    // R5.3 C3：到期/逾期数进通知中心（0 张不打扰不落通知）；诚实标注：进程内 job 只在服务运行时的触发点投递
    fn: () => {
      const s = dueSummary();
      if (s.due_today > 0) {
        notify({
          kind: 'info',
          title: s.overdue > 0 ? `复习提醒：今日 ${s.due_today} 张（含逾期 ${s.overdue}）` : `复习提醒：今日 ${s.due_today} 张到期`,
          body: `强化营今日应复习 ${s.due_today} 张${s.overdue > 0 ? `，其中逾期 ${s.overdue} 张` : ''}；未来 7 天还有 ${s.upcoming_total} 张。`,
          payload: { job: 'daily_review', ...s },
        });
      }
      return { due_today: s.due_today, overdue: s.overdue, notified: s.due_today > 0 };
    },
  },
  monthly_recalc: {
    cron: '0 8 1 * *', label: '每月 1 日 08:00 月度重算',
    fn: () => monthlyRecalc(),
  },
  monthly_report: {
    cron: '5 8 1 * *', label: '每月 1 日 08:05 月报生成与推送',
    fn: async () => {
      const { markdown, stats } = monthlyReport();
      const d = await deliverReport({ title: `PM-Master 成长月报 ${new Date().toISOString().slice(0, 10)}`, markdown });
      return { chars: markdown.length, closure_rate: stats.closure_rate, feishu: d.feishu };
    },
  },
  // R7.0 P3 每日巡检（08:00 错开 09:00 复习提醒；同日重跑 upsert 幂等，手动触发与 cron 撞车安全）
  patrol: {
    cron: '0 8 * * *', label: '每日 08:00 项目与成长巡检',
    fn: () => patrolRun(),
  },
};

function cronMatch(expr, d) {
  const [mi, ho, dom, mo, dow] = String(expr).split(/\s+/);
  const hit = (f, v) => f === '*' || Number(f) === v;
  return hit(mi, d.getMinutes()) && hit(ho, d.getHours()) && hit(dom, d.getDate())
    && hit(mo, d.getMonth() + 1) && hit(dow, d.getDay());
}

const jobState = {};          // {job: {cron,label,last_run,last_result,last_error}}
const running = new Set();

// 执行单个 job：记录 last_run/last_result；失败落 error 通知后抛回（调用方决定如何暴露，不静默）
export async function runJob(name) {
  const j = JOBS[name];
  if (!j) throw badRequest(`unknown job: ${name}`);
  if (running.has(name)) throw conflict(`job 正在执行中：${name}`);
  running.add(name);
  const startedAt = new Date().toISOString();
  try {
    const result = await j.fn();
    jobState[name] = { cron: j.cron, label: j.label, last_run: startedAt, last_result: 'ok', last_error: null };
    return { job: name, cron: j.cron, label: j.label, result };
  } catch (e) {
    const message = String(e?.message ?? e);
    notify({ kind: 'error', title: `定时任务失败：${j.label}`, body: message, payload: { job: name } });
    jobState[name] = { cron: j.cron, label: j.label, last_run: startedAt, last_result: 'error', last_error: message };
    throw e;
  } finally {
    running.delete(name);
  }
}

export function register(app) {
  app.get('/api/v2/scheduler', async () =>
    Object.fromEntries(Object.entries(JOBS).map(([k, j]) => [k, { cron: j.cron, label: j.label, ...(jobState[k] ?? {}) }])));
  app.post('/api/v2/scheduler/run/:job', async (req) => runJob(req.params.job));
}

// 进程内调度：每分钟检查全部 job（命中 cron 且本分钟未执行过 → 触发）
setInterval(() => {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16);
  for (const [name, j] of Object.entries(JOBS)) {
    if (!cronMatch(j.cron, now)) continue;
    if (jobState[name]?.last_run?.slice(0, 16) === stamp) continue;   // 同分钟防重
    runJob(name).catch((e) => console.warn(`[scheduler] ${name} 失败：${e.message}`));
  }
}, 60_000).unref();