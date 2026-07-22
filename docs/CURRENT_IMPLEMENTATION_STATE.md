# HTML Genius 当前实现状态

> **用途：** 产品路线与实际仓库之间唯一的短事实层。施工 Agent 开始前必读、验证并完成后整体重写。
> **更新规则：** 不追加"更新记录"；保留结构，替换过期事实；≤150 行。
> **最后静态核对：** 2026-07-23（v0.8.2：GitHub Copilot 接入（官方 @github/copilot-sdk 1.0.7，local CLI + bundled 双 runtime）、plan_sha256 闭环修复、installer provider-neutral 化、npm test hang 修复；bridge 测试 206 通过）。

## 1. 当前产品边界（不可擅自改变）

- Chrome Side Panel MV3 插件，本地优先；无托管 AI、统一 Token 或中心化对话服务。
- Agent 只用用户本机登录态（Codex=ChatGPT.app 登录 / Claude Code=`~/.claude` / Copilot=本机 Copilot 登录态）；只新建 task（session_mode=new），不列举/读取/恢复/注入用户已有会话；禁 RPC：thread/list、thread/read、thread/fork、turn/steer、thread/inject_items（Codex）；listSessions/resumeSession/getLastSessionId/getForegroundSessionId/getEvents/registerTools/customAgents/mcpServers/cloud session（Copilot SDK）。
- Change Contract 是唯一任务输入；prompt 不是安全边界。
- source HTML 永不自动覆盖：Agent 只写 workspace 内 candidate，host 校验后以**版本号 sibling**（`原名V1.N.html`）发布到 source 同级；版本关系/hash/用户确认优先于便利。
- **Copilot 安全边界（v0.8.2）**：SDK `empty` 模式 + 工具 allow-list（只读 view/grep/glob 类 + 写 view/write/edit 类）+ `onPreToolUse` 路径围栏（写只认 candidate.html / output/plan.json，拒 symlink 逃逸）；shell/bash/web_fetch/task/subagent/MCP/memory 全禁；**run 内绝不 runtime fallback**（Plan→Candidate 锁定 `provider_runtime`，不一致 → COPILOT_RUNTIME_CHANGED）；Copilot session ID 永不读取/持久化（bridge_sessions 不写 copilot）；CLI 绝对路径/token/stderr 不出 host。
- 评论是讨论记录；是否进入任务由用户在选择步骤人工勾选；无 AI 分类、不持久化评论类型。
- 不向 UI 暴露 runtime 路径 / TeamID / schema 路径 / stderr / 完整命令体 / 思维链正文 / session ID；hash 永不跨侧（host 原始字节 vs extension DOM 序列化）比较。

## 2. 已确认的实现基线

| 能力 | 状态 | 实际入口 / 证据 |
|---|---|---|
| Change Contract | 已存在 | `change-contract.js`（buildTask/getRoots/renderPrompt）；regenerate 已放开 brief（评论即输入）。 |
| artifact 协议 | 已存在 | `artifact-version.js`；`content-script.js` `handleArtifactUpdateReady`(new_artifact→linkArtifactUri+重锚)；basename 比 source_uri（容 realpath）。 |
| Claude Code handoff | 已存在 | `bridge/claude-cli.mjs`（candidate:Read,Glob,Grep,Write,禁 Bash/Edit/网/MCP，shell:false，safe-mode，max-turns 24）；`host-runner.mjs` executeCandidateRun。 |
| Codex App Server adapter | 已存在 | `bridge/codex-app-server-client.mjs`（initialize→thread/start→turn/start→turn/completed；仅 com.openai.codex bundle，不搜 PATH）；`bridge/codex-adapter.mjs`。 |
| **GitHub Copilot adapter** | **已就绪（mock 验证）** | `bridge/copilot-runtime.mjs`（discoverLocalCopilotCli 拒 symlink / attemptRuntimeStart / selectCopilotRuntime / probeCopilot / createPreToolPolicy / runCopilotSession）+ `bridge/copilot-adapter.mjs`（executeCopilotCandidateRun/PlanRun，复用 workspace/task-bundle/validator/manifest）。单一 provider `github_copilot`，Host-only runtime：`local_cli`（SDK forStdio 连本机 CLI）优先 → `bundled_sdk_cli`（SDK 自带 @github/copilot）。SDK 精确锁定 `@github/copilot-sdk: 1.0.7`（lockfile 已入库）。**真实 Copilot smoke 未跑**（见 §4/§5）。 |
| plan-first bridge | **后端就绪，前端隐去** | `plan-workspace.mjs`+`host-runner/codex-adapter/copilot-adapter` 三家 executePlanRun + `background.js` §5.4 校验/approved_plan 注入；**v0.8.2 已修 plan_sha256 广播缺失**（bridge-plan-ready 现携带 plan_sha256，确认闭环通过）；DB v5 `bridge_plans`（provider_runtime 为可选新字段，无需迁移）；`#contract-plan` 按钮仍 hidden。 |
| candidate 闭环 + 版本号 | 已存在 | `candidate-workspace.mjs` nextCandidateVersionLabel（`.htmlgenius-bridge/candidate-versions.json`，标签 1.N）→ `原名V1.N.html`；candidate-ready 带 `version_label`。 |
| provider probe（三家） | 已存在 | `provider-probe.mjs` 默认 `['claude_code_cli','codex_app_server','github_copilot']`，独立失败域；Copilot probe 只 start→getAuthStatus/getStatus→stop，不建 session；`plan-validate.js` sanitize 保留 runtime/runtime_label（≤64）、丢弃路径类键。 |
| Mint 主题 / 终止 / 通知 / per-tab | 已存在 | sidepanel mint token；bridge-cancel（USER_CANCELLED）；notifyCandidateReady+playDing（offscreen 合成"叮"）；focusOrCreateCandidateTab 去重；_tabStates 快照/恢复 + syncRunStateFromBackground。 |

