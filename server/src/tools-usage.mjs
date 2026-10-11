// R7.0 P2 G 工具频率管理：138 个 PMP/ITTO 工具的使用频率聚合（纯代码，零 LLM）
// 数据源：四步教学 itto_tutor + 实操判分 itto_practice（tool 直连）；M 档复用 mastery.mjs 口径。
// 冷门=零使用但过程引用多（proc_count 高=杠杆大）；一键生成训练任务写 training_tasks（幂等）。
import { db } from './db.mjs';
import { toolMasteryLevel, masteryLabel } from './mastery.mjs';
import { badRequest, notFound } from './errors.mjs';

// 工具使用聚合（有过程引用或有过使用记录的工具）
export function toolUsage() {
  const rows = db.prepare(`
    SELECT t.id, t.name, t.category,
      (SELECT COUNT(*) FROM itto_links l WHERE l.tool_id=t.id AND l.kind='tool') proc_count,
      (SELECT COUNT(*) FROM itto_tutor tr WHERE tr.tool_id=t.id) taught,
      (SELECT MAX(mastery) FROM itto_tutor tr WHERE tr.tool_id=t.id) mastery,
      (SELECT COUNT(*) FROM itto_practice p WHERE p.tool_id=t.id AND p.score IS NOT NULL) practiced,
      (SELECT MAX(created_at) FROM itto_tutor tr WHERE tr.tool_id=t.id) last_used
    FROM itto_tools t
    WHERE EXISTS (SELECT 1 FROM itto_links l WHERE l.tool_id=t.id AND l.kind='tool')`).all();
  const items = rows.map((r) => ({
    id: r.id, name: r.name, category: r.category, proc_count: r.proc_count,
    usage: r.taught + r.practiced, taught: r.taught, practiced: r.practiced,
    m: toolMasteryLevel(r.mastery), m_label: masteryLabel(toolMasteryLevel(r.mastery)),
    last_used: r.last_used ?? null,
  }));
  const used = items.filter((x) => x.usage > 0).sort((a, b) => b.usage - a.usage || a.name.localeCompare(b.name));
  const cold = items.filter((x) => x.usage === 0)
    .sort((a, b) => b.proc_count - a.proc_count || a.name.localeCompare(b.name)).slice(0, 10);
  // 常用知识域 top（按过程引用数近似）
  const kaCount = {};
  for (const r of db.prepare(`SELECT p.ka, COUNT(*) c FROM itto_links l JOIN itto_processes p ON p.id=l.process_id WHERE l.kind='tool' GROUP BY p.ka`).all()) kaCount[r.ka] = r.c;
  const topKa = Object.entries(kaCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ka, n]) => ({ ka, n }));
  return {
    total: items.length,
    used_count: used.length,
    coverage: items.length ? +(used.length / items.length).toFixed(3) : null,
    top: used.slice(0, 15),
    cold,                       // 高杠杆冷门（过程引用多但零使用）
    top_ka: topKa,
    note: '使用=四步教学开课+实操判分（tool 直连）；冷门推荐按过程引用数降序（杠杆优先）',
  };
}

// 冷门工具 → 训练任务（幂等：同名 open 不重建）
export function assignToolTask(toolId) {
  const id = Number(toolId);
  const tool = db.prepare('SELECT id, name, category FROM itto_tools WHERE id=?').get(id);
  if (!tool) throw notFound('工具不存在');
  const title = `工具训练：${tool.name}（知识库四步教学 + 实操）`;
  const dup = db.prepare('SELECT id FROM training_tasks WHERE title=? AND status=\'open\'').get(title);
  if (dup) return { task_id: dup.id, existing: true };
  const ka = db.prepare(`SELECT p.ka FROM itto_links l JOIN itto_processes p ON p.id=l.process_id WHERE l.tool_id=? AND l.kind='tool' GROUP BY p.ka ORDER BY COUNT(*) DESC LIMIT 1`).get(id)?.ka ?? null;
  const info = db.prepare('INSERT INTO training_tasks (title, type, indicator_id, source) VALUES (?,?,?,?)')
    .run(title, '知识库训练', ka, '工具频率');
  return { task_id: Number(info.lastInsertRowid), existing: false };
}
