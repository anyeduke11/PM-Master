// R2.3 成长闭环链：差距(gap) → 训练信号(trained) → 月度重算分数达标后闭环(closed)
// 训练信号来源：教练归档(指标)/强化营判分(知识域)/ITTO 实操(知识域)——闭环状态流转是纯代码
import { db, getProfile } from './db.mjs';
import { loadStandard } from './standard.mjs';

// ---------- 训练信号：训练发生 → 命中 open 链接置 trained（记 score_before 快照） ----------
export function markTrained({ indicator, domain, evidenceId }) {
  const now = new Date().toISOString();
  const row = indicator
    ? db.prepare(`SELECT id FROM growth_links WHERE indicator=? AND status='open' ORDER BY id LIMIT 1`).get(indicator)
    : db.prepare(`SELECT id FROM growth_links WHERE domain=? AND status='open' ORDER BY id LIMIT 1`).get(domain);
  if (!row) return 0;
  db.prepare(`UPDATE growth_links SET status='trained', trained_at=?, evidence_id=? WHERE id=?`)
    .run(now, evidenceId ?? null, row.id);
  return 1;
}

// ---------- 月度重算联动：建新差距链接 + 关闭达标链接 ----------
export function syncLinks(scores) {
  const p = getProfile();
  let created = 0;
  // 素质差距：目标级要求项 score<0.7 → 建 coach 链接（同类 open 不重复）
  for (const [id, v] of Object.entries(scores.cDetails)) {
    if (!v.required || v.score >= 0.7) continue;
    const dup = db.prepare(`SELECT id FROM growth_links WHERE indicator=? AND status IN ('open','trained')`).get(id);
    if (!dup) {
      db.prepare(`INSERT INTO growth_links (indicator, gap_type, train_type, score_before) VALUES (?,?,?,?)`)
        .run(id, 'competency', 'coach', v.score);
      created += 1;
    }
  }
  // 知识差距：域分<0.7 → 建 itto 链接
  for (const [dom, score] of Object.entries(scores.kDetails)) {
    if (score >= 0.7) continue;
    const dup = db.prepare(`SELECT id FROM growth_links WHERE domain=? AND status IN ('open','trained')`).get(dom);
    if (!dup) {
      db.prepare(`INSERT INTO growth_links (domain, gap_type, train_type, score_before) VALUES (?,?,?,?)`)
        .run(dom, 'knowledge', 'itto', score);
      created += 1;
    }
  }
  // 关闭：trained 链接的指标/域当期分数 ≥0.7 → closed（写 score_after）
  let closed = 0;
  for (const l of db.prepare(`SELECT * FROM growth_links WHERE status='trained'`).all()) {
    const cur = l.indicator ? scores.cDetails[l.indicator]?.score : scores.kDetails[l.domain];
    if (cur != null && cur >= 0.7) {
      db.prepare(`UPDATE growth_links SET status='closed', score_after=?, closed_at=? WHERE id=?`)
        .run(cur, new Date().toISOString(), l.id);
      closed += 1;
    }
  }
  return { created, closed };
}

// R3.5：PMBOK 中文知识域 → 国标 17 域 key（映射读 indicator-training-map.yaml，零硬编码；未命中返回 null）
export function kaToDomain(ka) {
  return loadStandard('indicator-training-map').pmbok_ka_domain?.[String(ka ?? '').trim()] ?? null;
}

// ---------- 闭环率统计 + 明细 ----------
export function linkStats() {
  const by = {};
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM growth_links GROUP BY status').all()) by[r.status] = r.c;
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const closed = by.closed ?? 0;
  const comps = loadStandard('gbt41831').competencies;
  const items = db.prepare('SELECT * FROM growth_links ORDER BY id DESC LIMIT 30').all();
  return {
    total, open: by.open ?? 0, trained: by.trained ?? 0, closed,
    closure_rate: total ? +(closed / total).toFixed(2) : null,
    items: items.map((l) => ({
      ...l,
      label: l.indicator ? (comps[l.indicator]?.name ?? l.indicator) : l.domain,
      delta: l.score_before != null && l.score_after != null ? +(l.score_after - l.score_before).toFixed(2) : null,
    })),
  };
}
