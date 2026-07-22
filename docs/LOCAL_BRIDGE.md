# htmlGenius Local Bridge (v0.8.2 · macOS · Claude Code / Codex / GitHub Copilot)

让 Side Panel 把一份「修改契约」**一键交给你本机已登录的 AI Agent**，产出一份**只写候选、绝不覆盖原文件**的新版本（`原名V1.N.html`），或先生成一份可审阅的**修改计划**（plan-first）。

> 仅 macOS + Chrome + Node `^20.19.0 || >=22.12.0`。host 名 provider-neutral（`com.htmlgenius.local_bridge`）：Claude Code / Codex / GitHub Copilot 三个 adapter 复用**同一个** host，装一次即可。

---

## 1. 前置条件

- **macOS**（Apple Silicon 或 Intel）。Windows / Linux 的 Native Host 未实现。
- **Node.js**：`node -v` 需满足 `^20.19.0 || >=22.12.0`（`@github/copilot-sdk` 的 engines 要求）。
- **Google Chrome**（已加载 htmlGenius 扩展）。
- **至少一个 Agent 就绪**（可选其一或多；安装 host 不强制三者齐备）：
  - **Codex（推荐，最快）**：安装 Codex Mac App（ChatGPT.app 内置 `codex app-server`）并登录。常驻热服务，handshake 快、token 流式输出。
  - **GitHub Copilot**：本机已登录 GitHub Copilot。可选安装 `copilot` CLI（Bridge 优先以 SDK stdio 模式连它，`local_cli`）；CLI 缺失/不兼容时自动用 SDK 自带 runtime（`bundled_sdk_cli`，依赖 `bridge/node_modules` 内的 `@github/copilot`）。
  - **Claude Code CLI**：`claude --version` 可用 + `claude auth login` 完成。CLI 冷启动，等待更久属正常。
- htmlGenius **不要求、不读取、不保存**任何 API key、OAuth token、Cookie 或订阅凭据——全部复用各 Agent 的本机登录态。

## 2. 安装 Native Host

1. 在 Chrome 加载未打包扩展：`chrome://extensions` → 右上「开发者模式」→「加载已解压的扩展程序」→ 选本仓库的 `extension/`。
2. 在扩展卡片上复制 **ID**（32 位字符串，`a–p`）。
3. 在仓库根目录执行：
   ```bash
   cd bridge
   npm install                                  # 首次需要:拉取 @github/copilot-sdk 1.0.7(精确锁定)
   node install-macos.mjs --extension-id <你的扩展ID>
   ```
   - 安装只校验：Node 版本、`host.mjs` 存在、扩展 ID 合法、manifest 目录可写。**不再强制本机有 Claude CLI**——只用 Copilot / Codex 也能装。
   - 找到 `claude`（PATH 或 `--claude-path <绝对路径>`）会把其目录烘焙进 launcher PATH（GUI Chrome 的 PATH 极简）；找不到只告警、安装继续。
   - 仅写入**单个 origin** 的 host manifest + launcher 到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`（`allowed_origins` 只含你这一个扩展，无通配符）；launcher 用绝对 `node` + 绝对 `host.mjs`，无 shell 拼接；失败清理半写入文件。
4. 回到 `chrome://extensions`，点 htmlGenius 的「**刷新**」让 service worker 重新加载。

## 3. 使用

1. 打开一个**单文件本地 HTML**（`file:///.../report.html`）。
2. 划词评论（至少一条顶层评论）。
3. 点「**整理评论，创建编辑任务**」→ 勾选本次要处理的评论（默认全选）→ 选修改范围（精准 / 局部 / 全文重做）→ 进契约页。
4. 发送下拉菜单（⌄）里选 Agent：菜单显示每个 provider 的**真实探测状态**（已连接 / 需要在本机登录 / 未安装 / 不兼容）；Copilot 还显示所用 runtime（「本地 Copilot CLI」或「SDK runtime」）。仅「已连接」可选。
5. 「**发送给 ×××**」→ 新建 candidate task：状态栏实时展开（流式输出 / 工具事件 / 计时器），可随时「终止任务」；完成后自动新开候选页签 + 系统通知（带"叮"）。
6. 「先给我看修改计划」（plan-first，后端就绪、按钮按计划隐去）：先产 `output/plan.json` 供审阅编辑，确认后用**同一 runtime** 生成 candidate。
7. 每次运行在源文件目录旁留**本地审计证据**：
   ```text
   <源文件目录>/.htmlgenius-bridge/<claude|codex|copilot>/<逻辑文档ID>/
     runs/<run-id>/    source.html(0400 快照) + task bundle + candidate.html + candidate-manifest.json
     plans/<run-id>/   source.html + task bundle + output/plan.json + plan-manifest.json
   ```

