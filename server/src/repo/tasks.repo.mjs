// 训练任务数据访问：training_tasks 列表与状态流转
import { db } from '../db.mjs';

export const listTrainingTasks = () => db.prepare('SELECT * FROM training_tasks ORDER BY status, id DESC LIMIT 20').all();

export const updateTrainingTaskStatus = (id, status) =>
  db.prepare('UPDATE training_tasks SET status=? WHERE id=?').run(status, id);