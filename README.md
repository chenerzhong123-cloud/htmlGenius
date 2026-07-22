# htmlGenius

> 在任意网页上划词评论，挑选本次要处理的意见，一键打包成带精确定位的修改契约——复制给 AI，或直接交给本机的 Codex / Claude Code 产出一份可回退的候选版本。让 AI 生成的 HTML 越改越准。

🌐 **官网 / Live site**：<https://www.deuce.monster/htmlgenius/>（中 / English 双语）

你用 AI 生成了一份 HTML，渲染出来总觉得「这里字号大了」「这段措辞要改」「这个按钮该靠右」。光在对话框里描述，AI 总改不到位。htmlGenius 让你**直接在渲染好的网页上**圈出每一处、写下意见；需要动手时再**挑选**这次要处理的评论，整理成一段带精确定位的修改契约，复制粘贴给 AI，或一键交给本机 Agent。

它是一个 Chrome 扩展：装一次，任何网页都能用。数据留在你自己手里。

## 它能做什么

- **划词评论**：选中网页上的任意文字 → 选区上方弹出「评论」→ 写下你的意见。
- **先讨论，再决定**：评论默认只是讨论记录；要交给 Agent 时点「整理评论，创建编辑任务」，**人工勾选**这次要处理的评论（默认全选，可取消不确定的；回复随其根评论一起带出）。没有任何模型替你判断一条评论是不是修改建议。
- **不破坏原网页**：高亮只是一层覆盖，关掉插件页面照旧，不会动到原文结构。
- **评论跟着内容走**：AI 改完产出新版本后，你的评论会自动定位到新位置；原文被删的评论会归档保留，不会丢。
- **层层回复**：可以在一条评论下继续讨论，形成讨论线索。
- **修改契约**：把选中的评论整理成带「允许范围 / 保护规则 / 歧义处理 / 验收条件」的结构化契约，复制 Prompt / JSON 粘给 AI，或发给本机 Agent。
- **直接编辑（本地文档）**：本地的 HTML 还能直接在页面上改文字、调样式（加粗 / 斜体 / 颜色 / 字号 / 对齐 / 元素级编辑）。
- **交给本机 Codex / Claude Code / GitHub Copilot（v0.8.2）**：把契约交给你本机已登录的 Codex（推荐，常驻热服务最快）、GitHub Copilot（官方 Copilot SDK 接入，本机 Copilot CLI 或 SDK 自带 runtime）或 Claude Code，产出一份**新的候选 HTML（只写候选，绝不覆盖原文件）**，以 `原名V1.1.html` 这样带版本号的独立文件发布，打开后评论自动重定位；状态栏实时显示 Agent 输出，完成后自动新开页签 + 系统通知。仅 macOS + Chrome + Node 20.19+/22.12+，详见 [`docs/LOCAL_BRIDGE.md`](docs/LOCAL_BRIDGE.md) 与 [Agent 说明](https://www.deuce.monster/htmlgenius/agents.html)。

## 安装

1. 打开 `chrome://extensions`，右上角开启「**开发者模式**」。
2. 点「**加载已解压的扩展程序**」，选择本仓库的 `extension/` 目录。
3. 打开任意网页，点工具栏的 htmlGenius 图标，侧边栏即打开。

## 怎么用

1. 在网页上选中一段文字 → 选区上方点「**评论**」。
2. 在侧边栏的输入框写下意见 → 按 **Enter** 保存（Shift+Enter 换行，Esc 取消）。
3. 重复，把所有想讨论的地方都标出来。
4. 点底部「**基于评论修改文档**」→ 勾选本次要处理的评论 → 「继续」→ 在契约里补充目标 / 保护项 → 「**复制 Prompt**」粘给 AI，或在发送下拉菜单选「**发送给 Codex / Claude Code / GitHub Copilot**」交给本机 Agent。

> 在一条评论上悬停，可以**回复**、**编辑**或**删除**（编辑 / 删除仅限作者本人；删除会连同其下所有回复一起删）。

## 最近更新

### v0.9.1（2026-07-23 · 当前版本）

- **Provider 认证体系**：新增 provider 不再是"在 if/else 里补分支"——必须交付 descriptor、fake runtime fixture、能力矩阵并通过统一认证（见 [`docs/providers/README.md`](docs/providers/README.md)）。
- **provider registry**：`bridge/provider-registry.mjs` + `extension/provider-metadata.js` 单一 allow-list，background/host/probe/菜单的 provider ID 与能力全部由 registry 派生，一致性测试兜底漂移。
- **自动化验证门**（无账号、无网络、无真实 Chrome）：`npm run verify` = `npm test`（283 项）+ `verify:bootstrap`（13 项：install→幂等→origin 拒绝→损坏→repair→Native 帧→uninstall）+ `verify:providers`（37 项：三 provider 的 probe/candidate/plan/安全不变量认证，含 shell 注入安全）。
- **真实 smoke（opt-in）**：`npm run smoke:local` / `smoke:provider` 默认拒绝运行，需双环境门（`HTMLGENIUS_ALLOW_REAL_SMOKE=1` + 隔离 workspace）；真实 smoke 通过不自动提升 provider 为正式支持。
- **脱敏报告**：所有 verify 命令产出 `verification-report`（schema v1），递归剥离路径/token/session/stderr/prompt 等敏感键。
- **Connection Center 纯函数化**：状态矩阵抽为 `connection-center-state.js`，node:test 直接验证五状态、修复按钮出现条件、bootstrap 安全与三语 key 完整。

### v0.9（2026-07-23）

- **本地连接组件，面向普通用户**：不必再进源码仓库跑脚本。未连接时契约页出现 **Connection Center**：点「**让 Agent 帮我连接**」复制一段严格限定的 Setup Prompt（只含扩展 ID 与固定版本，不含任何页面/评论/凭证内容），粘贴给你正在用的 Claude Code / Codex / Copilot，它只运行官方 CLI（只读 doctor → 用户级 setup → 复查）；或「复制 Terminal 命令」自己执行。
- **Connection Center 状态矩阵**：区分「未安装 / 组件需修复 / 组件就绪但 Agent 未登录 / 已连接 N 个 Agent / 系统不支持 / 扩展需更新」，逐项给出真实状态与官方登录指引；「检查连接」只读重探，「复制诊断」只给脱敏 health JSON。
- **安全修复（allow-list + 二次确认）**：仅当 host 可达且判定可自修时出现；明确告知只重写 Chrome Host 注册文件，不安装 Agent、不改项目文件。
- **受控 CLI `htmlgenius-bridge`**：`doctor / setup / repair / uninstall / version`，`--json` 输出唯一 JSON 与稳定退出码；安装布局版本化受管目录（`~/.htmlgenius/bridge/versions/<v>/`，launcher 不指向 npx 缓存）；幂等 setup；V0.8.2 安装可迁移（extension ID 不匹配拒绝覆盖）；只删自家文件。
- **任何状态保留「复制 Prompt」**：没连上 Bridge 也随时可以复制契约手动交给任意 AI。
- **发行状态**：npm 包 `@htmlgenius/bridge` 尚未发布——当前 Connection Center 为**开发态**（显著标注「仅开发环境」，给仓库内命令）；开发者仍可用 `node bridge/install-macos.mjs --extension-id <ID>`。详见 [`docs/LOCAL_BRIDGE.md`](docs/LOCAL_BRIDGE.md)。

### v0.8.2（2026-07-23）

- **GitHub Copilot 接入**：Agent 菜单新增第三项 GitHub Copilot（单一入口，不暴露两个重复产品）。Host 通过官方 `@github/copilot-sdk`（精确锁定 1.0.7）连接：优先以 SDK stdio 模式连你本机的 `copilot` CLI（`local_cli`），CLI 缺失或不兼容时自动改用 SDK 自带 runtime（`bundled_sdk_cli`），菜单实时显示所用 runtime。
- **受控安全边界**：Copilot session 跑在 SDK empty 模式——只开放文件读写类工具并逐个 `onPreToolUse` 校验（candidate 只允许写 `candidate.html`、plan 只允许写 `output/plan.json`，路径围栏 + symlink 逃逸检查）；shell / 网络 / subagent / MCP 全禁；每个 run 一个新 session，永不读取或续发你在 Copilot CLI / VS Code 里的已有会话。
- **Plan→Candidate runtime 一致性**：确认计划生成 candidate 时锁定生成计划所用的 runtime；不可用则明确失败（COPILOT_RUNTIME_CHANGED），不静默切换。
- **plan-first 闭环修复**：`bridge-plan-ready` 广播补上缺失的 `plan_sha256`，「确认计划，生成新版本」链路对三家 provider 恢复可用（前端按钮仍按计划隐去）。
- **installer provider-neutral 化**：安装 Local Bridge 不再强制要求本机有 Claude CLI（只用 Copilot / Codex 也可装）；Node 版本要求对齐 SDK：`^20.19.0 || >=22.12.0`。
- **测试基建修复**：`npm test` 改为显式 `test/*.test.mjs`——旧目录参数会把 fake app-server 当测试文件执行导致套件挂起（此前全量套件从未真正跑完）；现 206 项全绿。

### v0.8 / v0.8.1（2026-07-22）

- **Codex App Server 接入（推荐优先）**：除 Claude Code 外，现在支持把修改契约交给本机 Codex（ChatGPT.app 内置 `codex app-server`）生成候选版本。Codex 是常驻热服务，handshake 快、token 逐字流式输出，整页重做通常几分钟完成；Claude Code 走 CLI 冷启动，等待更久属正常。两者都只写候选、永不覆盖原文件，只用本机登录态、不存任何凭证。
- **修改契约重做（compose-first）**：「基于评论修改文档」入口默认全选直达「选择修改范围」（精确 / 局部 / 全文重做三档）；全文重做不再强制填 brief，评论即输入。
- **Mint 深色主题**：整个 sidepanel + 页面级刷新弹窗统一为 Mint 配色。
- **候选版本号**：每次生成写入文件名（`原名V1.1.html`、`V1.2.html`…按文档累计），状态栏显示「候选 V1.N 已生成」。
- **生成过程可感知 + 可中止**：发送后按钮变「终止任务」（琥珀警告色，可随时中止）；状态栏自动展开，Codex 逐字流式 + 文件 / 命令 / 思考事件 + 计时器，完成后自动收起。两侧超时统一 15 分钟。
- **完成即开 + 通知**：自动新开页签打开候选（不重复开）+ Chrome 系统通知（带"叮"提示音）；回原 tab 发送按钮自动恢复，便于改评论后再发下一版。
- **多 tab 独立**：每个浏览器 tab 一份契约 / 运行态快照，切 tab 自动跟随。
- **plan-first bridge（先给我看修改计划）**后端已就绪，前端暂隐去，待后续细化。

### v0.7.1 / v0.7.2 / Night Pack A（2026-07-20）

- **交给本机 Claude Code**：把修改契约一键发给本机已登录的 Claude Code（先 `claude auth login`）；**候选闭环**会产出一份新的候选 HTML（只写候选、不覆盖原文件），打开后评论自动重定位，侧边栏显示「原文件未修改 / 已重锚 X/Y 条 / Z 条待检查 / 源哈希已校验 / 候选 hash」等只读证据，并提供「打开候选 / 返回原文件」。
- **先挑选再交给 Agent**：评论页默认是完整收件箱；点「整理评论，创建编辑任务」后才进入挑选步骤（默认全选顶层未失效评论，可取消；超 20 条提示分批）。回复随根评论带出，不单独勾选。
- **状态可回退**：挑选 ↔ 契约可往返并保留勾选与已填内容；关闭 / Esc 清空临时选择。未选 / 失效评论绝不进入输出。
- 安装：`cd bridge && node install-macos.mjs --extension-id <扩展ID>`，详见 [`docs/LOCAL_BRIDGE.md`](docs/LOCAL_BRIDGE.md)。仅 macOS + Node 20+。

### v0.8（2026-07-20）

- **高亮不再「盖字」**：两入口调色板统一并移除会让浅色文字隐形的纯白高亮；失效选区施色改为明确提示。
- **重做真正可用**：撤销 / 重做完全对称，工具栏所有编辑都记入历史。
- **侧边栏工具补齐**：评论 / B/I/U/S / 清除格式 / 字号 / 标题 / 对齐，与页面工具栏同一修改逻辑；图标统一；选色弹窗整宽 8×2 无空位。
- **「整理评论，创建编辑任务」常驻第一屏**；编辑文字立即出光标；激活弹窗「刷新」偶发无反应已修复。
- **文案统一**：UI 的「批注 / 评论」全部统一为「评论」（中 / 英 / 日）。

### v0.6 / v0.6.1 / v0.6.2 / v0.7（2026-07-16 ~ 19）

- **元素级编辑（高级模式）**：在本地 HTML 上选中 / 删除 / 复制 / 拖拽重排控件，改字体 / 字距 / 行距 / 内边距；样式与 Emoji 工具。
- **修改契约**：把评论升级为带允许范围 / 保护规则 / 歧义处理 / 验收条件的契约（精准修补 / 局部优化 / 结构重组 / 重新生成）。
- **本地版本对账**：逻辑文档 ID + artifact SHA-256；外部改动后打开新版本而非旧快照，版本关系可追溯。
- **本机 Bridge（v0.7，Codex adapter）**：Native Messaging host 把契约交给本机 Agent，只写候选不覆盖原文件（v0.7.1 起默认走 Claude Code，Codex 作为后续 adapter 复用同一 host）。

> 完整版本历史（含 v0.1–v0.5）见 **[RELEASE_NOTES.md](RELEASE_NOTES.md)**。

## 更多

- 开发、测试、部署与架构说明：**[DEVELOPMENT.md](DEVELOPMENT.md)**
- 各版本的设计与实现计划：`docs/` 目录

## 已知限制

- **回灌需手动粘贴**：复制指令后要自己粘进 AI 对话框（除非用本机 Agent 闭环）。
- **远程网页的编辑是临时的**：刷新或关闭页面即丢失，无法存回原网站。
- **协同需登录**：多人实时评论需用飞书账号登录自托管后端；本地单人用法不受影响。
- **本机 Agent 闭环需准备**：Codex 需安装 Codex Mac App 并登录；Claude Code 需 `claude auth login`；GitHub Copilot 需本机已登录 Copilot（CLI 可选，缺失时走 SDK 自带 runtime）；三者都需安装本地连接组件（仅 macOS + Node 20.19+/22.12+）——v0.9 起可通过 Connection Center「让 Agent 帮我连接」或一条 Terminal 命令完成，无需进源码仓库。候选闭环的真实运行消耗你本机额度，自动化测试用假 CLI / 假 app-server / 假 Copilot SDK 覆盖（**真实 Copilot 端到端 smoke 与 v0.9 真实 Agent-assisted 安装的人工验收尚未执行**，mock 通过不等于真机验证）。
- **npm 包未发布**：`@htmlgenius/bridge` 尚未 publish，Connection Center 处于开发态（给仓库内命令并显著标注）；正式发布是后续外部授权事项。
- **候选 ≠ 接受修改**：候选版本不会自动覆盖原文件；diff / 审查 / 显式提升（promote）尚在路线图，未实现。
