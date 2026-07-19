# HTML Genius 当前实现状态

> **用途：** 这是产品路线与实际仓库之间唯一的短事实层。施工 Agent 开始任何任务前必须阅读、验证并在完成后整体重写本文。
> **更新规则：** 不在文末追加“更新记录”；保留本结构，替换过期事实。控制在 150 行以内。
> **最后静态核对：** 2026-07-20（v0.7.2 评论任务选择 UI 完成后整体重写）。

## 1. 当前产品边界（不可由施工 Agent 擅自改变）

- HTML Genius 是 Chrome Side Panel 插件，本地优先；不提供托管 AI、统一 Token 或中心化对话服务。
- Agent 只使用用户本机已有登录态。只能新建 task，或续发 HTML Genius 自己创建并记录的 terminal session；不得列出、读取或注入外部正在运行的会话。
- Change Contract 是 Agent 的唯一任务输入；prompt 不能单独作为安全边界。
- source HTML 不可被自动覆盖。Agent 输出必须先成为 candidate artifact；版本关系、hash 和用户显式确认优先于便利性。
- 评论是讨论记录；是否进入一次编辑任务，由用户在任务选择步骤人工勾选。当前不做 AI 分类，也不持久化评论类型。

## 2. 已确认的实现基线

| 能力 | 状态 | 实际入口 / 证据 |
|---|---|---|
| v0.6.1 Change Contract | 已存在 | `extension/change-contract.js`（`buildTask/validateDraft/getRoots/renderPrompt/serialize`）；`sidepanel.js` 调用；Spec `2026-07-18-v0.6.1-change-contract-spec.md`。 |
| v0.6.2 artifact version/reconciliation | 已存在 | `extension/artifact-version.js`；`content-script.js` 的 `artifact-update-ready`/`new_artifact` 消费（`handleArtifactUpdateReady`）；Spec `2026-07-18-v0.6.2-artifact-version-reconciliation-plan.md`。 |
| v0.7.1 Claude handoff | 已存在 | `bridge/claude-cli.mjs`+`task-bundle.mjs`+`host.mjs`+`host-runner.mjs`；`background.js` 的 `bridge-start`(provider `claude_code_cli`)+`bridge-query-session`；`sidepanel.js` 的 bridge 区；host 名 `com.htmlgenius.local_bridge`；运行说明 `docs/LOCAL_BRIDGE.md`。本版只确认任务到达，不写 HTML（acknowledgement-only）。 |
| 评论 → 任务选择 UI | 已存在 | `extension/sidepanel.{html,css,js}` 的 `#contract-sheet[data-step="select"|"compose"]` + 状态机 `_contractStep`/`_selectedContractRootIds`；入口 `#export-btn`→`openContractSelector`；测试页 `extension/comment-task-selection-test.html`；Spec `2026-07-20-v0.7.1-comment-task-selection-ui-spec.md`；视觉参考 `ui-mockups-v0.7.1/change-contract-agent-flow.html`；截图 `docs/screenshots-v0.7.2/{A-inbox,B-select,C-compose}.png`。 |
| candidate execution / review-promote | 未实施 | 只在 Night Pack A 既定边界内开始；见 §6。 |

## 3. 关键代码地图（每次施工 Preflight 复核）

