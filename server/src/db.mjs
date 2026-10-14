// PM-Master 数据层：node:sqlite（Node ≥22.5 内置，零原生编译依赖）
// P0 建 PRD 第7节核心表；等级字段只存档案值，代码零等级硬编码（D8）
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

// R3.5 WP8：PM_DB_PATH 可指向独立测试库（验收脚本不触碰真实数据；默认仍为 pm-master.db）
export const db = new DatabaseSync(process.env.PM_DB_PATH || join(DATA_DIR, 'pm-master.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS user_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),          -- 单用户系统
  name TEXT NOT NULL DEFAULT '我',
  current_level INTEGER NOT NULL DEFAULT 4,        -- 档案：当前等级（L1-L5 任意）
  target_level INTEGER NOT NULL DEFAULT 5,
  track TEXT NOT NULL DEFAULT 'project',           -- project | pmo
  summary TEXT,                                    -- 动态上下文注入用摘要
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  complexity TEXT NOT NULL DEFAULT 'normal',       -- normal | complex | program | portfolio
  role TEXT, start_date TEXT, end_date TEXT,
  tolerances TEXT,                                  -- JSON: 六维容差（PRINCE2）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS competency_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  indicator_id TEXT NOT NULL,                       -- 29 指标 id（读 gbt41831.yaml）
  self_score REAL, scenario_score REAL, behavior_score REAL,   -- 三层信号
  evidence_refs TEXT,                               -- JSON: 证据引用
  assessed_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(indicator_id, assessed_at)
);

CREATE TABLE IF NOT EXISTS coach_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario TEXT, mode TEXT DEFAULT 'standard',
  grow_data TEXT,                                   -- JSON: G/R/O/W 会话数据
  mapped_indicators TEXT,                           -- JSON: 本次锻炼指标
  rating TEXT, rating_evidence TEXT,                -- E 阶段评定+依据引用
  artifact_path TEXT, project_id INTEGER,
  started_at TEXT DEFAULT (datetime('now','localtime')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                               -- project|case|training|standard|award
  title TEXT NOT NULL, description TEXT,
  tags TEXT,                                        -- JSON: 多体系打标 CSPM/PMP-PDU/PRINCE2-CPD
  project_id INTEGER, source_session INTEGER,
  occurred_at TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  k_level INTEGER, c_level INTEGER, e_level INTEGER, composite_level INTEGER,  -- min 合成
  gap_report TEXT,                                  -- JSON
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS training_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT, type TEXT, indicator_id TEXT,
  due_date TEXT, status TEXT DEFAULT 'open',
  source TEXT,                                      -- grow-planner | 取证任务 | 月报
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== P2 实战线 =====
CREATE TABLE IF NOT EXISTS project_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  type TEXT NOT NULL,                               -- weekly | report
  title TEXT, content TEXT,                         -- markdown 产物
  evm TEXT,                                         -- JSON: {pv,ev,ac}
  status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS risks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  probability REAL DEFAULT 0.5, impact REAL DEFAULT 0.5,
  strategy TEXT,                                    -- 应对策略（双体系标签）
  second_order TEXT,                                -- JSON: 二阶推演 {first,second,third,question}
  is_issue INTEGER DEFAULT 0,                       -- 风险已发生=问题（PRINCE2 一键转化）
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stakeholders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  power REAL DEFAULT 5, interest REAL DEFAULT 5,    -- PMP 权力/利益方格
  current_engagement TEXT, desired_engagement TEXT, -- 参与度 当前→期望（PMP 参与度矩阵）
  notes TEXT
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT, held_at TEXT, summary TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS action_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL, meeting_id INTEGER,
  title TEXT NOT NULL, owner TEXT, due_date TEXT,
  status TEXT DEFAULT 'open',                       -- open | done（按期完成率→诚信机读分）
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  dimension TEXT NOT NULL,                          -- time | cost | ...
  value REAL, threshold REAL, message TEXT,
  status TEXT DEFAULT 'open',                       -- open | acknowledged | closed
  coach_session_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS experience_stats (       -- 经验硬指标现值（成长记录页进度条数据源）
  key TEXT PRIMARY KEY,
  value REAL,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== P3 闭环 =====
CREATE TABLE IF NOT EXISTS knowledge_cards (        -- 强化营知识卡片（17领域×深度分层）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,                             -- gbt41831.knowledge_domains key
  front TEXT NOT NULL,                              -- 问题面（主动回忆：先问后看）
  back TEXT NOT NULL,                               -- 知识面（国标定义+PMP/PRINCE2 双源）
  sources TEXT,                                     -- JSON: {pmp:[...], prince2:[...]}
  level_tag TEXT,                                   -- 概念层|应用层|整合层（渲染深度）
  interval_days INTEGER DEFAULT 1,                  -- SM-2 lite 间隔
  ease REAL DEFAULT 2.5,                            -- SM-2 难度因子
  reps INTEGER DEFAULT 0,
  next_review TEXT NOT NULL,                        -- 下次复习日
  last_grade TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS drill_records (          -- 情景题作答记录（判分后影响卡片调度）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER,
  domain TEXT,                                      -- R3.1：出题知识域（情景分按指标细分的依据）
  question TEXT, answer TEXT, model_answer TEXT,
  grade TEXT,                                       -- good|ok|weak（LLM 判分）
  depth TEXT,                                       -- know|apply|integrate（随档案等级）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== W4 风险评估专项（三场景：gb20984 / fin_data / pia） =====
CREATE TABLE IF NOT EXISTS ra_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scenario TEXT NOT NULL,                           -- gb20984 | fin_data | pia
  org TEXT, scope TEXT, period TEXT,                -- 被评估方/范围/周期
  phase TEXT DEFAULT 'assets',                      -- prep|assets|analysis|treatment|report|review
  status TEXT DEFAULT 'open',                       -- open | closed
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ra_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT,                                        -- 硬件/软件/数据/人员/服务/文档…
  confidentiality INTEGER DEFAULT 3,                -- CIA 三性赋值 1-5（gb20984）
  integrity INTEGER DEFAULT 3,
  availability INTEGER DEFAULT 3,
  data_level INTEGER,                               -- 数据分级 1-5（fin_data，JR/T 0197）
  owner TEXT, notes TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ra_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  asset_id INTEGER,                                 -- 关联资产（风险链：资产×威胁×脆弱性）
  threat_desc TEXT NOT NULL,
  threat_freq INTEGER DEFAULT 3,                    -- 威胁频率 1-5
  vuln_desc TEXT,
  vuln_sev INTEGER DEFAULT 3,                       -- 脆弱性严重度 1-5
  measures_existing TEXT,                           -- 已有安全措施
  possibility INTEGER, impact INTEGER, risk_value INTEGER,  -- 矩阵法计算结果（代码算）
  risk_level TEXT,                                  -- 低|中|高|严重
  treatment TEXT, owner TEXT, due_date TEXT,        -- 处置：策略/责任/期限
  status TEXT DEFAULT 'open',                       -- open | mitigating | accepted | closed
  extra TEXT,                                       -- JSON：场景差异字段（lifecycle/lawful/consent…）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== R2.2 ITTO 知识库 + 工具实操题（种子来自 itto-data.mjs，幂等装载） =====
CREATE TABLE IF NOT EXISTS itto_processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,                                 -- PMBOK 过程编号（如 4.1），upsert 键
  ka TEXT,                                          -- 知识域（整合/范围/进度…）
  name TEXT
);

CREATE TABLE IF NOT EXISTS itto_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,                                 -- 工具/技术/输入输出条目名，ensure 键
  category TEXT,                                    -- CATEGORY 映射，未命中「通用方法」
  sources TEXT                                      -- 来源标签：pmbok,gbt41831,prince2
);

CREATE TABLE IF NOT EXISTS itto_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id INTEGER,
  tool_id INTEGER,
  kind TEXT                                         -- input | tool | output
);

CREATE TABLE IF NOT EXISTS itto_practice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id INTEGER, tool_id INTEGER,
  question TEXT, context TEXT, answer TEXT,
  score INTEGER, verdict TEXT, comment TEXT,        -- LLM 判分（good≥80 / ok 60-79 / weak<60）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- ===== R2.4 四步教学（W1.2：讲→示→练→用；M 掌握度 v1 口径：练成=M2、费曼合格=M3） =====
CREATE TABLE IF NOT EXISTS itto_tutor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id INTEGER NOT NULL,
  process_id INTEGER,                               -- 教学挂靠过程（可空）
  step TEXT NOT NULL,                               -- 最终到达步骤：explain|demonstrate|practice|apply
  practice_score INTEGER, practice_verdict TEXT,    -- 实练判分（复用 itto 实操题）
  feynman_qualified INTEGER,                        -- 费曼闭环：1=用户讲解获 AI 评合格（M3）
  mastery INTEGER DEFAULT 0,                        -- v1 掌握度：0=仅讲解 1=练成(ok/good) 3=可教授
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- ===== R2.3 成长闭环链（差距→训练→证据→分数变化） =====
CREATE TABLE IF NOT EXISTS growth_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  indicator TEXT,                                   -- 素质指标 id（素质类链接）
  domain TEXT,                                      -- 知识域（知识类链接，train_type=itto）
  gap_type TEXT NOT NULL,                           -- competency | knowledge
  train_type TEXT,                                  -- coach | drill | itto（建议训练方式）
  status TEXT DEFAULT 'open',                       -- open(差距) | trained(已训练) | closed(分数达标)
  score_before REAL, score_after REAL,
  evidence_id INTEGER,                              -- 训练信号来源（证据/记录引用）
  created_at TEXT DEFAULT (datetime('now','localtime')),
  trained_at TEXT, closed_at TEXT
);

-- ===== R3.2 通知中心（月报推送 / 定时任务结果 / 系统事件；kind=error 为失败显式通道） =====
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'info',                -- info | report | error
  title TEXT NOT NULL,
  body TEXT,
  payload TEXT,                                     -- JSON：上下文（如 {job, doc_url}）
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== R4.3 WP8 LLM 调用观测（agent.mjs callJSON/streamChat 插桩；429 退避也落行，限流可见） =====
-- R5.2 WP2：补 token 用量三列（openai usage 解析；mock/pi 无 usage 记 NULL；流式不计）
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,                            -- 调用用途（coach/drill_gen/itto_question/chat/onboard...）
  provider TEXT NOT NULL,                           -- mock | openai | pi
  model TEXT,                                       -- 实际请求模型（mock/pi 为 NULL）
  ok INTEGER DEFAULT 1,                             -- 1 成功 | 0 失败或限流
  ms INTEGER,                                       -- 耗时（含 429 退避等待）
  error TEXT,                                       -- 失败/限流摘要（≤200 字）
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== R6.1 C1 使用反馈（R6.3 使用期的数据地基：真实使用中的卡点/建议轻量记录） =====
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                             -- 提交入口：chat | records | coach | drill
  rating INTEGER,                                   -- 1-5（1=很不满 5=很好），可空（纯文字建议）
  tag TEXT,                                         -- 轻分类：bug | 体验 | 建议 | 其他
  content TEXT NOT NULL,                            -- 反馈正文
  status TEXT DEFAULT 'open',                       -- open | resolved（R6.3 评审时逐条处理）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== R6.6 助手对话日志（AI 面整合：侧栏为唯一 AI 面，文本消息跨刷新持久化） =====
CREATE TABLE IF NOT EXISTS assistant_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,                               -- me | ai（白名单校验）
  kind TEXT DEFAULT 'text',                         -- text | result（结果样式回放）
  content TEXT NOT NULL,                            -- 消息正文（≤2000）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== R7.0 P1 设置中心：KV 配置表（白名单键见 settings.mjs；LLM 覆盖项 KV > env） =====
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,                              -- 统一存字符串，读取时按 DEFAULTS 类型转换
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== R7.0 P2 数据流入：导入历史（preview 瞬态不落库，commit 成功/部分成功落一行） =====
CREATE TABLE IF NOT EXISTS import_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                               -- evm | risks | meetings | stakeholders
  source TEXT DEFAULT 'paste',                      -- paste | file（前端读取后均为文本）
  items INTEGER DEFAULT 0,                          -- 成功入库行数
  skipped INTEGER DEFAULT 0,                        -- 校验失败/重复跳过行数
  status TEXT DEFAULT 'ok',                         -- ok | partial
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== R7.0 P3 每日巡检简报（同日 upsert 幂等；findings 判定纯代码，digest 为 LLM/模板摘要） =====
CREATE TABLE IF NOT EXISTS patrol_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patrol_date TEXT NOT NULL UNIQUE,                 -- YYYY-MM-DD（同日重跑覆盖）
  findings TEXT NOT NULL,                           -- JSON 数组（type/severity/title/detail/action 白名单路由）
  digest TEXT,                                      -- 简报正文（LLM 失败为代码模板）
  llm_ok INTEGER DEFAULT 1,                         -- 0=降级模板（可观测）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== R7.0 P3 提示词库：常用场景固化为快捷提示词（助手侧栏一键填入） =====
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,                              -- ≤30 字（按钮文案）
  content TEXT NOT NULL,                            -- ≤2000 字（填入输入区的完整指令）
  enabled INTEGER DEFAULT 1,                        -- 0=停用（不显示于助手）
  sort INTEGER DEFAULT 0,                           -- 升序展示
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== R7.0 P4 记忆：AI 对用户的工作记忆（蒸馏画像走 user_profile.summary；此处为条目级记忆） =====
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT DEFAULT 'note',                         -- note(用户手记) | coach(教练会话提取) | chat(对话提取，P5)
  content TEXT NOT NULL,                            -- ≤300 字
  source TEXT,                                      -- 来源引用（coach#<id> / manual）
  pinned INTEGER DEFAULT 0,                         -- 1=置顶（注入优先）
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
-- ===== R7.0 P5 MCP 管理壳：仅登记台账（which 探测命令存在性），真实协议接入待立项 =====
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  command TEXT NOT NULL,                            -- 服务器可执行名或绝对路径（v1 不执行）
  args TEXT DEFAULT '',
  note TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  last_status TEXT,                                 -- available | not_found（which 探测结果，非协议连通）
  last_check TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// 初始化一号用户档案（实例数据仅存库，不进代码）
db.prepare(`INSERT OR IGNORE INTO user_profile (id, name, current_level, target_level, track)
            VALUES (1, '我', 4, 5, 'project')`).run();

// P3+ 冷启动：initialized 标记（幂等迁移）
try { db.exec('ALTER TABLE user_profile ADD COLUMN initialized INTEGER DEFAULT 0'); } catch { /* 已存在 */ }
// R2.3：growth_links 训练信号来源引用（幂等迁移）
try { db.exec('ALTER TABLE growth_links ADD COLUMN evidence_id INTEGER'); } catch { /* 已存在 */ }
// R3.1：drill_records 出题知识域（情景分按指标细分的依据；存量记录为 NULL 走全局回退）
try { db.exec('ALTER TABLE drill_records ADD COLUMN domain TEXT'); } catch { /* 已存在 */ }
// R3.3：projects 收益字段（组合视图真实收益；无值回退近似并标注）
try { db.exec('ALTER TABLE projects ADD COLUMN benefit_target REAL'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE projects ADD COLUMN benefit_actual REAL'); } catch { /* 已存在 */ }
// R4.1 WP1：卡片教授证据关联（工具费曼合格沉淀 evidence 后回写同主题卡片；NULL=暂无实证，M 档仍按 SM-2 口径）
try { db.exec('ALTER TABLE knowledge_cards ADD COLUMN evidence_id INTEGER'); } catch { /* 已存在 */ }
// R5.2 WP2：llm_calls token 用量三列（存量库幂等迁移）
try { db.exec('ALTER TABLE llm_calls ADD COLUMN prompt_tokens INTEGER'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE llm_calls ADD COLUMN completion_tokens INTEGER'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE llm_calls ADD COLUMN total_tokens INTEGER'); } catch { /* 已存在 */ }
// R7.1 记忆分层分级：memories 四维度（scope/horizon/level/category）+ 项目域 + 生命周期（expires_at/hits/last_hit）
// 旧行靠 DEFAULT 回填（user/long/2/fact），无数据搬迁；唯一性仍由代码层保证（ADD COLUMN 不能带 UNIQUE）
try { db.exec('ALTER TABLE memories ADD COLUMN scope      TEXT    NOT NULL DEFAULT \'user\''); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE memories ADD COLUMN horizon    TEXT    NOT NULL DEFAULT \'long\''); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE memories ADD COLUMN level      INTEGER NOT NULL DEFAULT 2'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE memories ADD COLUMN category   TEXT    NOT NULL DEFAULT \'fact\''); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE memories ADD COLUMN project_id INTEGER'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE memories ADD COLUMN expires_at TEXT'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE memories ADD COLUMN hits       INTEGER NOT NULL DEFAULT 0'); } catch { /* 已存在 */ }
try { db.exec('ALTER TABLE memories ADD COLUMN last_hit   TEXT'); } catch { /* 已存在 */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope, project_id, horizon, level DESC, pinned DESC, id DESC)');

// ===== R7.0 P1：assistant_prefs 债务清偿——summary 列 PREFS:: hack 一次性迁移至 settings KV =====
// 迁移后 summary 列归还原生语义（动态上下文摘要，P4 蒸馏画像写入）；幂等：无 PREFS:: 前缀即跳过
{
  const p = db.prepare('SELECT summary FROM user_profile WHERE id = 1').get();
  if (p?.summary?.startsWith('PREFS::')) {
    try {
      const prefs = JSON.parse(p.summary.slice(7));
      if (typeof prefs?.suggest_off === 'boolean') {
        db.prepare(`INSERT INTO settings (key, value) VALUES ('assistant.suggest_off', ?)
                    ON CONFLICT(key) DO NOTHING`).run(prefs.suggest_off ? '1' : '0');
      }
    } catch { /* 损坏的 PREFS JSON 直接丢弃（fail loud 由下方清空留痕） */ }
    db.prepare('UPDATE user_profile SET summary = NULL WHERE id = 1').run();
  }
}

export function getProfile() {
  const p = db.prepare('SELECT * FROM user_profile WHERE id = 1').get();
  // R7.0 P1：偏好从 settings KV 组装（保持 API 形状 assistant_prefs 向后兼容）
  const pref = db.prepare(`SELECT value FROM settings WHERE key = 'assistant.suggest_off'`).get();
  return { ...p, assistant_prefs: pref ? { suggest_off: pref.value === '1' } : null };
}
export function updateProfile(patch) {
  const p = getProfile();
  const next = { ...p, ...patch };
  // R7.0 P1：assistant_prefs 走 settings KV（不再占用 summary 列）；null/缺对象=删除偏好记录
  if ('assistant_prefs' in patch) {
    const ap = patch.assistant_prefs;
    if (ap && typeof ap === 'object') {
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('assistant.suggest_off', ?, datetime('now','localtime'))
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(ap.suggest_off ? '1' : '0');
    } else {
      db.prepare(`DELETE FROM settings WHERE key = 'assistant.suggest_off'`).run();
    }
  }
  db.prepare(`UPDATE user_profile SET current_level=?, target_level=?, track=?, summary=?, updated_at=datetime('now','localtime') WHERE id=1`)
    .run(next.current_level, next.target_level, next.track, next.summary ?? null);
  return getProfile();
}
