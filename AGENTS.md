# PM-Master 工作台 · Agent 规则

本文件供 AI 编码助手（Claude Code 等）在本仓库工作时遵循。

## 项目定位

单用户、等级无关（L1-L5）的项目经理成长工作台。评级唯一依据是 `standard/gbt41831.yaml`（GB/T 41831-2022 结构化）——**任何等级相关功能禁止硬编码**，必须读 YAML。

产品内嵌的 AI 角色**唯一且统一**：**「AI 教练助手」**（教练角色即 AI 助手）——为用户提供全周期项目管理能力提升支持，含教练面（演练·辅导）与助手面（执行·问答）两个能力面，共享单一身份与入口。角色定义与能力边界见 [PRD.md](./PRD.md) §15、验收标准见 [docs/ACCEPTANCE-SPEC.md](./docs/ACCEPTANCE-SPEC.md)。

## 硬性约束

1. **零等级硬编码**：等级内容（题目深度/场景解锁/经验清单/工作台形态）一律从 standard YAML 或 user_profile 表派生
2. **规则/判断分离**：GROW 推进、EVM、容差比对、SM-2 调度、三维聚合 min 合成是纯代码（workbench/drill/growth.mjs）；LLM 只做内容生成与判定（agent.mjs 结构化 JSON）
3. **LLM 经适配层**：所有模型调用走 agent.mjs（provider：mock/openai）；新增能力优先扩展 callJSON 体系；强/快双模型分池（OPENAI_MODEL / OPENAI_MODEL_FAST），429 按池分级退避
4. **密钥安全**：`.env`/`.env.enc`/`server/data/` 永不入 git；启动必须经 `scripts/with-env.sh`（Keychain 解密注入）；禁止在日志/回复中输出 key
5. **前端约定**：Vite+React，样式用 index.html 内全局 CSS（科技风双主题设计令牌：冷色 dark 默认 + `html[data-theme="light"]`，旧变量名 --paper/--ink/--cin/--navy 等为别名，新样式一律用语义令牌 --surface/--accent/--*-soft；主题偏好 localStorage pm-theme），新页面在 App.jsx 注册 tab

## 常用命令

```bash
cd server && npm run dev          # 服务 :8735（自动处理密钥）
cd web && npm run dev             # 前端 :8736（代理 /api）
cd server && npm run test:acceptance   # 验收回归（单元 + HTTP 边界；功能改动必过）
cd server && npm run test:e2e          # 浏览器渲染回归（自起隔离 server+vite，本机 Chrome）
cd server && npm run secrets -- status   # 密钥状态
node --check <file>               # 语法校验（提交前必过）
```

## 数据口径（勿改动除非对照国标原文）

- 素质指标 **29 项**（环境5+个人10+技术14），"需求、目标与收益"是单一复合指标
- 认知深度三档：know(知道领会) < apply(应用分析) < integrate(整合评价)
- 等级合成：composite = min(K, C, E)（国标短板原则）
- thinking-coach 实际资产为 9 场景×5=45 核心模型（94 库文件不存在，见 PRD 4.7 校准注）

## 已知坑

- node:sqlite 严格模式：SQL 字符串字面量必须单引号（双引号会报 no such column）
- SenseNova 推理模型：思考耗 completion token，max_tokens 需 ≥2000，JSON 输出用 looseJSON 容错
- pm-master 位于 ~/Documents 父级大仓库内，自身用白名单式 .gitignore 隔离；勿向父仓库添加本目录文件

## 修改流程

改 standard YAML（评级口径）需先对照 `GB-T41831-2022_ocr_raw.txt` 或原 PDF 校对；改后跑：
`curl -s localhost:8735/api/v2/standard/requirements/<lv>` 验证装载。功能改动同步更新 PRD.md 版本记录。
