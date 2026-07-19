# Night Pack A：评论 → Claude Candidate → 可验证新版本

> 日期：2026-07-20  
> 预计连续施工：5–8 小时；允许一个 Agent 顺序完成，但**每个 gate 失败即停止后续阶段**。  
> 前置阅读：[当前实现状态](CURRENT_IMPLEMENTATION_STATE.md)、[v0.7.1 评论任务选择 UI](2026-07-20-v0.7.1-comment-task-selection-ui-spec.md)、[v0.7.1 Claude handoff](2026-07-19-v0.7.1-claude-code-handoff-spec.md)、[v0.6.2 artifact 协议](2026-07-18-v0.6.2-artifact-version-reconciliation-plan.md)。  
> 视觉参考：[Side Panel 静态 Demo](ui-mockups-v0.7.1/change-contract-agent-flow.html)。

## 0. 夜间施工的唯一目标

完成一个安全、可检查的本地闭环：用户选择评论并发送给 Claude Code 后，Claude 产出**新的 candidate HTML**；扩展验证 source 未被改动，把 candidate 作为同一逻辑文档的新 artifact 打开并重新锚定评论。

```text
评论收件箱
  → 人工选择本次评论
  → Change Contract
  → 本机 Claude Code
  → candidate.html（不是 source）
  → source hash 校验
  → v0.6.2 new_artifact
  → 打开 candidate，报告评论重锚结果
```

这包的完成定义是“用户拥有一个可打开、可回退、来源可追溯的候选版本”，不是“模型看起来修改得不错”。

### 本包明确不做

- 不覆盖、替换、删除或静默保存 source HTML。
- 不做完整 visual diff、语义审查、自动接受或 promote；这些是下一包 M5。
- 不接 Codex、Copilot、MCP、Claude Desktop 或任意外部正在运行的会话。
- 不做 Agent 聊天记录、流式回答、后台队列、取消、审批转发、多人任务协作。
- 不改变评论自身的创建、回复、编辑、删除、定位或共享语义。
- 不接 AI 评论分类，不保存“澄清问题 / 修改建议”tag。

---

## 1. 施工协议：先对齐，再改代码

### 1.1 Phase 0 · Preflight（必须先完成，预计 20–35 分钟）

1. 阅读并核对 [`CURRENT_IMPLEMENTATION_STATE.md`](CURRENT_IMPLEMENTATION_STATE.md)。
2. 执行其中列出的 baseline commands；不得通过 `git reset`、`git checkout --`、删除未知文件来“清理”工作树。
3. 用 `rg` 找到实际的：
   - 评论列表 / `#export-btn` / Change Contract sheet；
   - `ChangeContract.buildTask()`；
   - `bridge-start`、Native Host 输入输出 message；
   - task bundle、Claude argv、session store；
   - `artifact-update-ready` / `new_artifact` 的调用与校验入口。
4. 新建 `docs/implementation-notes/2026-07-20-night-pack-a-preflight.md`，不超过 80 行，写清：
   - 实际入口文件与函数名；
   - baseline 测试命令及结果；
   - 本 Spec 与当前代码的任何差异；
   - 打算如何等价适配。
5. 只有以下差异可自行适配：文件名、函数名、DOM id、测试命令等实现细节不同，但不影响产品契约。
6. 遇到以下任一情况必须停止并只提交 Preflight 报告：现有 v0.7.1 handoff 不可运行；v0.6.2 无法提供受控 `new_artifact`；实现需要降低 source 安全边界；或需要改变任务 schema 才能继续。

**规则：** 本文的产品边界优先于旧代码；实际代码入口优先于本文假设的文件名。不要为了让代码“长得像 Spec”而重构无关模块。

### 1.2 Gate 0

必须同时满足才进入 Phase 1：

- baseline 无新增失败；
- 已识别真实入口；
- `CURRENT_IMPLEMENTATION_STATE.md` 没有被发现为严重失真；
- 工作树未知改动已在 Preflight 记录并被保留。

---

## 2. Phase 1 · 评论任务选择 UI（M3 收口）

