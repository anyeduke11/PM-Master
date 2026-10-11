// R7.0 P1 设置中心配置层：KV 白名单 + 类型校验 + cfg 读取（优先级 KV > env > default）
// 安全边界：API 密钥与 base_url 永不进 KV（只读展示走 env）；本模块只暴露白名单键。
// 循环依赖规避：仅依赖 db.mjs（数据底座）与 errors.mjs（纯函数）。
import { readFileSync } from 'node:fs';
import { db } from './db.mjs';
import { badRequest } from './errors.mjs';

// 白名单：type 驱动校验与转换；env 为默认值来源（脱敏展示时标注来源）；group 供前端分区渲染
export const DEFAULTS = {
  // —— B LLM 与模型（热切换；下次调用生效） ——
  'llm.provider': { group: 'llm', type: 'enum', values: ['mock', 'openai', 'pi'], env: 'AGENT_PROVIDER', default: 'mock', label: '提供方' },
  'llm.model': { group: 'llm', type: 'string', env: 'OPENAI_MODEL', default: 'gpt-4o-mini', label: '强模型', maxLen: 100 },
  'llm.model_fast': { group: 'llm', type: 'string', env: 'OPENAI_MODEL_FAST', default: null, label: '快模型（空=用强模型）', maxLen: 100 },
  'llm.backoff_ms': { group: 'llm', type: 'int', env: 'OPENAI_BACKOFF_MS', default: 65000, min: 0, max: 600000, label: '429 退避（毫秒）' },
  'llm.max_tokens_floor': { group: 'llm', type: 'int', env: 'OPENAI_MAX_TOKENS', default: 2000, min: 500, max: 32000, label: 'max_tokens 下限' },
  'llm.json_mode': { group: 'llm', type: 'bool', env: 'OPENAI_JSON_MODE', default: true, label: 'JSON 输出模式', envInvert: true }, // env '0'=关，其余=开
  'pi.model': { group: 'llm', type: 'string', env: 'PI_MODEL', default: null, label: 'pi 模型（provider=pi 时）', maxLen: 100 },
  // —— E 功能开关（前端消费） ——
  'assistant.suggest_off': { group: 'feature', type: 'bool', default: false, label: '关闭助手主动建议' },
  'ui.notify_poll_s': { group: 'feature', type: 'int', default: 60, min: 10, max: 600, label: '通知轮询间隔（秒）' },
  'ui.default_theme': { group: 'feature', type: 'enum', values: ['dark', 'light'], default: 'dark', label: '默认主题（首次访问）' },
  'ui.reduce_motion': { group: 'feature', type: 'bool', default: false, label: '减少动效' },
  'patrol.usage_warn_errors': { group: 'feature', type: 'int', default: 10, min: 1, max: 100, label: '日用量预警阈值（失败次数，P3 巡检启用）' },
};

const getRaw = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;

// 类型转换（存储串 → 有效值）；非法存储值回退 default（防手改库污染）
function coerce(def, raw) {
  if (raw === undefined || raw === null) return undefined;
  if (def.type === 'int') {
    const n = Number(raw);
    return Number.isFinite(n) && n >= def.min && n <= def.max ? n : undefined;
  }
  if (def.type === 'bool') return raw === '1' || raw === '0' ? raw === '1' : undefined;
  if (def.type === 'enum') return def.values.includes(raw) ? raw : undefined;
  return String(raw);
}

// env 侧默认（含 OPENAI_JSON_MODE '0' 取反等 env 语义）
function envValue(key, def) {
  if (!def.env) return undefined;
  const raw = process.env[def.env];
  if (raw === undefined || raw === '') return undefined;
  if (def.envInvert) return raw !== '0';
  return coerce(def, raw);
}

// 有效值：KV > env > default（agent.mjs 热切换读取入口）
export function cfg(key) {
  const def = DEFAULTS[key];
  if (!def) throw new Error(`未知设置键：${key}`);
  const kv = coerce(def, getRaw(key));
  if (kv !== undefined) return kv;
  const env = envValue(key, def);
  return env !== undefined ? env : def.default;
}

// 全量视图（GET /api/settings）：值 + 来源标注（前端 B/E 区渲染）
export function allSettings() {
  return Object.entries(DEFAULTS).map(([key, def]) => {
    const kv = coerce(def, getRaw(key));
    const env = envValue(key, def);
    return {
      key, group: def.group, type: def.type, label: def.label,
      values: def.values ?? null, min: def.min ?? null, max: def.max ?? null,
      default: def.default, env: def.env ?? null,
      effective: kv !== undefined ? kv : (env !== undefined ? env : def.default),
      source: kv !== undefined ? 'db' : (env !== undefined ? 'env' : 'default'),
    };
  });
}

// 校验并归一化写入值（PUT /api/settings）；非法即 400（fail loud）
// 全类型统一：val=null → 返回 null 表示删除 KV 行（恢复 env/默认）
function validate(def, val) {
  if (val === null) return null;
  if (def.type === 'int') {
    const n = typeof val === 'number' ? val : Number(val);
    if (!Number.isInteger(n) || n < def.min || n > def.max) throw badRequest(`${def.label}须为 ${def.min}-${def.max} 的整数`);
    return String(n);
  }
  if (def.type === 'bool') {
    if (val === true || val === false) return val ? '1' : '0';
    if (val === '1' || val === '0') return val;
    throw badRequest(`${def.label}须为布尔值`);
  }
  if (def.type === 'enum') {
    if (!def.values.includes(val)) throw badRequest(`${def.label}仅接受 ${def.values.join('/')}`);
    return String(val);
  }
  // string：null/''=清除覆盖（回退 env/default）
  if (val === null || val === '') return null;
  const s = String(val).trim();
  if (s.length > (def.maxLen ?? 200)) throw badRequest(`${def.label}超长（≤${def.maxLen ?? 200}）`);
  return s === '' ? null : s;
}

// 批量写入（value=null → 删除 KV 行即恢复 env/默认）；返回最新全量视图
export function setSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('请求体须为 {key: value} 对象');
  const up = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  for (const [key, val] of Object.entries(patch)) {
    const def = DEFAULTS[key];
    if (!def) throw badRequest(`未知设置键：${key}`);
    const s = validate(def, val);
    if (s === null) del.run(key);
    else up.run(key, s);
  }
  return allSettings();
}

// A 区系统状态（脱敏组装：密钥仅布尔、base_url 为用户自有网关可展示）
export function systemCore() {
  return {
    version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    provider: cfg('llm.provider'),
    model: cfg('llm.model'),
    model_fast: cfg('llm.model_fast'),
    base_url: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    key_configured: Boolean(process.env.OPENAI_API_KEY),
    db_tables: db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c,
    node: process.version,
    uptime_s: Math.round(process.uptime()),
  };
}
