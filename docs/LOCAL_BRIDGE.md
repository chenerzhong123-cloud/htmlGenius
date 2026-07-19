# htmlGenius Local Bridge (v0.7.1 · macOS · Claude Code)

让 Side Panel 把一份「修改契约」**一键交给你本机已登录的 Claude Code CLI**。本版是**交接验收版**:验收目标是「任务已真实到达 Claude Code CLI」,Claude 只确认收到任务,**不会修改任何文件**。

> 仅 macOS + Chrome + Node 20+ + Claude Code CLI。host 名是 provider-neutral 的(`com.htmlgenius.local_bridge`),后续 Codex adapter 复用同一 host,不另装。

---

## 1. 前置条件

- **macOS**(Apple Silicon 或 Intel)。Windows / Linux 的 Native Host 未实现。
- **Node.js ≥ 20**:`node -v`。
- **Google Chrome**(已加载 htmlGenius 扩展)。
- **Claude Code CLI**:已安装并登录。
  - `claude --version` 可用;
  - `claude auth login` 已完成(Bridge 复用你本机的 Claude Code 登录态;htmlGenius **不要求、不读取、不保存**任何 API key、OAuth token、Cookie 或订阅凭据);
  - 自检命令:`claude auth status`(JSON 输出登录状态)。

## 2. 安装 Native Host

1. 在 Chrome 加载未打包扩展:`chrome://extensions` → 右上「开发者模式」→「加载已解压的扩展程序」→ 选本仓库的 `extension/`。
2. 在扩展卡片上复制 **ID**(32 位字符串,`a–p`)。
3. 在仓库根目录执行:
   ```bash
   cd bridge
   node install-macos.mjs --extension-id <你的扩展ID>
   ```
   - 仅写入**单个 origin** 的 host manifest + launcher 到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`(`allowed_origins` 只含你这一个扩展,无通配符)。
   - launcher 用绝对 `node` + 绝对 `host.mjs`,无 shell 拼接;失败会清理半写入文件。
   - 安装脚本会校验 `claude` 在 PATH 中(或用 `--claude-path <绝对路径>` 显式指定)。
4. 回到 `chrome://extensions`,点 htmlGenius 的「**刷新**」让 service worker 重新加载。

> 安装脚本会打印实际 manifest / launcher 路径与卸载命令。它不会改动 Chrome 扩展配置。

## 3. 使用

1. 打开一个**单文件本地 HTML**(`file:///.../report.html` 或 localhost)。
2. 划词评论(至少一条顶层评论)。
3. 点底部「**生成修改任务**」或某条顶层评论卡片的「**生成任务**」。
4. 选修改模式:
   - **精准修补 / 局部优化 / 重新生成** → 出现「**发送给 Claude Code**」按钮;
   - **结构重组** → 不出现发送按钮,只「复制规划任务」(本版不发送)。
5. 默认「**创建新的 Claude task**」;若该逻辑文档已有 htmlGenius 创建并完成的 Claude task,可选「**继续 HTML Genius 上次创建的 Claude task**」。
6. 点「发送给 Claude Code」:状态显示「正在发送给本机 Claude Code…」→ 成功后「**修改计划已发送给 Claude Code。**」(可附本地任务编号)。
7. **传输证据**落在源文件目录旁边,可本地审计:
   ```text
   <源文件目录>/.htmlgenius-bridge/claude/<逻辑文档ID>/
     task-<run-id>.json   # 完整 Change Contract(0600)
     task-<run-id>.md     # 安全前言 + 人可读契约 + 哈希/run 元数据(0600)
   ```

## 4. 故障排查

