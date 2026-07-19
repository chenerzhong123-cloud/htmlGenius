# HTML Genius 当前实现状态

> **用途：** 产品路线与实际仓库之间唯一的短事实层。施工 Agent 开始前必读、验证并完成后整体重写。
> **更新规则：** 不追加“更新记录”；保留结构，替换过期事实；≤150 行。
> **最后静态核对：** 2026-07-20（Night Pack A 完成后整体重写；含 v0.7.2 选择流 + candidate 闭环）。

## 1. 当前产品边界（不可擅自改变）

- Chrome Side Panel 插件，本地优先；无托管 AI、统一 Token 或中心化对话服务。
- Agent 只用用户本机登录态；只新建 task 或续发 HTML Genius 自建的 terminal session；不列举/读取/注入外部运行中会话。
- Change Contract 是唯一任务输入；prompt 不是安全边界。
- source HTML 永不自动覆盖：Claude 只写 workspace 内 candidate，host 校验后复制到 source 同级 sibling；版本关系/hash/用户确认优先于便利。
- 评论是讨论记录；是否进入任务由用户在选择步骤人工勾选；无 AI 分类、不持久化评论类型。

## 2. 已确认的实现基线

| 能力 | 状态 | 实际入口 / 证据 |
|---|---|---|
| v0.6.1 Change Contract | 已存在 | `change-contract.js`（buildTask/getRoots/renderPrompt/serialize）；schema 未改。 |
| v0.6.2 artifact 协议 | 已存在 | `artifact-version.js`；`content-script.js` `handleArtifactUpdateReady`(overwrite/new_artifact→linkArtifactUri+重锚)。 |
| v0.7.1 Claude handoff | 已存在 | `bridge/{claude-cli,task-bundle,host,host-runner}.mjs` ack 路径；host 名 `com.htmlgenius.local_bridge`。 |
| 评论→任务选择 UI | 已存在 | `sidepanel.js` `openContractSelector`/`renderSelectStep`(嵌套回复树,root+reply 均可勾选)/`_selectedNodeIds`/`data-step`；compose 按 mockup 还原=step1 目标+step2 **3 张 scope 卡**+step3 执行 seg(直接生成/先看方案=内部 restructure,mode 由 scope+exec 派生,schema 仍单值)+preserve `<details>`+底栏 mockup send-group 菜单；测试 `comment-task-selection-test.html`(T1–T9)；截图 `docs/screenshots-v0.7.2/`。反馈轮已修：CTA `?` 气泡向上展开、流程中新建评论显示醒目阻断提示、跨上下文草稿聚焦降级(见 §5)。 |
| candidate 闭环(Night Pack A) | 已存在 | `bridge/candidate-workspace.mjs`(snapshot 0400/manifest 0600/sibling 原子/形态校验/路径安全)；`host-runner.mjs` `executeCandidateRun`；`claude-cli.mjs` `buildClaudeArgv`(candidate 放行 Write)；`background.js` `completeCandidate`(逐字段比对→new_artifact→navigate)；`storage.js` `getLatestCompletedCandidateRun`；`sidepanel.js` 只读成功态+持久证据。 |
| M5 diff/review/promote | 未实施 | 下一包唯一方向；不在 candidate 稳定前混入。 |

## 3. 关键代码地图

```text
extension/sidepanel.js   选择流 + startBridgeRun(run_kind:"candidate") + showCandidateResult
                         loadCandidateEvidence + fillCandidateEvidence/AnchorStats + candidate-open/back(只导航)
extension/background.js  bridge-start(run_kind 透传) + onHostMessage(candidate-ready) + completeCandidate
                         bridge-query-latest-candidate(只回 run metadata)
extension/content-script handleArtifactUpdateReady(new_artifact 受控消费,复用)
extension/storage.js     getLatestCompletedCandidateRun(bridge_runs 索引过滤,无敏感内容)
bridge/candidate-workspace.mjs  resolveSourcePath(lstat→realpath) / prepareCandidateRun / validateCandidate
                         publishSiblingCandidate / writeManifest / quarantineCandidate
bridge/host-runner.mjs   executeHandoff(ack) + executeCandidateRun(snapshot→auth→claude→validate→sibling→manifest→candidate-ready)
bridge/claude-cli.mjs    buildClaudeArgv(candidate:Read,Glob,Grep,Write;handoff:只读) + runHandoff/resumeHandoff(runKind)
bridge/task-bundle.mjs   buildHandoffPrompt(ack) + buildCandidatePrompt(执行前言+renderPrompt)
bridge/test/             candidate-workspace.test(6) + candidate-run.test(7,含真实 spawn argv)+ 原 55
```

## 4. 可运行检查（结果 2026-07-20 全绿）

```text
cd bridge && node --test test/        # 68 pass / 0 fail
tests/test_undo_history.js            # 29 pass
# 浏览器页(jsdom 注入 crypto/indexedDB/fetch)：buildprompt / change-contract / apply-delta /
sync / login / remote-store / artifact-storage / artifact-version / version / comment-task-selection  全 PASS
# Gate5 证据持久化(jsdom 驱动 sidepanel)：/tmp evidence-check 6/6 PASS
git diff --check                      # clean
```

`comment-task-selection-test.html` 覆盖 spec §6（初始全选/取消后 rootIds 精确相等/reply 不勾选/stale 过滤/M=0 禁用/关闭清空/复制范围/buildTask schema）。`candidate-run.test.mjs` 覆盖 Gate 3（fake 写 candidate→sibling+ready manifest+candidate-ready；写 Markdown/未写→拒绝；source 运行期被改→SOURCE_MUTATED 不采用；真实 spawn argv：candidate 放行 Write、注入串不成为独立 flag）。

## 5. 当前工作树与已知限制

- **真实 Claude CLI smoke 未在夜间执行**（Gate 3.5 标「待用户手动验证」）；自动测试全过。Gate 4 端到端手工用例各组件已自动化验证，完整跨进程用例待用户。
- source 安全边界 = 不向 Claude 暴露 source 路径 + 禁 shell + host 前后 hash + 失败拒绝注册（非「模型绝不可能写 source」虚假承诺）。continue candidate 用新 snapshot，`--resume` 仅延续对话记忆。
- run record 只存 metadata（candidate_uri/candidate_sha256/manifest_path），无 prompt/comment/candidate HTML/Claude stdout；无 promote/overwrite-source/auto-accept 路径。
- 无 AI 评论分类、无评论类别持久化；评论卡片交互未改。
- **跨上下文聚焦限制（Chrome side panel）**：在页面点「评论」触发的草稿，无法用程序在侧栏合成「用户手势」，故 caret 常不立即出现。已降级为：草稿输入框 `.ready` 脉冲视觉提示 + 用户指针/焦点首次到达侧栏时自动聚焦草稿（一次）。零额外点击的自动聚焦在该架构下不可达。
- **节点级选择**：`buildTask` 接受 `draft.selectedIds` 裁剪未选回复（未传则含全部后代，向后兼容）；`buildReplyTree(allAnnotations, rootIds, selectedIds)`。选择步骤计数 N/M 计 root+reply 全部 non-stale 节点。

## 6. 下一个获授权施工包

**M5**：source/candidate diff、修改范围审查、越界变化告警、用户显式 promote。candidate 生命周期/hash/artifact relation/anchor stats 已稳定，可作为 M5 输入；不得提前设计 diff UI 格式或混入 promote。
