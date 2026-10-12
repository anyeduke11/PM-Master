// R7.0 P5 MCP 管理壳（I3）：服务器登记/启停/连通性探测——**v1 有意不做真实协议接入**
// 边界（诚实）：本模块只做台账。check 用 `/usr/bin/which` 查 PATH 中命令是否存在——
// **绝不 spawn 用户登记的命令本身**（任意命令执行面留给真实接入立项，见 PRD R7 记录）。
// 真实 SDK 接入（@modelcontextprotocol/sdk 等）涉及长进程管理与安全评审，单独立项后再消费本表。
import { spawnSync } from 'node:child_process';
import { db } from './db.mjs';
import { badRequest, notFound } from './errors.mjs';

const trimStr = (v, max) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw badRequest(`超长（≤${max}）`);
  return s;
};

export function listMcp() {
  return db.prepare('SELECT * FROM mcp_servers ORDER BY id').all();
}

export function createMcp({ name, command, args, note }) {
  const n = trimStr(name, 40); const c = trimStr(command, 200);
  if (!n) throw badRequest('name 不得为空');
  if (!c) throw badRequest('command 不得为空（服务器可执行名或绝对路径）');
  const r = db.prepare(`INSERT INTO mcp_servers (name, command, args, note) VALUES (?,?,?,?)`)
    .run(n, c, trimStr(args, 300), trimStr(note, 200));
  return { id: Number(r.lastInsertRowid), ok: true };
}

export function updateMcp(id, patch) {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(Number(id));
  if (!row) throw notFound('服务器不存在');
  const next = { ...row };
  if (patch.name !== undefined) { const v = trimStr(patch.name, 40); if (!v) throw badRequest('name 不得为空'); next.name = v; }
  if (patch.command !== undefined) { const v = trimStr(patch.command, 200); if (!v) throw badRequest('command 不得为空'); next.command = v; }
  if (patch.args !== undefined) next.args = trimStr(patch.args, 300);
  if (patch.note !== undefined) next.note = trimStr(patch.note, 200);
  if (patch.enabled !== undefined) {
    if (patch.enabled !== true && patch.enabled !== false) throw badRequest('enabled 须为布尔值');
    next.enabled = patch.enabled ? 1 : 0;
  }
  db.prepare('UPDATE mcp_servers SET name=?, command=?, args=?, note=?, enabled=? WHERE id=?')
    .run(next.name, next.command, next.args, next.note, next.enabled, row.id);
  return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(row.id);
}

export function deleteMcp(id) {
  const r = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(Number(id));
  if (!r.changes) throw notFound('服务器不存在');
  return { ok: true };
}

// 连通性探测（壳级）：命令是否可在 PATH 解析——只 which，不执行
export function checkMcp(id) {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(Number(id));
  if (!row) throw notFound('服务器不存在');
  const r = spawnSync('/usr/bin/which', [row.command], { encoding: 'utf8', timeout: 3000 });
  const found = r.status === 0 ? r.stdout.trim() : null;
  const status = found ? 'available' : 'not_found';
  db.prepare(`UPDATE mcp_servers SET last_status = ?, last_check = datetime('now','localtime') WHERE id = ?`)
    .run(status, row.id);
  // note 列复用存解析路径（信息性，重探测覆盖）
  return { id: row.id, status, path: found ?? null,
    message: found ? `命令存在于 ${found}（协议接入待立项，当前为登记壳）` : `PATH 中未找到 ${row.command}` };
}
