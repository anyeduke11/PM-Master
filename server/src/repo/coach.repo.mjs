// 教练域数据访问：会话列表（含评定摘要）与行为证据流水（雷达数据源）
import { db } from '../db.mjs';

// 会话列表（未关闭可恢复优先；供路由层组装轻量视图）
export const listSessions = () =>
  db.prepare(`SELECT id, scenario, mode, rating, closed_at, started_at, grow_data
              FROM coach_sessions ORDER BY (closed_at IS NULL) DESC, id DESC LIMIT 50`).all();

// 行为证据流水查询（雷达数据源）
export const behaviorScores = () =>
  db.prepare(`SELECT indicator_id, behavior_score, evidence_refs, assessed_at FROM competency_scores WHERE behavior_score IS NOT NULL ORDER BY assessed_at DESC LIMIT 50`).all();