按 [`v0.7.1 评论任务选择 UI Spec`](2026-07-20-v0.7.1-comment-task-selection-ui-spec.md) 完整实现。该文是本阶段唯一 UI 行为来源，不在本文重复一套文案或状态机。

本阶段特别检查：

1. Side Panel 默认仍是完整评论收件箱，评论超过首屏只纵向滚动；底部 `整理评论，创建编辑任务` 固定但不截断评论。
2. 用户主动进入选择步骤后，才出现 checkbox；顶层 non-stale comments 默认全选，用户可取消本次不应发送的评论。
3. replies 不单独勾选，但随被选 root 的完整回复树进入 Change Contract。
4. 无自动标签、分类、筛选或 AI 判断；不改评论卡片交互。
5. 所有新 UI 都禁止横向滚动；窄 Side Panel 下长文本换行，tooltip / 菜单向内展开。
6. C（Change Contract）返回 B 时保留本轮选择和表单 draft；关闭或 Esc 时清空临时状态。

### Gate 1

- 选中的 root IDs 与 `ChangeContract.buildTask()` 输出严格相等；未选 root/reply 不出现在 JSON 或 prompt。
- stale root 永不出现在选择器。
- zh/en/ja 均无缺失 i18n key。
- 既有评论创建、回复、编辑、删除、定位不回归。

Gate 1 不通过时，不开始 candidate execution；因为错误 task 输入会让后面的文件安全测试失去意义。

---

## 3. Phase 2 · Candidate 工作区与不可覆盖协议（M4-A）

### 3.1 设计决定

**Claude 不直接读取或写入真实 source 路径。** Native Host 在自己的稳定 workspace 内制作 source snapshot，Claude 只读取 snapshot 并写 workspace 内的 candidate；Host 验证后才把 candidate 复制到 source 同级目录。

这比“prompt 里说不要改 source”可靠得多，也避免把真实 source 父目录以 `--add-dir` 暴露给 Claude。

### 3.2 目录和命名（必须稳定）

设：

- `sourcePath`：当前受管理的单文件本地 HTML 的 canonical absolute path；
- `logicalDocumentId`：v0.6.2 逻辑文档 ID；
- `runId`：host 生成的 UUID 或不可预测、文件名安全的 ID；
- `sourceStem`：source filename 去掉 `.html` / `.htm` 后的 basename。

```text
<source-parent>/
  report.html                                      # source：永远不由 Claude / host 覆盖
  report--htmlgenius-<run-id>.candidate.html       # 仅成功后由 host 创建
  .htmlgenius-bridge/claude/<logicalDocumentId>/
    task-<runId>.json                              # 0600，完整 Change Contract
    task-<runId>.md                                # 0600，人读任务说明
    runs/<runId>/                                  # 0700，Claude stable cwd
      source.html                                  # 0400，host 从 source 复制的 snapshot
      candidate.html                               # Claude 唯一预期输出
      candidate-manifest.json                      # 0600，host 写入
```

`candidate.html` 成功后由 host 以原子方式复制/rename 到 source 同级的 `report--htmlgenius-<runId>.candidate.html`。放在同级目录的原因是单文件 HTML 的相对 CSS、图片、脚本引用仍从原来的相对位置解析。

禁止把 candidate 放到 `~/Library`、扩展 IndexedDB、远端服务器，或改写 source sibling 的任何其它文件。

### 3.3 Candidate manifest v1

`candidate-manifest.json` 是 host 写入的证据，不接受 Claude 自己的 JSON 作为可信来源：

```jsonc
{
  "schema_version": 1,
  "kind": "htmlgenius_candidate_manifest",
  "run_id": "...",
  "logical_document_id": "...",
  "provider": "claude_code_cli",
  "source": {
    "path": "/absolute/report.html",
    "sha256_before": "...",
    "sha256_after": "..."
  },
  "candidate": {
    "workspace_path": "/.../runs/<runId>/candidate.html",
    "result_path": "/.../report--htmlgenius-<runId>.candidate.html",
    "sha256": "...",
    "byte_length": 1234
  },
  "change_contract_sha256": "...",
  "session": { "id": "...", "ownership": "htmlgenius" },
  "created_at": "ISO-8601",
  "status": "ready"
}
```