| 现象 | 处理 |
|---|---|
| `未检测到本地 Bridge` | 执行 installer;确认 `--extension-id` 与扩展卡片 ID 一致;刷新扩展。 |
| `Claude Code 未登录` | 终端执行 `claude auth login`;用 `claude auth status` 确认。 |
| `无法继续上次的 Claude task` | 保存的 session 不可用(如工作目录被移动);请改用「创建新的 Claude task」。 |
| `源 HTML 已变化,未发送` | 发送前/发送期间源文件被改动;重新加载文件后再发起。 |
| 一段时间无响应 | host 日志在 stderr(Chrome 的 Native Messaging 不回显);可单独 `node bridge/host.mjs` 手测帧。 |

## 5. 卸载

```bash
node bridge/install-macos.mjs --uninstall
```

仅移除本 host 写的 launcher + manifest,不碰 Bridge workspace(传输证据)与扩展数据。

## 6. 安全模型(摘要)

- **交接验收,绝不写文件**:本版给 Claude 的固定 argv 只放行只读工具 ——
  `claude -p --output-format json --safe-mode --disable-slash-commands --allowed-tools "Read,Glob,Grep" --disallowed-tools "Bash" "Edit" "Write" "WebFetch" "WebSearch" "mcp__*" --permission-mode dontAsk`。
  `--safe-mode` 禁用用户自定义 hooks/plugins/MCP/skills/本地项目定制;不使用 `--dangerously-skip-permissions`、`bypassPermissions`、`--add-dir`。
- **固定 argv 防注入**:扩展内容(评论/说明/路径/哈希)绝不成为 command、flag、cwd 或 env;生成的 prompt 只作为 argv 的最后一个元素经 `spawn(shell:false)` 直传,引号/换行/`;`/`$()` 都只是普通字符串。
- **源文件双重哈希校验**:发送前比对 base SHA-256(不一致 → `SOURCE_CHANGED_BEFORE_START`);交接后再读一次(运行期被外部改动 → `SOURCE_MUTATED_DURING_HANDOFF`,不算成功)。
- **单 origin 白名单**:Native Host manifest 的 `allowed_origins` 只含你的扩展 ID。
- **证据目录权限**:`.htmlgenius-bridge/` 链路 0700,task bundle 文件 0600;完整评论/prompt **不**复制到 `~/Library`、IndexedDB 或任何服务器。
- **只管 htmlGenius 自己创建的 session**:续发只用保存的 UUID 执行 `--resume`,cwd 固定为该 session 的 workspace(Claude 的 `--resume <id>` 只搜索当前项目目录);不运行 `-c`、picker、`claude agents/logs/attach`,不枚举、不读取、不注入任何用户已有会话。
- **IndexedDB 只存元数据**:run/session 记录只存 payload 哈希与 session 元数据,不存完整 Change Contract、prompt、Claude stdout 或模型回复。
- **background 双重校验**:completion 的 run_id / task_sha256(background 自算对照)/ session UUID 任一不匹配即拒绝,不写 session、不显示成功。

## 7. v0.7.1 明确不做

- 不修改 source HTML、不产 candidate、不 reload 页面、不重锚定评论(交接验收版)。
- Codex / Copilot / MCP / Claude Desktop 已打开会话接入(Codex adapter 后续复用本 host 另做)。
- 不展示 Claude 对话、思维链、工具输出或任意用户历史会话。
- 后台长任务、取消、审批转发、多任务队列、相对资源项目支持。
- candidate 与 source 的 diff、review/promote(属于后续 candidate-execution 里程碑)。

## 8. 测试

```bash
cd bridge && node --test test/
```

覆盖:native 帧 codec(拆包/粘包/非法 JSON/超 1 MiB/stdout 无日志污染)、installer(单 origin/0700/无残留)、host 帧端到端、task bundle(稳定 SHA/内容完整/0600/0700/路径穿越防御)、claude-cli(固定 argv/auth 失败/非 JSON/无 UUID/退出码/超时/未安装/**argv 注入安全**,真实 spawn 假 claude 验证)、handoff 编排(new/continue/source 变更/运行期突变/失败不落 session)、completion 双重校验。

真实 Claude 的 smoke 只在手工端到端中验证「任务真实到达」,不在自动测试里消耗你的模型额度。
