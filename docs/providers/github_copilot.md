# Provider:github_copilot(GitHub Copilot)

## 官方前提

- 本机已完成 **GitHub Copilot 登录**(Copilot Free / Pro 均可;Bridge 复用本机登录态,**不读取/不保存** token / Cookie)。
- 可选安装 `copilot` CLI:Bridge 优先以官方 SDK stdio 模式连它(`local_cli`);缺失/不兼容时自动用 SDK 自带 runtime(`bundled_sdk_cli`,依赖 bridge 内精确锁定的 `@github/copilot-sdk@1.0.7`)。
- macOS + Chrome + Node `^20.19.0 || >=22.12.0` + 已安装 HTML Genius Local Bridge。

## 能力

| 能力 | 支持 | 说明 |
|---|---|---|
| candidate | ✅ | 官方 SDK empty 模式;工具白名单(view/edit/write/grep/glob 类)+ `onPreToolUse` 路径围栏(realpath 规范化、拒 symlink 逃逸);只允许写 `candidate.html`;shell/联网/subagent/MCP/memory 全禁;超时 8 分钟。 |
| plan | ✅ | 只允许写 `output/plan.json`;不使用 SDK 的 `plan.md` API / 内建 `/plan`;超时 3 分钟。 |
| runtime policy | `runtime_locked` | **Plan→Candidate 锁定同一 runtime**:计划生成后 runtime 不可用 → `COPILOT_RUNTIME_CHANGED`,要求重建计划,**绝不静默切换**。 |

## 用户手动登录方式

按 GitHub 官方流程在本机完成 Copilot 登录(Copilot CLI `copilot` 或 GitHub 桌面流程);Bridge 不代登录、不代接受订阅条款。未登录时 Connection Center 显示「需要在本机登录 Copilot」。

## 安全边界(不允许回归)

- 每个 run 一个 client + 一个新 ephemeral session;事后 abort/disconnect/stop。
- **永不**读取/列举/恢复/注入用户在 Copilot CLI / VS Code / GitHub 中的已有会话;禁用 API:listSessions / resumeSession / getLastSessionId / getForegroundSessionId / getEvents / registerTools / customAgents / mcpServers / cloud session。
- Copilot session ID **永不持久化**(bridge_sessions 不写 copilot)。
- CLI 绝对路径 / token / stderr 不出 host;probe 只 start→getAuthStatus/getStatus→stop,不建 session。
- telemetry 关闭。

## 已知限制

- 免费档额度有限(每月 premium 请求数),额度耗尽时 probe/运行会失败(稳定错误码)。
- 本地 CLI 与锁定 SDK 版本的兼容由 Bridge 探测;不兼容自动转 bundled runtime(仅执行前,run 内不 fallback)。
- 工具白名单按 SDK fixture + copilot-cli changelog 核实;未来 runtime 改名会导致 session「无工具可用」而明确失败(不静默越权),真机 smoke 时需确认实际工具名。

## 验证状态

- **mock 认证:已过**(`npm run verify:providers`,fixture `github-copilot.fixture.mjs`,probe 5 场景 + candidate 5 项 + plan 2 项 + runtime_changed 全绿)。
- **真实 smoke:未验证**(需本机 Copilot 权益;`npm run smoke:provider -- --provider github_copilot`,双环境门 opt-in)。