失败时也写 manifest（若目录已创建），但 `status` 只能是：`source_changed_before_start`、`source_changed_during_run`、`candidate_missing`、`candidate_invalid_html`、`claude_failed`、`timed_out`。失败 manifest 不得包含 Claude stdout、思维链或完整评论。

### 3.4 Host 不变量

1. 只接受受管理的本地单文件 HTML；remote URL、目录 index、相对路径、不可读 source 一律拒绝。
2. 建立 snapshot 前计算 `source_sha256_before`；copy 后再计算 snapshot hash，必须相等。
3. Claude 运行前再次计算真实 source hash；不一致返回 `SOURCE_CHANGED_BEFORE_START`。
4. Claude 返回后再次计算真实 source hash；不一致返回 `SOURCE_MUTATED_DURING_CANDIDATE`，删除/隔离 workspace candidate，**不创建 sibling candidate、不调用 artifact 协议、不显示成功**。
5. candidate 必须存在、是普通文件、非 symlink、大小大于 0 且不超过合理上限（建议 source byte length 的 10 倍且不超过 10 MiB）。
6. candidate 必须以 UTF-8 可读，并有基本 HTML 形态：忽略前导空白后包含 `<!doctype html` 或 `<html`。这不是质量判断，只是阻止模型写出 Markdown / 错误文本。
7. 同名 candidate 已存在时不得覆盖；生成新的 runId，或返回冲突错误。
8. 所有文件操作拒绝 path traversal / symlink escape；使用 canonical realpath，目录权限保持 `0700`，敏感 bundle / manifest `0600`。

**重要限制：** 同一 OS 用户下，CLI 本身无法得到绝对不可绕过的文件系统沙箱。本设计的强边界是“不向 Claude 暴露 source 路径 + 禁止 shell + host 在前后验证 hash + 失败拒绝注册”，不是虚假的“模型绝不可能写 source”承诺。

### Gate 2

为 task bundle / host 添加 Node tests，至少覆盖：

- candidate 名称稳定且不覆盖现有文件；
- source snapshot 与 source hash 不一致即失败；
- source 在 run 前/后变化均不会生成 candidate；
- candidate 缺失、空文件、symlink、过大、Markdown 文本均拒绝；
- manifest 不含完整 prompt/comment/stdout；
- 路径含空格、中文、引号、`$()`、`..` 时不能逃逸目录或改变 argv。

---

## 4. Phase 3 · Claude Candidate 执行（M4-B）

### 4.1 Bridge message 语义

不要改 Change Contract JSON schema。通过 bridge request 新增明确的执行意图，例如：

```js
{
  type: "bridge-start",
  provider: "claude_code_cli",
  run_kind: "candidate", // 新增；v0.7.1 acknowledgement 可保留为 handoff
  tab_id: 123,
  session_mode: "new" | "continue",
  change_contract: task
}
```

`restructure` 永远是 plan-only：不允许 `run_kind: "candidate"`。其它可写 mode 只会创建 candidate，绝不写 source。

更新 Side Panel 的成功/失败状态，使用户理解：

- `正在让 Claude Code 生成候选版本…`
- `候选版本已生成，正在打开并重新定位评论…`
- `原文件在执行期间发生变化，候选版本未采用。`
- `Claude 未生成可用的 HTML 候选版本。`

不展示 CLI 原始回复、完整 stdout、思维链或历史会话。

### 4.2 Claude 运行方式

- 继续使用 `claude -p --output-format json`、固定 `spawn(..., { shell: false })`、`--safe-mode`、禁用 hooks/plugins/MCP/slash commands 的 v0.7.1 安全模型。
- 仅为 candidate run 放行 `Read,Glob,Grep,Write`；继续禁止 `Bash`、`Edit`、网络工具、MCP 和用户自定义 plugin/hook。不要使用 `--dangerously-skip-permissions` 或任意 shell。
- cwd 固定为 `<bridge workspace>/runs/<runId>`；prompt 只允许读 `source.html`、任务 bundle，并且只允许写 `candidate.html`。
- 新 task / 续发都只能使用 HTML Genius 记录的 session。继续 session 前仍检查 workspace 与 ownership；不列举、不搜索用户其它 session。
- 设置明确超时（建议 180 秒，实际值写入状态页）；超时 kill 子进程并返回 `TIMED_OUT`，不注册 candidate。