## 3. 关键代码地图

```text
extension/sidepanel.js   契约状态机 + dispatchBridgeRun + syncRunStateFromBackground + _tabStates
                         provider 菜单三项(PROVIDER_LABELS/providerRuntimeNote,ready 才可选) + Copilot 失败码文案
extension/background.js  bridge-start(HANDOFF_START_TYPES 明确映射,copilot session 只发{mode}) + completeCandidate
                         (copilot 不存 session) + completePlan(落 provider_runtime;广播带 plan_sha256)
                         + candidate 携 plan → required_provider_runtime + probe 三 provider
extension/plan-validate.js  PROVIDER_RE 三家 + PROVIDER_RUNTIME_RE + plan-ready/确认 runtime 一致性 + sanitize
extension/content-script hg-modal 刷新弹窗(mint) + handleArtifactUpdateReady
extension/offscreen.*    Web Audio 合成"叮"；manifest permissions 含 notifications+offscreen(minimum_chrome_version 116)
bridge/copilot-runtime.mjs  CLI 发现(拒 symlink,version 10s 超时 ≤64) + SDK 工厂(empty 模式,cwd/baseDirectory 受控)
                            + probe/select(runtime 优先级/锁定) + pre-tool 策略(allow-list+realpath 围栏) + session 执行
bridge/copilot-adapter.mjs  candidate(8min)/plan(3min) 编排;denial>0 且无输出 → COPILOT_PERMISSION_DENIED
bridge/codex-* / host-runner / candidate-workspace / plan-workspace / task-bundle / provider-probe(同 v0.8.1)
bridge/install-macos.mjs    provider-neutral:不再强制 Claude CLI;Node ^20.19.0||>=22.12.0(SDK engines)
bridge/test/             206 pass（新增:copilot-runtime 18 + copilot-adapter 16 + fake-copilot-sdk 注入;
                         npm test 改为 `node --test test/*.test.mjs` —— 旧 `test/` 目录参数会把 fake 服务器当测试文件跑致 hang）
```

## 4. 可运行检查（结果 2026-07-23）

```text
cd bridge && npm test                     # 206 pass / 0 fail / ~30s
extension/*.js node --check               # 全绿
node -e "JSON.parse(manifest)"            # manifest 合法（version 0.8.2）
```

`copilot-adapter.test` / `copilot-runtime.test`：candidate-ready 带 `provider=='github_copilot'`+`provider_runtime`+`version_label=='1.1'`；plan-ready 带 `plan_sha256`+`provider_runtime`；plan run 不产 candidate/sibling；越权工具（bash/task/web_fetch/越界写）被 pre-tool deny 且归因 PERMISSION_DENIED；runtime 不一致 → RUNTIME_CHANGED；probe 输出不含 CLI 路径/session/login。全部用 `test/fake-copilot-sdk.mjs` 注入，**不触真实账号/网络**。

**真实 Copilot smoke 状态：未验证。** 本机无授权 Copilot 权益时不得声称已验证；mock 通过 ≠ 真实可用（SDK↔本机 CLI 版本兼容、auth 流程、真实工具名均需真机确认）。

## 5. 当前工作树与已知限制

- **超时**：Copilot plan 3min / candidate 8min（sendAndWait 超时不中止 in-flight → 先 abort 再 disconnect/stop）；Codex/Claude 各 15min，Claude plan 3min。
- **Copilot 工具名是按 SDK fixture + copilot-cli changelog 核实的 allow-list**（view/edit/write/grep/glob…）；若未来 runtime 改名，session 会「无工具可用」而明确失败（COPILOT_RUN_FAILED），不会静默越权——真机 smoke 时需确认实际工具名。
- source 安全边界 = 不暴露路径 + 禁 shell + host 前后 hash + 失败拒绝注册；manifest 记失败 status（本地审计，不泄 UI）。Copilot COPILOT_HOME 放在 run workspace 围栏外（Agent 工具读不到自己的会话态）。
- run/plan record 存 metadata（candidate_uri/sha256/version_label/manifest_path/provider_runtime），无 prompt/comment/HTML/stdout/session ID；无 promote/overwrite-source/auto-accept。
- **plan 按钮前端仍隐去**：后端三家 plan-first 全链路就绪（plan_sha256 闭环已修），UI 待细化后放出。
- **landing/ 已 gitignore**：agents.html 已加 Copilot 段落（本地改好，**待用户重新部署** www.deuce.monster/htmlgenius/）。
- **CWS**：v0.8.1 已提交；v0.8.2 无新增权限（Copilot 复用 nativeMessaging），再次提交时商品详情补 Copilot 描述即可。

## 6. 下一个获授权施工包

- **真实 Copilot smoke**：有 Copilot 权益的 mac 上验证 §10 手动验收 7 项（local_cli/bundled 切换、未登录态、plan-only、runtime 一致性失败、UI 无回归）。
- **plan UI 细化**：把隐去的「先给我看修改计划」按新交互放出（三家后端已就绪）。
- **diff/review/promote（M5）**：source/candidate diff、越界变化告警、显式 promote。
