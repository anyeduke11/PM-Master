# PM-Master · AI Native 项目经理成长工作台

以 **GB/T 41831-2022《项目管理专业人员能力评价要求》** 为成长坐标的等级无关（L1-L5 全程）单用户系统：真实项目工作为训练场、AI 教练（GROW + 思维模型）全程陪伴。**干活即练级。**

> 完整设计见 [PRD.md](./PRD.md)（含四体系整合：CSPM 骨架 × PMP 方法 × PRINCE2 治理 × thinking-coach 训练）

## 快速启动

前置：Node.js ≥ 22.5（用内置 node:sqlite，无需编译原生模块）、macOS（密钥托管用 Keychain，Linux 可改用其他方式）。

### 方式一：一键脚本（推荐）

```bash
./pm.sh start     # 启动 server(:8735) + web(:8736)，含依赖安装与健康等待
./pm.sh status    # 状态总览：进程/健康/凭据/数据量
./pm.sh doctor    # 体检：Node/pi/YAML 语法/源码语法/端口
./pm.sh restart   # 重启
./pm.sh stop      # 停止
./pm.sh log server|web     # 查看日志（.logs/）
./pm.sh backup    # 备份数据库（.backups/，保留最近 10 份）
./pm.sh restore   # 恢复备份
./pm.sh reset-demo # 清空数据重新走冷启动（自动先备份）
```

### 方式二：手动

```bash
# 1) 配置密钥（复制模板并填入你的凭据）
cd server
cp .env.example .env
#    编辑 .env：AGENT_PROVIDER / OPENAI_API_KEY / FEISHU_APP_ID 等

# 2) 加密托管（明文删除，密钥入 macOS Keychain，AES-256）
npm run secrets -- lock

# 3) 装依赖并启动服务（自动从 Keychain 解密注入，明文不落盘）
npm install
npm run dev            # → http://127.0.0.1:8735

# 4) 前端
cd ../web
npm install
npm run dev            # → http://localhost:8736
```

打开 **http://localhost:8736**，六个页面：教练室 / 项目工作台 / 成长记录 / 强化营 / 成长路径 / 骨架·SSE。

## 密钥管理（server/scripts/secrets.sh）

| 命令 | 作用 |
|---|---|
| `npm run secrets -- lock` | `.env` → AES-256 加密为 `.env.enc`（密钥存 macOS Keychain，服务名 `pm-master`），**删除明文** |
| `npm run secrets -- unlock` | 临时解密回 `.env`（编辑后记得重新 lock） |
| `npm run secrets -- status` | 查看三个状态（明文/密文/Keychain） |

- 日常 `npm run dev` **不需要** `.env` 明文存在——启动包装（`with-env.sh`）从 Keychain 取密钥解密到内存级临时文件（进程退出即删）。
- `.env` / `.env.enc` / `data/` 均已 gitignore，永不入库。
- 换机器：需在新机 Keychain 重建密钥（lock 时自动生成新密钥会无法解旧密文——跨机迁移请手动传输 `.env` 后重新 lock）。

## .env 配置项

```ini
AGENT_PROVIDER=openai            # mock | openai（OpenAI 兼容接口）
OPENAI_BASE_URL=...              # 如 https://token.sensenova.cn/v1（商汤）
OPENAI_API_KEY=sk-...
OPENAI_MODEL=deepseek-v4-flash           # 强模型：教练/周报/评定
OPENAI_MODEL_FAST=sensenova-6.8-flash-lite  # 快模型：出题/判分（RPM 宽松池）
OPENAI_MAX_TOKENS=6000           # 推理模型思考耗 token，预算放大
FEISHU_APP_ID=cli_...            # 飞书自建应用（云文档写回；不配则降级下载 .md）
FEISHU_APP_SECRET=...
```

飞书应用需开通权限：`docx:document`（编辑云文档）、`drive:permission`（设置链接分享）；发布版本后生效。

## 目录结构

