# 记忆分层分级 · 结构设计与架构设计（v1.5）

> 目标：把 **AI 教练助手**（统一角色，教练角色即 AI 助手，见 [PRD.md](../PRD.md) §15）的「记忆」从当前**扁平单表 top-5 注入**升级为**分层分级、场景感知、权限受控、可复利**的能力，让记忆更好辅助项目经理成长。
> 本文档为**设计契约**（先设计、再复用、后增强）。实施分阶段见 §9；权威口径以 [PRD.md](../PRD.md) 为准，本文件是其落地细化。

---

## 1. 现状（as-is）

`memories` 表（[db.mjs](../server/src/db.mjs#L350-L358)）：

```
memories(id, kind[note|coach|chat], content≤300, source, pinned, created_at, updated_at)
```

| 环节 | 现状 | 位置 |
|---|---|---|
| 写入·手动 | `addMemory`（设置 F 区） | [memory.mjs](../server/src/memory.mjs#L17-L26) |
| 写入·教练归档 | `extractFromSession` → `addMemory(kind=coach)` | [memory.mjs](../server/src/memory.mjs#L48-L61) |
| 注入 | `ORDER BY pinned DESC, id DESC LIMIT 5`（**扁平、无域/场景过滤**） | [agent.mjs](../server/src/agent.mjs#L66-L70) |
| 透明化 | `contextPreview` | [memory.mjs](../server/src/memory.mjs#L85-L99) |
| 开关 | `persona.memory_on` | [settings.mjs](../server/src/settings.mjs#L30) |

**问题**：无归属域、无时效、无分级（仅 `pinned` 二元）、无场景过滤、无生命周期（不晋升/不衰减/不过期）→「记了很多无关的」与「该记的没记」并存；注入 token 随记忆增长而失控。

---

## 2. 分层分级模型（to-be）

### 2.1 四维度

| 维度 | 字段 | 取值 | 作用 |
|---|---|---|---|
| 归属域 | `scope` | `user` / `project` | 域隔离 + 权限门控 |
| 时效 | `horizon` | `long` / `short` | 长期沉淀 vs 工作记忆（可 TTL） |
| 分级 | `level` | `1`核心 / `2`重要 / `3`一般 | 检索优先级 + 衰减权重 |
| 分类 | `category` | `identity`/`style`/`preference`/`goal`/`weakness`/`fact`/`decision`/`risk`/`stakeholder`/`task` … | 内容分类（受控词表，规则/提取器产出） |

- `kind` **保留为来源类型**（note/coach/chat/project），与 `category`（内容分类）正交：
  - `kind` 回答「从哪来」，`category` 回答「是什么」。
- `scope=project` 必须带 `project_id`；`scope=user` 时 `project_id` 为 `NULL`。

### 2.2 组合矩阵

| | `long` 长期 | `short` 短期 |
|---|---|---|
| **`user`** | 身份·称呼·风格·偏好·长期目标·能力弱项 | 当前会话目标、临时困扰 |
| **`project`** | 项目决策、关键干系人、风险模式、领域事实 | 当前任务上下文、待办、临时结论 |

---

## 3. 表结构迁移（向后兼容，遵循既有幂等惯例）

沿用 [db.mjs](../server/src/db.mjs#L378-L391) 的 `try{ db.exec('ALTER TABLE …') }catch{ /* 已存在 */ }` 惯例逐列补齐：

```sql
-- 逐列 ALTER（缺失才加，幂等）
ALTER TABLE memories ADD COLUMN scope      TEXT    NOT NULL DEFAULT 'user';
ALTER TABLE memories ADD COLUMN horizon    TEXT    NOT NULL DEFAULT 'long';
ALTER TABLE memories ADD COLUMN level      INTEGER NOT NULL DEFAULT 2;
ALTER TABLE memories ADD COLUMN category   TEXT    NOT NULL DEFAULT 'fact';
ALTER TABLE memories ADD COLUMN project_id INTEGER;
ALTER TABLE memories ADD COLUMN expires_at TEXT;                       -- short 记忆 TTL（NULL=不过期）
ALTER TABLE memories ADD COLUMN hits       INTEGER NOT NULL DEFAULT 0; -- 注入命中次数（晋升/复利依据）
ALTER TABLE memories ADD COLUMN last_hit   TEXT;

CREATE INDEX IF NOT EXISTS idx_mem_scope
  ON memories(scope, project_id, horizon, level DESC, pinned DESC, id DESC);
```

- **旧行回填**：`ALTER … DEFAULT` 已把存量行填为 `user/long/2/fact`，无需数据搬迁。
- **唯一性**：现有唯一性在**代码层**（`SELECT id FROM memories WHERE content=?`）。迁移后改为 `UNIQUE(scope, project_id, content)` 语义——同内容不同域可共存。
- SQLite 限制：`ALTER ADD COLUMN` 不能直接加 `UNIQUE`，唯一性继续由代码保证（与现状一致）。

---

## 4. 场景感知检索（权限 + 场景获取）——纯代码

```js
retrieveMemories({ pageContext = {}, scenario = null, budgets = DEFAULT_BUDGETS }) → ranked[]
```

**三个纯代码步骤（零 LLM）：**

1. **域门控（=「权限」）**
   - `scope='user'` 级：始终可注入。
   - `scope='project'` 级：仅当 `pageContext.project_id === m.project_id` 才可注入。
   - 单用户系统不引入多租户 ACL；「权限」即**域可见性门控**（避免过度设计）。

2. **场景过滤（scenario）**
   - 教练场景：按该场景 `indicators/domain` 关联 `category`（如弱项指标→`weakness`）。
   - 对话：按当前 `pageContext.tab` 关联 `category`。

3. **排序 + 预算**
   - 排序：`level DESC, pinned DESC, hits DESC, id DESC`。
   - 过期惰性回收：`horizon='short' AND expires_at < now` 不参与注入。
   - 预算（防注入膨胀，对齐 PRD「上下文约 500 token」）：默认 `user-long ≤4 / project-long ≤3 / short ≤2`，条数与配额可在设置调。

---

## 5. 生命周期 · 知识复利闭环

```
① 产生 ──▶ ② 沉淀 ──▶ ③ 检索注入 ──▶ ④ 复用晋升 ──▶ ⑤ 蒸馏回灌 ──┐
   ▲                                                              │
   └──────────────── 再产生（新会话/新事件）◀──────────────────────┘
```

1. **产生**：手动(`note`) / 教练归档(`coach`) / 对话提取(`chat`，P5) / **项目事件**(`project`：risk·decision·stakeholder 钩子)✅。项目事件实现：`rememberProjectEvent(event, projectId, data)`（[memory.mjs](../server/src/memory.mjs)），在风险登记 / 干系人新增 / 会议纪要（`summary` 非空）三处路由 [`project.routes.mjs`](../server/src/routes/project.routes.mjs) 确定性拼装落 `scope=project / horizon=long / level=2 / kind=project / source=project#<event>`（**决策无独立表，以会议纪要 `summary` 为载体**）。
2. **沉淀**：写入即带 `scope/horizon/level/category`（提取器输出富字段；缺省走规则回退）。
3. **检索注入**✅：组装收敛为纯函数 `memoryBlock({profile, pageContext, scenario, recordHits})`（[memory.mjs](../server/src/memory.mjs)），内部 = `retrieveMemories`（场景/域感知）+ 画像 `summary`；**chat 流式**（`streamOpenAI → buildSystemPrompt`，`recordHits:true`）、**教练**（`coachChat`，`recordHits:true`）、**助手意图**（`assistantChat`，`recordHits:false`——高频路径防 hits 通胀）三条 LLM 路径统一复用。场景偏好由 [coach.mjs](../server/src/coach.mjs) 的 `SCENARIO_MEMORY_CATEGORIES`（scenario id → 记忆分类确定性映射）经 `getScenario().categories` 供给。**E 会话评定 `ratingChat` 刻意不注入**（评定须以会话内证据为准，防记忆污染评定）。
4. **复用晋升（复利核心，纯代码）**✅：短期记忆被注入且被后续会话引用 → `hits++`、`last_hit=now`；`hits ≥ 阈值`（`PROMOTE_HITS=3`）→ **晋升为 `long`**（并清 `expires_at`）。实现：`markInjected(ids)` + `promoteMemories()`（[memory.mjs](../server/src/memory.mjs)）。
5. **蒸馏回灌**✅：`long` 记忆 → `distillProfile` → `profile.summary` → 再注入，形成更高层抽象。蒸馏源 = `evidence`（一次性证据）+ `profileMemoryDigest()`（**分层长期记忆**：仅 `scope=user AND horizon=long`，按 `level ASC`/`hits DESC`，排除短期避免任务细节污染画像）；`profileDistillChat` 增 `memories` 入参，提示词优先以长期记忆为据。

**衰减**✅：`short` 到期惰性回收；`long` 长期未命中降 `level`（`decayMemories()`，`DECAY_IDLE_DAYS=90`，3 为下限不再降）。**自动触发**：`runMemoryMaintenance()`（晋升 + 衰减）挂载在真实 LLM 注入路径（`memoryBlock(..., {recordHits:true})`：chat 流式 + 教练会话），无调度器依赖。

**复利指标（可视化）**✅：记忆量分层分布、命中晋升数、**注入占比**（`contextPreview().injection`：画像+记忆块 / system prompt 篇幅）→ `contextPreview` 与设置中心 H 区 KPI。

---

## 6. 能力映射（复用 vs 新增）

| 能力 | 现状 | 动作 |
|---|---|---|
| 手动记忆 CRUD | ✅ | **复用**，扩展字段 |
| 教练归档提取 | ✅ `extractFromSession` | **复用**；提取器输出富字段后落列 |
| 画像蒸馏 | ✅ `distillProfile` | **已交付**（检索源改分层：`profileMemoryDigest()` 纳入 `user+long` 记忆，随 v5.17.7） |
| 上下文注入 | ✅ `memoryBlock` | **已交付**（组装收敛 `memoryBlock`，chat/教练/助手三路复用；替代 flat `LIMIT 5`，随 v5.17.7） |
| 上下文预览 | ✅ `contextPreview` | **扩展**分层视图 |
| 设置开关 | ✅ `persona.memory_on` | **新增**子配额（`memory.*`） |
| 项目级记忆钩子 | ✅ | **已交付**（`rememberProjectEvent`：risk / stakeholder / decision 三处项目事件路由确定性落 project 域记忆） |
| 晋升 / 衰减 | ✅ | **已交付**（纯代码规则：`markInjected` / `promoteMemories` / `decayMemories` / `runMemoryMaintenance`） |

---

## 7. API 增量（保持 `/api/v2` 前缀）

- ✅（P2）`GET /api/v2/settings/memories?scope=&horizon=&project_id=&category=&level=`——`listMemories` 支持四维度筛选透传（P4 设置区 UI 消费）。
- `POST / PUT /api/v2/settings/memories`：接受新字段（缺失走默认）。
- `GET /api/v2/context/preview`：新增 `layered` 分层视图 + 复利指标。
- ✅（P2）`POST /api/v2/memories/maintenance`——手动/观测触发晋升 + 衰减（`runMemoryMaintenance`）；**常规路径为自动触发**（真实 LLM 注入时内部调用，无独立调度器）。
- ✅（P2）`GET /api/v2/context/preview`：`layered` 新增 `promotable`（short 命中达阈值但尚未晋升计数）。
- ✅（P2）项目事件钩子 `rememberProjectEvent`（[memory.mjs](../server/src/memory.mjs)）——非独立 HTTP 端点，挂载于既有项目事件路由（`POST .../risks`、`POST .../stakeholders`、`POST .../meetings`），fail-soft 不反噬事件主流程。
- ✅（P3′）`GET /api/v2/context/preview`：新增 `injection`（`{block_chars, prompt_chars, ratio}`）——③ 注入组装透明化（画像+记忆块占 system prompt 篇幅）。
- ✅（P3′）`POST /api/v2/profile/distill`：蒸馏源扩展——`distillProfile` 内部纳入 `profileMemoryDigest()`（分层长期记忆），端点签名不变。

---

## 8. 与 AI 教练助手 UI 的衔接（统一角色）

> 本文档中「助手」与「教练」指**同一角色「AI 教练助手」**的两个能力面（助手面〔执行·问答〕/ 教练面〔演练·辅导〕，见 [PRD.md](../PRD.md) §15.0）；记忆层对两面**统一供给**，不区分归属。

- **默认收缩 + FAB 浮框**（复用 `suggest` 信号）为**独立交付**，与记忆分层互不依赖（见 §9 P3）。
- 浮框点击 → 展开侧栏并携带 `pageContext`（含 `project_id`）→ 第 ③ 步检索即按**项目域**注入 → 闭环的检索入口即页面上下文。

---

## 9. 分阶段实施

| 阶段 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **P0** | 本设计文档 | — | ✅ 已交付（v1.0） |
| **P1** | schema 迁移 + `memory.mjs` 分层 CRUD + `retrieveMemories` + `buildSystemPrompt` 改造 + `contextPreview` 扩展（**复用为主**） | P0 | ✅ 已交付（随 v5.17.4 R7.1） |
| **P2** | 短期晋升/衰减规则 + 复利指标 + 项目事件→项目级记忆钩子 | P1 | ✅ 已交付（晋升/衰减随 v5.17.5；**项目事件钩子随 v5.17.6 R7.1**：`rememberProjectEvent` 接入 risk / stakeholder / decision 三处项目事件路由） |
| **P3** | 助手 UI：默认收缩 + FAB 浮框（复用 `suggest`） | 无（可与 P1 并行） | ✅ 已交付（随 v5.17.4 R7.1） |
| **P4** | 设置 F 区记忆分层查看/筛选 UI + PRD 同步 | P1 | ✅ 已交付（随 v5.17.6 R7.1：设置中心「记忆与上下文」区 4 维筛选 + 分层徽标 + 复利指标 KPI + 手动维护按钮） |
| **P3′** | ③ 检索注入**补齐**（教练/助手路径接入 + `SCENARIO_MEMORY_CATEGORIES` 场景偏好）+ ⑤ 画像蒸馏纳入分层长期记忆 + 注入占比观测（**与上表 P3「助手 UI」同名不同义**——按对话上下文，用户所指「P3」为此项） | P1 | ✅ 已交付（随 v5.17.7 R7.1：`memoryBlock` 抽取复用 + `profileMemoryDigest` + `contextPreview().injection`） |

---

## 10. 风险与取舍

- **迁移安全**：逐列幂等 `ALTER`，旧行靠 `DEFAULT` 回填；唯一性沿用代码层校验。
- **注入预算**：分层配额上限，防止记忆增长导致上下文膨胀。
- **「权限」边界**：单用户系统下定义为**域/场景门控**，不引入多租户复杂度。
- **零等级硬编码**：记忆不携带等级内容；等级仅影响注入深度（由 `standard/gbt41831.yaml` 派生）。
- **规则/判断分离**：检索·晋升·衰减·去重·预览 = 纯代码；提取·分类·蒸馏 = `agent.mjs` `callJSON`。

---

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-13 | 首版：四维度分层模型、迁移脚本、场景感知检索、复利闭环、能力映射、分阶段实施 |
| v1.1 | 2026-10-13 | 标注 §9 P1 / P3 已交付（随 PRD v5.17.4 R7.1）；P2 / P4 待批准/待实施；加「状态」列 |
| v1.2 | 2026-10-13 | 标注 P2 **晋升/衰减**已交付（随 PRD v5.17.5 R7.1）：§5 复利闭环 ④ 与衰减段标 ✅ 并补自动触发说明；§6 能力映射「晋升/衰减」行 ❌→✅；§7 增量改为实际落地的 `POST /api/v2/memories/maintenance` + `layered.promotable`；§9 P2 行状态更新（**仅晋升/衰减，项目事件钩子未实施**） |
| v1.3 | 2026-10-13 | P2 **项目事件钩子**与 P4 **设置区记忆分层 UI** 交付（随 PRD v5.17.6 R7.1）：§5 复利闭环 ① 标 ✅ 并补 `rememberProjectEvent` 实现与「决策以会议纪要 summary 为载体」校准注；§6 能力映射「项目级记忆钩子」❌→✅；§7 增量补 `rememberProjectEvent` 与 `listMemories` 筛选透传；§9 P2 / P4 行状态更新为 ✅ |
| v1.4 | 2026-10-13 | **P3′（③检索注入补齐 + ⑤蒸馏回灌分层源）** 交付（随 PRD v5.17.7 R7.1）：§5 ③ 标 ✅（`memoryBlock` 收敛 + chat/教练/助手三路复用 + `ratingChat` 刻意不注入校准注）、⑤ 标 ✅（`profileMemoryDigest` 分层源）；§6「画像蒸馏」「上下文注入」两行 → ✅；§7 增 `contextPreview().injection` 与 distill 源扩展两条；§9 新增 **P3′** 行并显式标注与「助手 UI P3」同名不同义 |
| v1.5 | 2026-10-13 | **角色统一对齐**（随 PRD v5.18.0「教练角色即 AI 助手」）：首句「AI 助手」→「**AI 教练助手**（统一角色）」，加 [PRD.md](../PRD.md) §15 锚点；§8 标题「与助手 UI 的衔接」→「与 AI 教练助手 UI 的衔接（统一角色）」并加注「助手/教练 = 同一角色两能力面，记忆层统一供给」。**纯文档对齐，无实现变更** |