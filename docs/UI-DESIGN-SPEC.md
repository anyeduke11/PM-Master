# PM-Master 组件规范与交互文档（UI Design Spec）

> 适用范围：`web/` 全部前端界面。本文档是 [index.html](file:///Users/duke/Documents/经营分析看板/pm-master/web/index.html) 内全局样式的**配套说明**——令牌与规则的唯一权威来源始终是 index.html 的 `<style>` 块，本文件对其做结构化释义与使用约定，不引入第二套真源。
> 版本：v1.3（2026-10-13，随 v5.18.0 角色统一更新）｜上游契约：[PRD.md](file:///Users/duke/Documents/经营分析看板/pm-master/PRD.md) §8 页面交互设计 · §15 AI 教练助手（统一角色）｜技术约定：[AGENTS.md](file:///Users/duke/Documents/经营分析看板/pm-master/AGENTS.md) 前端约定

---

## 1. 设计原则

| # | 原则 | 落地约束 |
|---|---|---|
| P1 | **令牌唯一真源** | 颜色/圆角/时长/缓动一律引用 `var(--*)`；组件内联样式禁止硬编码视觉值（颜色 hex、圆角 px、渐变） |
| P2 | **双主题等价** | 每个语义令牌在 `:root/[data-theme="dark"]` 与 `[data-theme="light"]` 均须定义；新增令牌必须双份 |
| P3 | **无障碍达标** | 正文对比度 ≥ 4.5:1，非正文 UI 组件 ≥ 3.0:1（WCAG 2.1 AA）；键盘可聚焦；尊重减少动效偏好 |
| P4 | **形状一致性** | 圆角只用 7 级刻度（§3.3），禁止自由数值；同类组件圆角必须同档 |
| P5 | **动效克制** | 仅动 `transform`/`opacity`；统一缓动 `--ease`；时长只取 3 档（§3.4） |
| P6 | **无破折号文案** | UI 文案禁止 em-dash「—」；范围用半角连字符 `-`，补充说明用 `：` 或 `，`（空值占位符统一 `-`） |
| P7 | **响应式折叠** | 多列布局桌面多列、窄屏由断点统一折叠为单列（§6），不逐页写 hack |

---

## 2. 主题与令牌体系

主题由 `<html data-theme="dark|light">` 切换；偏好存 `localStorage["pm-theme"]`，由 `<head>` 内联脚本先于渲染读取以消除闪白（FOUC）。默认深色（冷色科技风）。

### 2.1 颜色语义令牌

| 令牌 | 语义 | dark | light |
|---|---|---|---|
| `--bg` | 页面底色 | `#0a1120` | `#eef3fa` |
| `--surface` | 一级卡面 | `#111b2e` | `#ffffff` |
| `--surface-2` | 二级卡面 | `#16223a` | `#f2f6fc` |
| `--surface-3` | 三级卡面/凹陷 | `#1b2a46` | `#e7eef8` |
| `--head` | 顶栏/助手头底色 | `#0c1424` | `#10233c` |
| `--text` | 主文本 | `#dbe6f5` | `#0f2138` |
| `--text-2` | 次文本 | `#8ea3c0` | `#4f6886` |
| `--line` | 主分隔线/描边 | `#243550` | `#d3e0f0` |
| `--hair` | 细线/滚动条 | `#2c4066` | `#b9cde6` |
| `--accent` | 主强调色 | `#3ea6ff` | `#0b63c4` |
| `--accent-2` | 次强调色 | `#5aa8ff` | `#1a63b0` |
| `--on-accent` | 强调底上的前景 | `#06121f` | `#ffffff` |
| `--ok` / `--warn` / `--cin` / `--hot` | 成功/告警/危险/高亮 | `#3ecf8e` / `#e8b33c` / `#f2665c` / `#ff9f43` | `#0f6b41` / `#7d5514` / `#a93a2e` / `#b45309` |
| `--ok-soft` / `--warn-soft` / `--danger-soft` / `--accent-soft` | 语义软背景 | `rgba(...)` 低透明 | 实色浅底 |
| `--pr2-bg/-fg` · `--gb-bg/-fg` | 体系标签（PRINCE2 / 国标）成对底/字 | — | — |
| `--glow` / `--shadow` / `--grid` / `--accent-grad` / `--overlay` / `--sheen` | 光晕阴影/网格底纹/渐变/遮罩/高光 | — | — |
| `--head-fg` / `--head-fg-2` | 顶栏上的前景/次前景 | — | — |

**兼容别名**（历史内联 `var()` 引用面，均为单向映射，新代码勿使用）：
`--paper → --surface-2` · `--ink → --text` · `--ink3 → --text-2` · `--navy → --accent-2`。

### 2.2 字体

- 正文：`-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif`
- 等宽（`--font-mono`）：`ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace`，用于数字/代码/ID
- 字号采用浏览器语义层级与组件既定值，**未**建立全局 `--fs-*` 刻度（既有界面字号多样，强行 tokenize 会制造不一致或死令牌）；新增文本沿用相邻同类组件的字号，不新造中间值。

### 2.3 圆角刻度（`--r-*`）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--r-xs` | 4px | 代码块、focus 环 |
| `--r-sm` | 6px | 小标签、滚动条、微控件 |
| `--r-md` | 8px | 交互件基座（button / input / textarea） |
| `--r-lg` | 10px | 列表行卡 |
| `--r-xl` | 12px | 卡片 |
| `--r-2xl` | 14px | 模态 |
| `--r-pill` | 999px | 徽标/芯片/开关轨道 |

仅 `.bell-dot`、`.switch::after` 等**语义圆形**保留 `border-radius:50%`。

### 2.4 动效刻度

- 缓动：`--ease: cubic-bezier(.16,1,.3,1)`
- 时长：`--dur-1:.15s`（微反馈）/ `--dur-2:.2s`（常规）/ `--dur-3:.25s`（页面/面板级，如主题切换、侧栏滑入）
- 关键帧（`animation:`）时长与 `transform .1s` 微调保持字面量，属刻意例外。

---

## 3. 无障碍（WCAG 2.1 AA）

- **对比度**：正文/次文本对背景 ≥ 4.5:1；按钮/徽标/开关等非正文 UI 组件 ≥ 3.0:1。亮色主题 `--accent/--ok/--warn/--cin/--hot` 与 `--on-accent` 已按此校正（浅底深字）。
- **焦点可见**：全局 `:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }`，禁止 `outline:none` 而不给替代。
- **减少动效双通道**：① 系统 `@media (prefers-reduced-motion: reduce)`；② 应用开关 `html[data-reduce-motion="1"]`（设置中心 E 区）。两者均将动画/过渡时长压至 `.01ms` 并停用骨架微光。
- **`color-scheme`**：dark/light 双值同步，使原生控件与滚动条随主题。
- **语义化**：toast 宿主 `aria-live`；模态 `role="dialog"`、ESC/点遮罩关闭。

---

## 4. 基础组件

| 组件 | 类名 | 要点 |
|---|---|---|
| 按钮基座 | `button`（任何 button 皆有科技风外观） | `.pri` 主行动（`--accent-grad` 底 + `--on-accent` 字）；`.mini` 小按钮；`.mini.danger` 危险（二次确认）；`.gseg` 分段按钮（**仅 `button.gseg` 可点**，展示用分段不假可点） |
| 卡片 | `.card` | `--r-xl` + `--surface` + `--glow`；分栏内层 `overflow` 由容器决定 |
| 徽标 | `.badge`（`.ok` / `.warn` / `.neutral`） | `--r-pill`；`.neutral` 前景用 `var(--text-2)` |
| 提示条 | `.notice`（语义变体） | 复用于说明/结果/错误；禁止退回裸 `alert()` |
| 空态 | `.empty` | 文案走 §1 P6（占位用 `-`、说明用 `：`） |
| KPI | `.kpi` / `.kpi` 网格 | 数字用 `--font-mono`；窄屏 `min-width` 收敛 |
| 进度条 | `.bar` | `--accent` 填充 |
| 表单 | `.field`（`input`/`textarea`/`select`） | 已有全局基座；`checkbox`/`radio` 用 `accent-color` |
| 选择卡 | `.choice` | 冷启动/场景选择 |
| 分隔线 | `.divider` | `--line`/`--hair` |
| 骨架 | `.skeleton` | 微光 `shimmer`；减少动效时隐藏 |
| 折叠 | `details`/`summary` | 已全局样式化 |
| 主题/偏好 | `.switch` | `--r-pill` 轨道；`::after` 为圆形滑块 |
| 模态 | Modal（[ui.jsx](file:///Users/duke/Documents/经营分析看板/pm-master/web/src/ui.jsx)） | 统一 `Modal`/`Field` 组件；替代 `prompt()` |
| 轻提示 | toast（[ui.jsx](file:///Users/duke/Documents/经营分析看板/pm-master/web/src/ui.jsx) `toast` + `ToastHost`） | 替代 `alert()`；`aria-live`；窄屏避让 FAB |
| 顶栏 | `header` / `.tabs` `.tab` / `.lv` | 窄屏换行、tab 横向滚动 |
| 助手侧栏 | `.asst` / `.asst-fab` / `#msgs` / `.asst-plan` | **统一角色「AI 教练助手」的常驻入口**（见 [PRD.md](file:///Users/duke/Documents/经营分析看板/pm-master/PRD.md) §15.0；`/coach` 为其专注视图，非第二入口）；窄屏抽屉化（`transform` 滑入）；默认收缩，收缩态由 `.asst-fab` 唤起（无 `body.assistant-live` 不留白） |
| 助手问题浮框 | `.asst-bubble`（`.x`） | 收缩态遇 `suggest`（容差预警/待复习）弹出：`--surface` 底 + `--accent` 左描边 + `--glow`；点击「让 AI 分析」展开侧栏并代入上下文；窄屏右上避让 `.asst-fab` |
| 铃铛 | `.bell` / `.bell-panel` / `.bell-item-top` | 面板 `mousedown-outside` 关闭 |
| 图标 | `@tabler/icons-react`（stroke 1.8 统一） | 禁用 emoji 当图标（跨浏览器渲染不一致） |

---

## 5. 状态与反馈规范

| 状态 | 要求 |
|---|---|
| **加载** | 提交类操作必须有 `busy` 态：按钮禁用 + 文案/骨架反馈；长任务（LLM 生成）保留已有 busy 提示 |
| **空态** | 给出「当前为空 + 下一步动作」引导文案（如「暂无记录：完成一次教练会话后自动归档」） |
| **错误** | 走 `.notice` 或 toast，**fail-loud**：不得静默吞掉；错误文案须可读、可行动 |
| **成功** | toast 轻提示；数据变更后 UI 即时刷新（广播事件，见下） |
| **破坏性操作** | 删除须**二次确认**（行内确认按钮 或 confirm 语义，禁止裸 `confirm()`/`alert()`） |

**前端事件桥**（跨 tab/组件通信，App 中转）：`pm-theme`（主题变更，ECharts 重绘）· `pm-settings`（设置保存，铃铛轮询/动效开关即时生效）· `pm-import-prefill`（设置→导入向导预填）· `pm-prompts`（提示词保存刷新）。

---

## 6. 响应式与分栏折叠

### 6.0 外壳高度链（布局地基）

工作台是**固定外壳 + 内部滚动**结构：`body{display:flex;flex-direction:column;height:100vh}` → `#root{flex:1;min-height:0;display:flex;flex-direction:column}` → `main{flex:1;min-height:0}` → `.page{height:100%}`。任何一环缺失 flex 上下文都会断链，导致 `main` 高度退化为内容高、`.split{height:100%}` 解析为 `auto`，整页沦为文档流（header/tabs 滚走、卡片无内部滚动）。

- **React 挂载点 `#root` 必须保留 flex 高度链规则**（`flex:1; min-height:0; display:flex; flex-direction:column`），见 [index.html](file:///Users/duke/Documents/经营分析看板/pm-master/web/index.html#L72)。这是「避免不断下拉」的最小必要条件。
- 页内固定轨（如教练室 GROW 轨/输入栏）+ 自治滚动区（如 `#msgs`）依赖两个配合：滚动容器 `overflow:auto` **且** `min-height:0`（flex 子项默认 `min-height:auto` 会阻止收缩）；grid 容器需 `grid-template-rows:minmax(0,1fr)` 夹紧隐式行高。

### 6.1 分栏容器 `.split`

所有「左侧导航/列表 + 右侧内容」型多列布局，容器加 `className="split"`，桌面列宽仍由内联 `grid-template-columns` 决定；**窄屏折叠交给统一断点**（`.split` 定义于 [index.html](file:///Users/duke/Documents/经营分析看板/pm-master/web/index.html#L507-L514)）。

当前 8 处使用：RA(220/1fr) · Records(1fr/340) · Itto(290/1fr) · CoachRoom(230/1fr/270) · Growth(1.1fr/1fr) · Drill(1fr/300) · Workbench(210/1fr) · Settings(170/1fr)。
**例外**：数据热力表（如 Workbench `auto 1fr 1fr 1fr`）为数据网格，**不加** `.split`。

### 6.2 断点

| 断点 | 行为 |
|---|---|
| **> 1180px** | 桌面：`.split` 按内联多列；卡片内部可滚动/裁切 |
| **≤ 1180px** | `.split` 折叠单列（`1fr !important`），高度自适应、溢出可见；`.card` 解除 `max-height`；**`main{overflow:auto !important}`** 交回整页滚动（单列下失去内部滚动锚点，须由 `main` 承接，否则内容被内联 `overflow:hidden` 裁切且无滚动） |
| **≤ 768px** | 移动端：`body/main` 高度自适应、`main` 去滚动；顶栏换行；`.tabs` 横向滚动；助手侧栏抽屉化；`.set-nav` 转横向滚动；flex 行 `wrap`；`pre` 换行；toast 上移避让 FAB |
| **≤ 480px** | 极窄屏：内边距/字号/`kpi` 宽度/FAB 尺寸微调 |

> 折叠覆盖内联样式的依据：媒体查询中 `!important` 声明优先于内联非 important 声明。

---

## 7. 贡献者清单（改前端前自查）

1. 视觉值是否全部走 `var(--*)`？内联样式里有没有颜色 hex / 圆角 px / 时长字面量？
2. 新增令牌是否**双主题**都定义了？
3. 圆角是否只落在 7 级刻度内、且与同类组件同档？
4. 是否引入新文案破折号「—」？（P6）
5. 是否用了 `alert()`/`confirm()`/`prompt()`？（应改 toast/Modal）
6. 提交/破坏性操作是否有 busy 态与二次确认？
7. 新分栏布局是否加了 `.split`？新页面是否在 [App.jsx](file:///Users/duke/Documents/经营分析看板/pm-master/web/src/App.jsx) 注册 tab？
8. 交互是否符合键盘可聚焦 + 尊重减少动效偏好？

---

## 8. 变更记录

| 版本 | 变更 |
|---|---|
| v1.0 | 首版：确立令牌唯一真源、双主题等价、WCAG AA、7 级圆角刻度、3 档动效时长、`.split` 断点折叠体系、em-dash 清零约定、组件清单与贡献者自查表（随 v5.17.2 全视觉重构交付） |
| v1.1 | 补 §6.0 外壳高度链（`body→#root→main→.page` flex 高度链为「固定外壳 + 内部滚动」的地基；`#root` 缺失即断链）；§6.2 ≤1180 断点补 `main{overflow:auto!important}`（单列折叠下交回整页滚动）。随 v5.17.3 外壳布局修复更新 |
| v1.2 | 补 §4 组件表 `.asst-bubble` 助手问题浮框（收缩态遇 `suggest` 弹出、点击代入上下文、窄屏避让 FAB）；助手侧栏条目补「默认收缩，收缩态由 `.asst-fab` 唤起」。随 v5.17.4 R7.1 P3 更新 |
| v1.3 | **角色统一对齐**（随 PRD v5.18.0「教练角色即 AI 助手」）：版本头上游契约补 §15 锚点；§4「助手侧栏」条目加注**「统一角色『AI 教练助手』的常驻入口」**（`/coach` 为其专注视图，非第二入口）。**纯文档对齐，无样式变更** |