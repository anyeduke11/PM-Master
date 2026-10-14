// 项目实战线数据访问：projects / benefit / artifacts / risks / stakeholders / meetings / action_items / alerts
import { db } from '../db.mjs';

// ---------- 项目 ----------
export const listProjects = () => db.prepare('SELECT * FROM projects ORDER BY id DESC').all();

export function insertProject(name, complexity, role, startDate, tolerances) {
  const info = db.prepare('INSERT INTO projects (name, complexity, role, start_date, tolerances) VALUES (?,?,?,?,?)')
    .run(name, complexity, role, startDate, tolerances);
  return getProject(info.lastInsertRowid);
}

export const getProject = (id) => db.prepare('SELECT * FROM projects WHERE id=?').get(id);

// R3.3 收益填写（可传 null 清空）
export const updateBenefit = (id, target, actual) =>
  db.prepare('UPDATE projects SET benefit_target=?, benefit_actual=? WHERE id=?').run(target, actual, id);

// ---------- 产物 ----------
export const listArtifacts = (projectId) =>
  db.prepare('SELECT * FROM project_artifacts WHERE project_id=? ORDER BY id DESC').all(projectId);

// ---------- 风险登记册 ----------
export const listRisks = (projectId) =>
  db.prepare('SELECT * FROM risks WHERE project_id=? ORDER BY id DESC').all(projectId);

export function insertRisk(projectId, title, probability, impact, strategy) {
  const info = db.prepare('INSERT INTO risks (project_id, title, probability, impact, strategy) VALUES (?,?,?,?,?)')
    .run(projectId, title, probability, impact, strategy);
  return db.prepare('SELECT * FROM risks WHERE id=?').get(info.lastInsertRowid);
}

// ---------- 干系人 ----------
export const listStakeholders = (projectId) =>
  db.prepare('SELECT * FROM stakeholders WHERE project_id=?').all(projectId);

export function insertStakeholder(projectId, name, power, interest, currentEngagement, desiredEngagement, notes) {
  const info = db.prepare('INSERT INTO stakeholders (project_id, name, power, interest, current_engagement, desired_engagement, notes) VALUES (?,?,?,?,?,?,?)')
    .run(projectId, name, power, interest, currentEngagement, desiredEngagement, notes);
  return db.prepare('SELECT * FROM stakeholders WHERE id=?').get(info.lastInsertRowid);
}

// ---------- 会议 + 行动项 ----------
export const listMeetings = (projectId) =>
  db.prepare('SELECT * FROM meetings WHERE project_id=? ORDER BY id DESC').all(projectId);

export const listActionItems = (projectId) =>
  db.prepare('SELECT * FROM action_items WHERE project_id=? ORDER BY due_date').all(projectId);

export function insertMeeting(projectId, title, heldAt, summary) {
  const info = db.prepare('INSERT INTO meetings (project_id, title, held_at, summary) VALUES (?,?,?,?)')
    .run(projectId, title, heldAt, summary);
  return info.lastInsertRowid;
}

export const insertActionItem = (projectId, meetingId, title, owner, dueDate) =>
  db.prepare('INSERT INTO action_items (project_id, meeting_id, title, owner, due_date) VALUES (?,?,?,?,?)')
    .run(projectId, meetingId, title, owner, dueDate);

export const getMeeting = (id) => db.prepare('SELECT * FROM meetings WHERE id=?').get(id);

// R6.4：SQL 字符串字面量须用单引号（node:sqlite 严格模式双引号会报 no such column）
export const updateActionStatus = (id, status) =>
  db.prepare(`UPDATE action_items SET status=?, completed_at=CASE WHEN ?='done' THEN datetime('now','localtime') ELSE NULL END WHERE id=?`)
    .run(status, status, id);

// ---------- 预警 ----------
export const listOpenAlerts = () =>
  db.prepare(`SELECT a.*, p.name project_name FROM alerts a JOIN projects p ON p.id=a.project_id WHERE a.status='open' ORDER BY a.id DESC`).all();

export const updateAlertStatus = (id, status) =>
  db.prepare('UPDATE alerts SET status=? WHERE id=?').run(status, id);