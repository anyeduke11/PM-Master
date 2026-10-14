// R7.0 P3 每日巡检：七扫描器（纯代码聚合读现有表）→ findings → LLM digest（失败降级模板）→ 通知
// 规则/判断分离：扫描判定全部代码；LLM 只把 findings 写成一段优先级叙述。同日 upsert 幂等（手动与 cron 撞车安全）。
// action 路由白名单（前端按 route 分发，不经 LLM）：coach:<scenario> | tab:<tabKey>
import { db } from './db.mjs';
import { patrolDigestChat } from './agent.mjs';
import { dueSummary } from './drill.mjs';
import { linkStats } from './growth-links.mjs';
import { notify } from './notify.mjs';
import { cfg } from './settings.mjs';
import { loadStandard } from './standard.mjs';

const HIGH_POWER = Number(loadStandard('indicator-training-map').workbench?.high_power_threshold ?? 7);
// 本地日期（库内 datetime 为 localtime；toISOString 是 UTC，早 8 点前会错日——不用）
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- 扫描器（每个返回 findings 数组；severity: high|mid|low） ----------
function scanTolerance() {
  return db.prepare(`SELECT a.id, a.project_id, p.name project_name, a.dimension, a.message
                     FROM alerts a JOIN projects p ON p.id=a.project_id WHERE a.status='open'`).all()
    .map((a) => ({
      type: 'tolerance', severity: 'high', project_id: a.project_id,
      title: `${a.project_name} · ${a.dimension} 维超容差`, detail: a.message,
      action: { label: '进入例外教练', route: 'coach:exception' },
    }));
}

function scanRisks() {
  const high = db.prepare(`SELECT r.id, r.project_id, p.name project_name, r.title, r.probability, r.impact
                           FROM risks r JOIN projects p ON p.id=r.project_id
                           WHERE r.status='open' AND r.is_issue=0 AND r.probability*r.impact >= 0.35`).all();
  const stale = db.prepare(`SELECT r.id, r.project_id, p.name project_name, r.title, r.created_at
                            FROM risks r JOIN projects p ON p.id=r.project_id
                            WHERE r.status='open' AND r.is_issue=0 AND r.probability*r.impact < 0.35
                              AND r.created_at <= datetime('now','-14 day')`).all();
  return [
    ...high.map((r) => ({
      type: 'risk', severity: 'high', project_id: r.project_id,
      title: `高危风险：${r.title}`, detail: `P ${r.probability} × I ${r.impact} ≥ 0.35（${r.project_name}）`,
      action: { label: '风险决策教练', route: 'coach:risk_dec' },
    })),
    ...stale.map((r) => ({
      type: 'risk_stale', severity: 'mid', project_id: r.project_id,
      title: `风险超 14 天未处置：${r.title}`, detail: `登记于 ${r.created_at?.slice(0, 10)}（${r.project_name}），建议复评或转问题`,
      action: { label: '查看风险登记', route: 'tab:work' },
    })),
  ];
}

function scanStakeholders() {
  return db.prepare(`SELECT s.id, s.project_id, p.name project_name, s.name, s.power, s.current_engagement, s.desired_engagement
                     FROM stakeholders s JOIN projects p ON p.id=s.project_id
                     WHERE s.power >= ? AND s.current_engagement IS NOT NULL AND s.desired_engagement IS NOT NULL
                       AND s.current_engagement <> s.desired_engagement`).all(HIGH_POWER)
    .map((s) => ({
      type: 'stakeholder', severity: 'mid', project_id: s.project_id,
      title: `高权力干系人参与度缺口：${s.name}`, detail: `${s.project_name}：${s.current_engagement} → 期望 ${s.desired_engagement}（权力 ${s.power}/10）`,
      action: { label: '干系人博弈训练', route: 'coach:stakeholder_game' },
    }));
}

function scanGrowth() {
  const out = [];
  const due = dueSummary();
  if (due.due_today >= 10) out.push({
    type: 'drill', severity: 'mid',
    title: `复习积压 ${due.due_today} 张${due.overdue ? `（含逾期 ${due.overdue}）` : ''}`, detail: `未来 7 天还有 ${due.upcoming_total} 张；建议今日清空到期`,
    action: { label: '进入强化营', route: 'tab:drill' },
  });
  const links = linkStats();
  if (links.open >= 5) out.push({
    type: 'gap', severity: 'mid',
    title: `开放成长差距 ${links.open} 项`, detail: `闭环率 ${links.closure_rate == null ? '-' : Math.round(links.closure_rate * 100) + '%'}；差距驱动训练任务在成长路径查看`,
    action: { label: '查看成长路径', route: 'tab:growth' },
  });
  const overdueTasks = db.prepare(`SELECT COUNT(*) c FROM training_tasks WHERE status='open' AND due_date IS NOT NULL AND due_date < ?`).get(today()).c;
  if (overdueTasks > 0) out.push({
    type: 'task_overdue', severity: 'low',
    title: `训练任务逾期 ${overdueTasks} 项`, detail: '成长路径「训练任务」清单中已过期未完成',
    action: { label: '查看训练任务', route: 'tab:growth' },
  });
  return out;
}