### 4.3 固定 Prompt 语义

Host 从 Change Contract 渲染任务，但必须在前面加不可省略的执行前言：

```text
你在 HTML Genius 的受控候选工作区中执行任务。

- 只读取当前目录的 source.html 和 task-<run-id>.md / .json。
- 只把最终、完整、可直接打开的 HTML 写入当前目录的 candidate.html。
- 不要修改 source.html、task 文件、其它文件；不要使用 shell、网络、MCP 或浏览器。
- 不要输出 Markdown 文件、diff、解释或多个候选文件来替代 candidate.html。
- 严格遵守下方 Change Contract；它未允许的内容不得改动。
- 目标无法唯一定位时，不要猜测；保留 source 中对应内容，并在最终简短文本中说明。
```

Prompt 是协作约束，host hash / manifest / artifact protocol 才是可信执行边界。

### Gate 3

使用 fake Claude 和一次手工真实 CLI smoke 测试证明：

1. fake CLI 收到的 argv 没有用户内容成为 flag/command/cwd；
2. fake CLI 写 `candidate.html` 后 host 产出 sibling candidate + ready manifest；
3. fake CLI 只输出文字或写 Markdown 时被拒绝；
4. source 被外部改动时 candidate 不被采用；
5. 真实 Claude 只在用户愿意消耗本地额度的手工 smoke 中运行一次；它成功生成 candidate 才算 M4-B 完成。

若真实 smoke 因登录/额度不可运行，代码可保留为“自动测试通过、真实 smoke 待用户验证”，但不要宣称 candidate 已端到端验证。

---

## 5. Phase 4 · 注册 Candidate、打开新 Artifact 与评论重锚（M4-C）

### 5.1 事件链

Host 在 manifest `ready` 后向 background 发送最小 completion：

```js
{
  type: "candidate-ready",
  run_id,
  task_sha256,
  logical_document_id,
  source_uri,
  source_sha256_before,
  candidate_uri,
  candidate_sha256,
  manifest_path
}
```

background 必须比对它自己保存的 run metadata（至少 run_id、task hash、tab/document、source hash），任一不一致即拒绝。background 不保存完整 prompt、comment、candidate HTML 或 Claude stdout。

比对通过后，background 只向原 tab 的 content script 发受控消息：

```js
{
  source: "bridge",
  result_kind: "new_artifact",
  result_uri: candidate_uri,
  base_artifact_hash: source_sha256_before,
  run_id,
  task_sha256
}
```

复用 v0.6.2 的 `artifact-update-ready` / `new_artifact` 消费者；不要另写第二套批注迁移逻辑。content script 必须继续按现有协议确认 base hash、一致的 logical document relation、受控 URI，之后才打开新 URI 并重新锚定评论。

### 5.2 UI 成功态（最小、只读）

本包不做完整审查页，只在 Side Panel 的 Contract / result 区展示可验证事实：

- `候选版本已生成`；
- `原文件未被修改`；
- `已重新定位 X/Y 条评论，Z 条需要检查`；
- `打开候选版本`（若自动打开受浏览器限制，则改为明确用户点击）；
- `返回原文件`（只在已知 source URI 时显示）。

这不是“接受修改”。文案不得出现“已应用”“已保存到原文件”“已完成编辑”。

### Gate 4

用 `report.html` 和同目录资源做手工测试：

