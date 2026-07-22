# HTML Genius 当前实现状态

> **用途：** 产品路线与实际仓库之间唯一的短事实层。施工 Agent 开始前必读、验证并完成后整体重写。
> **更新规则：** 不追加“更新记录”；保留结构，替换过期事实；≤150 行。
> **最后静态核对：** 2026-07-22（v0.8.1:Codex App Server + plan-first bridge + provider probe + DB v5 + Mint 主题 + 版本号命名 + 终止/通知/per-tab；bridge 测试 152 通过）。

## 1. 当前产品边界（不可擅自改变）

- Chrome Side Panel MV3 插件，本地优先；无托管 AI、统一 Token 或中心化对话服务。
- Agent 只用用户本机登录态（Codex=ChatGPT.app 登录 / Claude Code=`~/.claude`）；只新建 task（session_mode=new），不列举/读取/注入外部运行中会话；禁 RPC：thread/list、thread/read、thread/fork、turn/steer、thread/inject_items。
- Change Contract 是唯一任务输入；prompt 不是安全边界。
- source HTML 永不自动覆盖：Agent 只写 workspace 内 candidate，host 校验后以**版本号 sibling**（`原名V1.N.html`）发布到 source 同级；版本关系/hash/用户确认优先于便利。
- 评论是讨论记录；是否进入任务由用户在选择步骤人工勾选；无 AI 分类、不持久化评论类型。
- 不向 UI 暴露 runtime 路径 / TeamID / schema 路径 / stderr / 完整命令体 / 思维链正文；hash 永不跨侧（host 原始字节 vs extension DOM 序列化）比较。

## 2. 已确认的实现基线

| 能力 | 状态 | 实际入口 / 证据 |
|---|---|---|
| Change Contract | 已存在 | `change-contract.js`（buildTask/getRoots/renderPrompt）；regenerate 已放开 brief（评论即输入）。 |
| artifact 协议 | 已存在 | `artifact-version.js`；`content-script.js` `handleArtifactUpdateReady`(new_artifact→linkArtifactUri+重锚)；basename 比 source_uri（容 realpath）。 |
| Claude Code handoff | 已存在 | `bridge/claude-cli.mjs`（candidate:Read,Glob,Grep,Write,禁 Bash/Edit/网/MCP，shell:false，safe-mode，max-turns 24）；`host-runner.mjs` executeCandidateRun。 |
| **Codex App Server adapter** | **已就绪** | `bridge/codex-app-server-client.mjs`（newline JSON-RPC：initialize{clientInfo,protocolVersion:1,capabilities}→thread/start|resume→turn/start→turn/completed；extractThreadId 取 `result.thread.id`；中途 notification→安全 stream）；`bridge/codex-adapter.mjs` executeCodexCandidateRun/PlanRun；App 发现+codesign TeamID 校验（`discoverAppRuntime`，仅 com.openai.codex，不搜 PATH）。 |
| **plan-first bridge** | **后端就绪，前端隐去** | `bridge/plan-workspace.mjs`+`provider-probe.mjs`+`host-runner.mjs` executePlanRun+`background.js` §5.4 plan 校验/approved_plan 注入；DB v5 `bridge_plans` store；`#contract-plan` 按钮 hidden，逻辑保留待细化。 |
| candidate 闭环 + 版本号 | 已存在 | `candidate-workspace.mjs` nextCandidateVersionLabel（文档级持久计数 `.htmlgenius-bridge/candidate-versions.json`，标签 1.N）→ siblingCandidateName `原名V1.N.html`；candidate-ready 带 `version_label`。 |
| Mint 主题 | 已存在 | `sidepanel.css` `:root` mint token + `--on-cta`；`content-script.js` 页面级 hg-* mint + 放大刷新弹窗 + 加深蒙版。 |
| 终止 / 通知 / per-tab | 已存在 | `background.js` bridge-cancel（USER_CANCELLED）+ notifyCandidateReady+playDing（offscreen 合成"叮"）+ focusOrCreateCandidateTab（去重）；`sidepanel.js` _tabStates 快照/恢复 + syncRunStateFromBackground。 |