```text
extension/sidepanel.html      评论视图、Contract sheet(data-step=select|compose)、A 底部 CTA
extension/sidepanel.js        renderCards / openContractSelector / renderSelectStep / gotoComposeStep
                              gotoSelectStep / closeContract / getContractDraft(读 _selectedContractRootIds)
                              refreshSelectionBeforeSubmit / copyContract(async) / startBridgeRun / bridge 状态
extension/sidepanel.css       select-card/contract-count/contract-notice/tip+bubble/task-summary/固定底栏/overflow-x:hidden
extension/i18n.js             zh/en/ja：taskSelect.*、contract.backToSelect/brief.*/preserve.*、四模式新文案
extension/change-contract.js  纯任务构建、校验、Prompt/JSON 序列化（schema 未改，rootIds:string[] 承接多选）
extension/content-script.js   get-export / artifact-update-ready(new_artifact 消费) / 打开与重锚
extension/artifact-version.js logical document、version / hash 协议
extension/background.js       bridge-start 校验 + Native Host 路由(acknowledgement)；candidate-ready 路径待 Night Pack A 接入
bridge/claude-cli.mjs         固定 argv(spawn shell:false)、auth status、--resume、UUID 校验、超时、stderr 截断
bridge/task-bundle.mjs        规范化 JSON + SHA-256 + 稳定 workspace + 0600/0700 + 固定交接 prompt
bridge/host.mjs / host-runner  claude_handoff_start 编排(source 校验→bundle→auth→-p/--resume→完成事件)
bridge/test/                  node --test：native 帧/installer/task-bundle/claude-cli(真实 spawn+argv 注入)/编排/双校验
extension/comment-task-selection-test.html  评论选择流浏览器测试(mock chrome API；T1–T11 断言)
```

若代码已重构，施工 Agent 必须记录等价入口，不得为迎合本文搬动架构。

## 4. 可运行检查（开始和结束都执行）

已运行命令与结果（2026-07-20，macOS，Node 20）：

```text
git diff --check                                  # 无 whitespace 错误
cd bridge && node --test test/                    # 55 pass / 0 fail
tests/test_undo_history.js                        # 29 pass / 0 fail
# 浏览器测试页(jsdom + 注入 crypto/indexedDB/fetch 后驱动，document.title=PASS)
extension/buildprompt-test.html                   # PASS
extension/change-contract-test.html               # PASS
extension/apply-delta-test.html                   # PASS
extension/sync-test.html                          # PASS
extension/login-test.html                         # PASS
extension/artifact-storage-test.html              # PASS
extension/artifact-version-test.html              # PASS
extension/version-test.html                       # PASS
extension/remote-store-test.html                  # PASS
extension/comment-task-selection-test.html        # PASS (T1–T11 全过)
# 选择流三态截图(puppeteer headful, 390px)：docs/screenshots-v0.7.2/{A-inbox,B-select,C-compose}.png
```

`comment-task-selection-test.html` 断言覆盖 spec §6：初始全选 getRoots；取消后 `source.root_annotation_ids` 精确相等；reply 不占 checkbox/不计 N；stale 过滤；M=0 禁用继续；关闭清空临时 Set；复制 Prompt/JSON 不含未选/stale；`buildTask` 与 v0.6.1 schema 一致。

## 5. 当前工作树与已知限制

- v0.7.1 的 Claude CLI 使用只读工具，是“任务交接”而非“执行编辑”；candidate execution 需新增受控 Write 路径（Night Pack A Phase 3 放行 Read,Glob,Grep,Write，仍禁 Bash/Edit/网络/MCP）。
- 当前无 candidate manifest、candidate lifecycle UI、source/candidate diff 或 promote 行为。
- 当前 background 的 `bridge-start` 走 acknowledgement 路径；`new_artifact` 消费者（`content-script.js` `handleArtifactUpdateReady`）仍在，等待 Night Pack A Phase 4 以受控 `candidate-ready`→`artifact-update-ready` 接入。
- 真实 Claude CLI smoke 未执行（夜间施工不消耗用户本地额度，且环境登录态不确定）；自动测试全部通过。
- 未做 AI 评论分类，未持久化评论类别；评论卡片交互未改。

## 6. 下一个获授权施工包

[`2026-07-20-night-pack-a-candidate-closed-loop-spec.md`](2026-07-20-night-pack-a-candidate-closed-loop-spec.md)

- **Phase 1（评论任务选择 UI / M3 收口）= 本次 v0.7.2 已完成，Gate 1 通过。**
- 待实施：Phase 2 candidate workspace 与不可覆盖协议（M4-A）→ Phase 3 Claude candidate 执行（M4-B）→ Phase 4 注册 candidate + 打开新 artifact + 评论重锚（M4-C）→ Phase 5 最小证据页（M5 数据准备）。
- 每个 Gate 失败即停止后续阶段；candidate 必须只写 `runs/<runId>/candidate.html` 并由 host 复制到 source 同级 sibling，永不覆盖 source。