function scanDataGap() {
  return db.prepare(`SELECT p.id, p.name,
                     (SELECT MAX(created_at) FROM project_artifacts WHERE project_id=p.id AND type='weekly') last_weekly,
                     (SELECT COUNT(*) FROM risks WHERE project_id=p.id AND status='open') open_risks
                     FROM projects p ORDER BY p.id`).all()
    .flatMap((p) => {
      const out = [];
      const noWeekly = !p.last_weekly || p.last_weekly <= new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
      if (noWeekly) out.push({
        type: 'no_weekly', severity: 'mid', project_id: p.id,
        title: `${p.name} 超 14 天无周报`, detail: p.last_weekly ? `最近周报 ${p.last_weekly.slice(0, 10)}` : '从未生成周报',
        action: { label: '去生成周报', route: 'tab:work' },
      });
      if (p.open_risks === 0) out.push({
        type: 'no_risk', severity: 'low', project_id: p.id,
        title: `${p.name} 风险登记册为空`, detail: '在管项目应持续识别风险（或确认确无风险）',
        action: { label: '登记风险', route: 'tab:work' },
      });
      return out;
    });
}

function scanCoachIdle() {
  const last = db.prepare(`SELECT MAX(started_at) t FROM coach_sessions`).get().t;
  if (last && last > new Date(Date.now() - 30 * 864e5).toISOString()) return [];
  return [{
    type: 'coach_idle', severity: 'low',
    title: last ? '30 天内无教练会话' : '从未进行教练会话',
    detail: '教练会话是素质证据的主要来源，建议本周完成一次 GROW 训练',
    action: { label: '进入演练场', route: 'tab:coach' },
  }];
}

// LLM 用量预警（R7.0 P1 预留键 patrol.usage_warn_errors 的消费方）：当日失败数超阈值 → high
function scanLlmErrors() {
  const threshold = cfg('patrol.usage_warn_errors');
  const n = db.prepare(`SELECT COUNT(*) c FROM llm_calls WHERE ok=0 AND created_at >= ?`).get(today()).c;
  if (n < threshold) return [];
  return [{
    type: 'llm_errors', severity: 'high',
    title: `今日 LLM 调用失败 ${n} 次（阈值 ${threshold}）`,
    detail: '检查设置·LLM 与模型（provider/密钥/限流退避）与可观测性错误明细',
    action: { label: '查看调用观测', route: 'tab:settings' },
  }];
}

// ---------- 全量扫描（findings 按严重度排序） ----------
export function patrolScan() {
  const SEV = { high: 0, mid: 1, low: 2 };
  const findings = [scanTolerance(), scanRisks(), scanStakeholders(), scanGrowth(), scanDataGap(), scanCoachIdle(), scanLlmErrors()]
    .flat().sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const counts = { high: 0, mid: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { findings, counts };
}

// 降级摘要（LLM 失败时的代码模板，信息完整可读）
function templateDigest(counts, findings) {
  if (!findings.length) return '巡检完成：未发现越界、积压或缺口，一切正常。';
  const top = findings.filter((f) => f.severity === 'high').slice(0, 2).map((f) => f.title);
  return `巡检发现 ${findings.length} 项（高危 ${counts.high} / 中 ${counts.mid} / 低 ${counts.low}）`
    + (top.length ? `。优先处理：${top.join('；')}` : '') + '。';
}

// ---------- 巡检执行（job 与手动触发共用；同日 upsert） ----------
export async function patrolRun() {
  const date = today();
  const { findings, counts } = patrolScan();
  let digest = null;
  let llmOk = 0;
  try {
    digest = (await patrolDigestChat({ date, counts, findings: findings.slice(0, 20) })).digest || null;
    llmOk = 1;
  } catch { /* 降级：digest 用模板 */ }
  if (!digest) digest = templateDigest(counts, findings);
  db.prepare(`INSERT INTO patrol_reports (patrol_date, findings, digest, llm_ok) VALUES (?,?,?,?)
              ON CONFLICT(patrol_date) DO UPDATE SET findings=excluded.findings, digest=excluded.digest, llm_ok=excluded.llm_ok, created_at=datetime('now','localtime')`)
    .run(date, JSON.stringify(findings), digest, llmOk);
  // 通知：有发现才投递（0 项静默，不制造噪音）
  let notified = false;
  if (findings.length > 0) {
    notify({
      kind: 'report',
      title: `每日巡检 ${date}：${findings.length} 项发现${counts.high ? `（高危 ${counts.high}）` : ''}`,
      body: digest,
      payload: { job: 'patrol', date, counts },
    });
    notified = true;
  }
  return { date, findings: findings.length, counts, llm_ok: llmOk, notified };
}

// ---------- 简报读取（设置 J 区） ----------
export function patrolReports(limit = 10) {
  const n = Math.max(1, Math.min(60, Number(limit) || 10));
  return db.prepare('SELECT * FROM patrol_reports ORDER BY patrol_date DESC LIMIT ?').all(n)
    .map((r) => ({ ...r, findings: JSON.parse(r.findings ?? '[]'), llm_ok: Boolean(r.llm_ok) }));
}