```
pm-master/
├── PRD.md                  # 产品需求文档（v3.x，设计+落地全程记录）
├── standard/               # 系统宪法：评级唯一依据
│   ├── gbt41831.yaml       #   国标结构化（五级×17领域深度矩阵×29指标×经验硬指标）
│   ├── pmp-prince2-map.yaml#   17领域×PMP/PRINCE2 映射 + 度量→例外管线
│   └── indicator-training-map.yaml  # 29指标×训练来源 + 教练场景 + 组合解锁
├── server/                 # Fastify + node:sqlite（17表）+ agent适配层
│   ├── src/index.mjs       #   路由总入口
│   ├── src/agent.mjs       #   LLM 适配（mock/openai 双 provider，JSON模式，429退避）
│   ├── src/coach.mjs       #   GROW 状态机（规则层推进+LLM内容分离）
│   ├── src/workbench.mjs   #   EVM+容差引擎（纯代码）+周报/风险/二阶推演
│   ├── src/drill.mjs       #   SM-2 间隔重复 + 情景题（深度随档案等级）
│   ├── src/growth.mjs      #   F3 三维聚合+min合成+差距+任务
│   ├── src/feishu.mjs      #   飞书写回（token缓存→建docx→分批写块）
│   └── scripts/            #   secrets.sh（Keychain加密）/ with-env.sh（启动包装）
├── web/                    # Vite + React（6页面）
├── demo/index.html         # 高保真可交互原型（单文件，设计语言参考）
└── GB-T41831-2022_ocr_raw.txt  # 国标原文 OCR（结构化依据）
```

## 核心业务流

```
冷启动评估 → 定位 L1-L5 任意等级（等级无关，代码零硬编码）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
日常飞轮：
  工作台(周报LLM+容差引擎) ──超容差──▶ 预警 ──▶ C13例外应对教练(GROW)
       │                                      │ E评定(依据引用)
       ▼                                      ▼
  行动项勾选(诚信机读分)              素质分流水+成长记录归档
       └──────────────┬───────────────────────┘
                      ▼
  每月F3重算：三维聚合(K卡片覆盖/C行为证据/E硬指标)→min合成→差距→grow-planner任务
                      ▼
  强化营弱项训练(SM-2+情景题深度随级) ──▶ 回到教练室
```

## API 一览（:8735）

| 域 | 端点 |
|---|---|
| 标准 | `GET /api/standard/:name` · `GET /api/requirements/:level?track=` · `POST /api/gap-analysis` |
| 档案 | `GET/PUT /api/profile`（current_level 切换=全模块自适应） |
| 教练 | `GET /api/coach/scenarios` · `POST /api/coach/sessions` · `POST .../messages` · `POST .../control{skip|back|fast|status}` · `POST .../close`（E评定+归档） |
| 工作台 | `GET/POST /api/projects` · `POST .../weekly{pv,ev,ac}` · `POST .../tolerance-check` · risks(+second-order/to-issue) · stakeholders · meetings(+actions) |
| 预警 | `GET /api/alerts` · `POST /api/alerts/:id/ack` |
| 成长记录 | `GET/POST /api/evidence` · `GET/PUT /api/experience-stats` |
| 强化营 | `GET /api/drill/queue` · `POST /api/drill/cards/:id/review` · `POST /api/drill/scenario/:domain` → `POST .../answer` |
| 成长路径 | `GET /api/growth/scores|history` · `POST /api/growth/recalc` · `GET/POST /api/tasks` |
| 集成 | `GET /api/feishu/status` · `POST /api/feishu/export-doc` · `GET /api/scheduler` · `POST /api/scheduler/run/:job` |

## 设计要点（为什么这样做）

- **代码零等级硬编码**：一切等级内容读 `standard/gbt41831.yaml`，档案只存 current/target level
- **规则交给代码，判断交给 AI**：GROW 阶段推进/EVM/容差比对/SM-2 调度是纯代码；提问/生成/判分走 LLM（强/快双模型分池，429 分级退避）
- **行为证据 > 自评**：素质分以教练会话 E 评定与机读数据（行动项完成率/容差内交付率/EVM）为主
- **降级不断流**：飞书未配置→下载 .md；LLM 未配置→mock provider

## 演示脚本（首次体验 10 分钟）

1. 教练室 → 资源谈判 → 走 GROW（fast 模式 3 层 Why）→ 结束并归档（看 E 评定）
2. 工作台 → 生成周报（PV 420/EV 398/AC 458 触发 CPI 预警）→ 预警卡"进入例外教练"
3. 强化营 → 复习 2 张卡 + 做一道情景题（深度随目标级）
4. 成长路径 → F3 月度重算 → 看雷达/差距/自动生成的任务 → 去成长记录更新经验现值