## 3. 关键代码地图

```text
extension/sidepanel.js   契约状态机 + dispatchBridgeRun + syncRunStateFromBackground + _tabStates
                         状态栏(expandBridgeDetail 三态/限高 + handleStream + 计时器/历史) + 候选版本指示
extension/background.js  bridge-start + completeCandidate(透传 version_label) + bridge-cancel
                         cancelRun + focusOrCreateCandidateTab + notifyCandidateReady/playDing(ensureOffscreen)
                         provider probe + §5.4 plan 校验；bridge-query-active-run(+provider+run_kind)
extension/content-script hg-modal 刷新弹窗(mint) + handleArtifactUpdateReady(new_artifact 受控消费)
extension/offscreen.html js Web Audio 合成"叮"；manifest permissions 含 notifications+offscreen
bridge/codex-app-server-client.mjs  CodexAppServerClient.runTask(序列写死,禁 forbidden method,turn 超时 15min)
bridge/codex-adapter.mjs  executeCodexCandidateRun/PlanRun(makeStreamer delta 节流 120ms)
bridge/host-runner.mjs   executeCandidateRun(Claude,15min)/executePlanRun(3min)；version_label
bridge/candidate-workspace  nextCandidateVersionLabel + publishSiblingCandidate(versionLabel)
bridge/plan-workspace / provider-probe / task-bundle(plan prompt+approvedPlanPreamble)
bridge/test/             152 pass（含 codex-app-server-client/adapter/plan-run、candidate version_label 断言）
```

## 4. 可运行检查（结果 2026-07-22）

```text
cd bridge && node --test test/            # 152 pass / 0 fail（provider-probe 真实探测项依赖本机环境）
extension/*.js node --check               # 全绿
node -e "JSON.parse(manifest)"            # manifest 合法
```

`candidate-run.test` / `codex-adapter.test`：candidate-ready 带 `version_label=="1.1"`、sibling 命名 `reportV1.1.html`；失败/mutated 不发 candidate-ready。`codex-app-server-client.test`：extractThreadId(result.thread.id)、initialize params、forbidden method 不发、turn/completed 收尾。真实 Codex/Claude smoke 由用户在本机验证（自动化用 fake client / fake CLI 覆盖）。

## 5. 当前工作树与已知限制

- **Codex 15 分钟、Claude candidate 15 分钟、Claude plan 3 分钟**超时；turn 超时诊断区分「曾有输出(慢)/无输出(挂起)」。真挂起用户可「终止任务」中止。
- source 安全边界 = 不暴露路径 + 禁 shell + host 前后 hash + 失败拒绝注册。candidate manifest 记 `codex_timed_out` 等失败 status（本地审计，不泄 UI）。
- run record 存 metadata（candidate_uri/candidate_sha256/version_label/manifest_path），无 prompt/comment/HTML/stdout；无 promote/overwrite-source/auto-accept。
- **多 tab**：sidepanel 单实例，per-tab 靠 _tabStates 快照/恢复 + background _runsByTab 并行 run；切回 tab 时 reconcileTabRun/syncRunStateFromBackground 据后台终态校正。
- **offscreen 提示音**：MV3 SW 无 Web Audio → offscreen 文档合成"叮"；首响少数情况被自动播放策略拦（extension origin 通常放行，已 ctx.resume 兜底）。
- **plan 按钮前端隐去**：后端 plan-first 全链路就绪，UI 待细化后再放出。
- **samples/.htmlgenius-bridge/** 历史误入库的运行时产物未清理（新产物已 .gitignore）；不影响功能。

## 6. 下一个获授权施工包

- **M4 收尾**：Demo 同步、真实 smoke 标注（Codex + Claude）、store 提交材料更新、推 main 后归档分支（本提交已合并 main + 删分支）。
- **plan UI 细化**：把隐去的「先给我看修改计划」按新交互放出（后端已就绪）。
- **diff/review/promote（M5）**：source/candidate diff、越界变化告警、显式 promote（candidate 生命周期/hash/version 已稳定，可作输入）。