1. source 有 3 条可定位评论；candidate 改动其中 1 条，打开 candidate 后可定位的评论仍为 open，无法定位的保留为 stale。
2. candidate 与 source 共享 logical document ID 的关系只能来自成功的 `new_artifact` completion；手动打开相邻另一个 HTML 不继承评论。
3. completion 的 source hash 错误、URI 错误、run/task hash 错误时不导航、不链接、不迁移。
4. source 在执行期间被外部编辑时，页面停留 source，候选不被注册，用户得到可行动错误提示。
5. candidate 的相对资源在 source 同级目录仍可加载。

---

## 6. Phase 5 · 最小证据页与回归（M5 的数据准备，不做 M5 promote）

这一步只把 Phase 4 的结果做成可回看证据，不做 diff engine 或任何文件提升：

1. 对最近一次 completed candidate run，在 Side Panel 显示：run 时间、provider、source/candidate 文件名、source hash 检查结果、candidate hash 短前缀、重锚统计。
2. `返回原文件` 与 `打开候选版本` 只操作已验证 URI；打开失败显示错误，不猜测路径。
3. 不把完整 task、prompt、candidate HTML、Claude 回复写入 IndexedDB；只存 run metadata 和 manifest path/hash。
4. 新 candidate 成功时可替换“最近一次结果”引用，但不得删除用户 source、candidate 或 manifest。
5. 为下一个 M5 保留数据入口：`source_uri`、`candidate_uri`、两个 hash、logical document ID、run ID、anchor stats。不要现在设计 UI diff 格式。

### Gate 5

- 刷新 Side Panel 后最近一次 candidate 的最小证据仍可显示；
- 任何敏感 task/prompt/comment 不存在于 extension storage 的 run record；
- 不存在 promote / overwrite / auto-accept 按钮或代码路径；
- v0.6.1、v0.6.2、v0.7.1 的测试仍通过。

---

## 7. 修改边界与文件建议

允许根据 Preflight 的真实入口进行等价调整，预期涉及：

```text
extension/sidepanel.html
extension/sidepanel.css
extension/sidepanel.js
extension/i18n.js
extension/background.js
extension/content-script.js             # 仅复用/接入受控 artifact completion
bridge/host.mjs
bridge/claude-cli.mjs
bridge/task-bundle.mjs
bridge/* candidate 相关新模块与 test/
docs/CURRENT_IMPLEMENTATION_STATE.md
docs/implementation-notes/...
```

禁止的修改：远端协同 API、登录体系、`storage.js` schema 的无关重构、Agent API key、任意 shell、任意 source 覆盖、MCP、外部 session 枚举。

如果为了完成 M4 需要修改 artifact storage schema，必须先判断是否能用已有 metadata 表达；不能时停止并报告具体 migration 需求，不要夜间自行迁移。

---

## 8. 最终交付与状态页重写

结束前必须：

1. 运行所有可用自动测试、`git diff --check`，记录命令和结果；不因为真实 Claude smoke 未执行而伪造通过。
2. 更新 `docs/implementation-notes/2026-07-20-night-pack-a-preflight.md` 为最终 reconciliation：哪些产品要求按原样完成、哪些按实际代码等价适配、哪些未完成。
3. **整体重写** [`CURRENT_IMPLEMENTATION_STATE.md`](CURRENT_IMPLEMENTATION_STATE.md)：真实完成到哪个 gate、实际入口、测试结果、已知限制、下一步获授权范围。不得在文末追加第二套结论。
4. 最终交接摘要不超过 30 行，包含：完成 gate、未完成 gate、改动文件、测试结果、是否真实 smoke、风险。

### 施工成功判定

Night Pack A 只有在 Gate 0–5 全部通过、且真实 Claude smoke 至少被明确标记为“通过”或“待用户手动验证”时才可结束。若停在任何 gate，保留前面已经通过测试的阶段，并把状态页的“下一个获授权施工包”改为该 gate 的修复，不得假装已完成 candidate 闭环。

---

## 9. 下一包的唯一方向

Night Pack A 完成后，才讨论 M5：source/candidate diff、修改范围审查、越界变化告警、用户显式 promote。M5 不应提前混入本包；candidate 生命周期、hash、artifact relation 和 anchor stats 尚未稳定前，任何“审查 UI”都会建立在不可靠输入上。