## 4. 故障排查

| 现象 | 处理 |
|---|---|
| `未检测到本地 Bridge` | 执行 installer；确认 `--extension-id` 与扩展卡片 ID 一致；刷新扩展。 |
| `Claude Code 未登录` | `claude auth login`；`claude auth status` 确认。 |
| `GitHub Copilot 需要在本机登录` | 在本机完成 Copilot 登录（Copilot CLI `copilot` 或 GitHub 桌面流程）后重开 Side Panel / 30s 后自动重探。 |
| `Copilot runtime 未安装` | `cd bridge && npm install` 后刷新扩展。 |
| `本地 Copilot CLI 不兼容` | 升级本机 `copilot` CLI，或不装 CLI 让 Bridge 走 SDK 自带 runtime。 |
| `计划对应的 Copilot runtime 已不可用` | 确认计划后原 runtime 失效（如拔了 CLI）；重新生成计划即可（不静默切换 runtime）。 |
| `Copilot Agent 尝试使用任务范围外的工具或路径` | 安全策略拒绝了越权工具/写路径；重试或调整评论。 |
| `源 HTML 已变化，未发送` | 发送前/期间源文件被改动；重新加载文件后再发起。 |
| 一段时间无响应 | host 日志在 stderr；`node bridge/host.mjs` 可手测帧。超时：Copilot plan 3min / candidate 8min；Codex / Claude 15min。 |

## 5. 卸载

```bash
node bridge/install-macos.mjs --uninstall
```

仅移除本 host 写的 launcher + manifest，不碰 Bridge workspace（审计证据）与扩展数据。

## 6. 安全模型（摘要）

- **只写候选，绝不覆盖 source**：Agent 在 `runs/<run-id>` 沙箱里只写 `candidate.html`（plan run 只写 `output/plan.json`）；host 前后比对 source 原始字节 SHA-256（运行期被改 → candidate 废弃），校验通过后以**版本号 sibling**（`原名V1.N.html`，文档级计数）发布。
- **Claude**：固定只读+Write argv、`--safe-mode`、禁 Bash/Edit/网/MCP、`spawn(shell:false)` 防注入、max-turns 24。
- **Codex**：仅 `com.openai.codex` bundle runtime（codesign TeamID 校验，不搜 PATH）；workspaceWrite + approvalPolicy=never；禁用 method 清单（thread/list、turn/steer…）不发。
- **Copilot（v0.8.2）**：官方 `@github/copilot-sdk` empty 模式；工具 allow-list（view/edit/write/grep/glob 类）+ `excludedTools` 显式拒绝（bash/shell/web_fetch/task/subagent/MCP/memory…）+ `onPreToolUse` 逐调用路径围栏（realpath 规范化、拒 symlink 逃逸、写只认输出文件）；telemetry 关；每 run 一个 client + 新 session，事后 abort/disconnect/stop；**run 内绝不 runtime fallback**；session ID 永不读取/持久化；CLI 路径/token/stderr 不出 host。禁用 API：listSessions/resumeSession/getLastSessionId/getForegroundSessionId/getEvents/registerTools/customAgents/mcpServers/cloud session。
- **共性**：单 origin 白名单；证据目录 0700、文件 0600/0400；IndexedDB 只存元数据哈希，不存 prompt/评论全文/stdout；completion 双重校验（run_id / task_sha256 / 逻辑文档）；hash 永不跨侧比较。

## 7. 明确不做

- 不修改/覆盖 source HTML；candidate 的 diff / review / promote 在路线图，未实现。
- 不接入用户在 Copilot CLI / VS Code / Claude / Codex 中已打开的会话（不列举、不读取、不注入、不续发）。
- 不展示思维链全文或任意历史会话；不做云端转发、统一 token、多任务队列。

## 8. 测试

```bash
cd bridge && npm test        # node --test test/*.test.mjs → 206 pass / 0 fail
```

覆盖：native 帧 codec、installer（provider-neutral / 单 origin / 0700 / 无残留）、host 分发（含 copilot_handoff_start 独立路由）、task bundle、claude-cli（argv 注入安全）、codex app-server client/adapter/plan-run、**copilot-runtime（CLI 发现拒 symlink / probe 不建 session / runtime 选择与锁定 / pre-tool 围栏）+ copilot-adapter（candidate/plan 闭环 / 越权归因 / runtime 不一致 / 失败不产 candidate）**、candidate 版本号、plan 校验全失败码、storage 迁移。

所有 Agent 测试用假 CLI / 假 app-server / **假 Copilot SDK（`test/fake-copilot-sdk.mjs`，动态注入）**，不消耗你的模型额度、不触网络；真实 Copilot 端到端 smoke 需本机 Copilot 权益，尚未执行。
