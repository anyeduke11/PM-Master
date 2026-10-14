// 健康自检数据访问：sqlite_master 表数量探针
import { db } from '../db.mjs';

export const tableCount = () => db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;