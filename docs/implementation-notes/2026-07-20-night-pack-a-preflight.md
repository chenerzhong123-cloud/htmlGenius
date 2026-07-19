# Night Pack A · Preflight（2026-07-20）

> 施工前对齐文档。仅记录实际入口、baseline 结果、Spec 与代码差异、等价适配；≤80 行。

## 实际入口（rg 复核）

- 评论选择流：`extension/sidepanel.js` → `openContractSelector` / `renderSelectStep` / `gotoComposeStep` / `gotoSelectStep` / `closeContract`；状态 `_contractStep`(closed|select|compose) + `_selectedContractRootIds`(Set)；`getContractDraft().rootIds` 读 `orderedSelectedRootIds()`；DOM `#contract-sheet[data-step]`、`#export-btn`、`#contract-select-list`、`#contract-select-continue`。Phase 1 已实现并通过 Gate 1。
- 任务构建：`extension/change-contract.js` → `getRoots` / `validateDraft` / `buildTask` / `renderPrompt` / `serialize`（schema 未改，`rootIds:string[]` 承接多选）。
- Bridge：`extension/background.js` → `bridge-start`(provider `claude_code_cli`) 校验后 `connectNative(NATIVE_HOST=com.htmlgenius.local_bridge)` 发 `claude_handoff_start`；`bridge/host.mjs`→`bridge/host-runner.mjs` 的 `executeHandoff` 编排；`bridge/claude-cli.mjs` 的 `buildHandoffArgv`（当前固定 `--allowed-tools Read,Glob,Grep`，`--disallowed-tools ...Write...`，`shell:false`）。
- artifact 协议（v0.6.2 消费者仍在）：`extension/content-script.js` `handleArtifactUpdateReady`（接受 `source:"bridge"` + `result_kind:"new_artifact"`→`linkArtifactUri`+`applyRestoredArtifact`+`artifact-reload-requested`）；`background.js` 当前 **未** 调用 `forwardArtifactUpdateToTab`（v0.7.1 acknowledgement 路径）。

## baseline 命令与结果（全绿）

```text
cd bridge && node --test test/      # 55 pass / 0 fail
tests/test_undo_history.js          # 29 pass
# 浏览器测试页(jsdom 注入 crypto/indexedDB/fetch)：
buildprompt / change-contract / apply-delta / sync / login / remote-store /
artifact-storage / artifact-version / version / comment-task-selection  全部 PASS
git diff --check                    # clean
```

## Spec 与当前代码差异 → 等价适配（仅实现细节，不改产品契约）

1. **`run_kind` 缺失**（spec §4.1）：现 `bridge-start` 无 `run_kind`。适配：background 读取 `msg.run_kind`（缺省 `handoff`），`restructure` 拒 `candidate`；host 透传，按 `run_kind` 分支 argv/prompt/completion。
2. **完成事件结构**（spec §5.1）：现 host 发 `bridge_completed`(ack, 仅 session_id/task_sha256)。适配：candidate run 发 `candidate-ready`{run_id,task_sha256,logical_document_id,source_uri,source_sha256_before,candidate_uri,candidate_sha256,manifest_path}；background 比对自存 run metadata 后才发受控 `artifact-update-ready`/`new_artifact`。
3. **candidate workspace**（spec §3）：现 workspace 仅 task bundle。适配：新增 `bridge/candidate-workspace.mjs`：`runs/<runId>/`（0700）写 `source.html`(0400 snapshot)+`candidate-manifest.json`(0600)；成功后原子复制 sibling `<sourceStem>--htmlgenius-<runId>.candidate.html`。
4. **Write 权限**（spec §4.2）：现 argv 禁 Write。适配：candidate run 的 `--allowed-tools Read,Glob,Grep,Write`，仍禁 Bash/Edit/网络/MCP；cwd=`runs/<runId>`。
5. **固定执行前言**（spec §4.3）：现 `buildHandoffPrompt` 是 ack 前言。适配：candidate 用执行前言（只读 source.html+task，只写 candidate.html，不改 source/shell/网络）。
6. **v0.6.2 消费者复用**：`handleArtifactUpdateReady` 已支持 `new_artifact`，**无需改 content-script 锚点逻辑**；background 新增 `candidate-ready`→校验→`forwardArtifactUpdateToTab` 即可。

## Gate 0 判定：通过

baseline 无新增失败；真实入口已识别；`CURRENT_IMPLEMENTATION_STATE.md` 刚整体重写、未失真；工作树已提交（v0.7.2 已入 main），无未知改动需保留。Phase 1（Gate 1）已随 v0.7.2 完成。

> 停止条件自查：v0.7.1 handoff 可运行（ack 路径完整）、v0.6.2 受控 `new_artifact` 消费者存在、本适配不降低 source 安全边界（snapshot+前后 hash+失败拒绝注册）、不改 task schema。继续进入 Phase 2。

---

## 最终 Reconciliation（施工后）

**按原样完成：** Phase 1 选择 UI（Gate 1，v0.7.2）；Phase 2 candidate workspace + 不可覆盖协议（Gate 2）；Phase 3 candidate 执行的固定 argv（candidate 放行 Write、仍禁 Bash/Edit/网/MCP、shell:false）+ 执行前言 + 180s 级超时（Gate 3 自动部分）；Phase 4 `candidate-ready`→逐字段比对→受控 `artifact-update-ready`/`new_artifact`（复用 v0.6.2 `handleArtifactUpdateReady`）→`tabs.update` 打开 candidate→重锚→最小只读成功态；Phase 5 持久证据（仅 run metadata：`candidate_uri/candidate_sha256/manifest_path`，无 prompt/comment/candidate HTML；无 promote/overwrite-source/auto-accept 路径）。

**等价适配（实现细节，不改产品契约）：**
1. task bundle 除写入 workspace 外，复制一份进 `runs/<runId>/`，使执行前言「当前目录的 task-<run-id>.*」成立；规范 bundle 仍在 workspace。
2. continue 的 candidate run 用**新** `runs/<newRunId>/` + 新 snapshot；`--resume` 仅延续对话记忆，当前 prompt 为权威（避免跨 cwd 续发使旧相对路径失效）。
3. `resolveSourcePath` 先 `lstat` 输入路径再 `realpath`，以捕获 symlink 逃逸（测试中暴露并修复的真实 bug）。
4. `run_kind` 由 sidepanel→background→host 透传；`restructure` 在 background 与 host 两处均拒 `candidate`。

**未完成 / 待用户：**
- Gate 3.5 真实 Claude CLI smoke **未在夜间执行**（不消耗本地额度、登录态不确定）；自动测试全过，标记为「待用户手动验证」。
- Gate 4 全跨进程手工测试：各组件已自动化验证（`handleArtifactUpdateReady` 经 artifact-version-test 覆盖；background 校验为代码级），端到端手工用例待用户。
- M5（source/candidate diff、越界告警、用户显式 promote）**故意不在本包**（spec §9）。
