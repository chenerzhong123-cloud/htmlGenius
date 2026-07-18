# htmlGenius Local Bridge (v0.7, macOS · Codex)

让 Side Panel 把一份「修改契约」直接交给你**本机已登录的 Codex** 执行，产出一个**新的本地 HTML candidate**，并由 v0.6.2 的版本协议安全打开、重锚定批注。

> v0.7 只写 candidate，**绝不覆盖原文件**。仅 macOS + Chrome + Node 20+ + Codex CLI。不做跨平台 / Claude / Copilot / adapter 承诺。

---

## 1. 前置条件

- **macOS**（Apple Silicon 或 Intel）。Windows / Linux 的 Native Host 未实现。
- **Node.js ≥ 20**：`node -v`。
- **Google Chrome**（已加载 htmlGenius 扩展）。
- **Codex CLI**：已安装并登录。
  - `codex --version` 可用；
  - `codex login` 已完成（Bridge 复用你本机的 Codex 登录态，htmlGenius 不保存任何 token / 凭据）。
  - 需支持 `codex app-server` 与 `codex app-server generate-json-schema --out <dir>`（首次运行时 Bridge 会自检 schema，不通过即报 `CODEX_INCOMPATIBLE`）。

## 2. 安装 Native Host

1. 在 Chrome 加载未打包扩展：`chrome://extensions` → 右上「开发者模式」→「加载已解压的扩展程序」→ 选本仓库的 `extension/`。
2. 在扩展卡片上复制 **ID**（32 位字符串，`a–p`）。
3. 在仓库根目录执行：
   ```bash
   cd bridge
   node install-macos.mjs --extension-id <你的扩展ID>
   ```
   - 仅写入**单个 origin** 的 host manifest + launcher 到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`。
   - launcher 用绝对 `node` + 绝对 `host.mjs`，无 shell 拼接。
   - 失败会清理半写入文件。
4. 回到 `chrome://extensions`，点 htmlGenius 的「**刷新**」让 service worker 重新加载。

> 安装脚本会打印实际 manifest / launcher 路径与卸载命令。它不会改动 Chrome 扩展配置。

## 3. 使用

1. 打开一个**单文件本地 HTML**（`file:///.../report.html` 或 localhost）。
2. 划词批注（至少一条顶层批注）。
3. 点底部「**生成修改任务**」或某条顶层批注卡片的「**生成任务**」。
4. 选修改模式：
   - **精准修补 / 局部优化 / 重新生成** → 出现「交给 Codex …」按钮。
   - **结构重组** → 不出现 Bridge 按钮，只「复制规划任务」（v0.7 不启动 Bridge）。
5. 默认「创建新的 Codex task」；若该逻辑文档已有 htmlGenius 创建并完成的 task，可选「继续」。
6. 点「交给 Codex …」。状态变为「Codex 正在生成新版本…」。
7. Codex 把结果写到 `<源文件目录>/.htmlgenius-candidates/<run-id>/result.html`。**原文件字节不变**。
8. 成功后当前标签自动打开 candidate，批注按 TextQuote 重定位为 `open` / `stale`。

## 4. 故障排查

| 现象 | 处理 |
|---|---|
| `未安装本地 Bridge host` | 执行 installer；确认 `--extension-id` 与扩展卡片 ID 一致；刷新扩展。 |
| `请检查 Codex 安装与登录` | `codex login`；`codex --version`；确认支持 `app-server` + `generate-json-schema --out`。 |
| `源 HTML 已变化，未打开结果` | 启动后源文件被改动；重新加载文件后再发起。 |
| candidate 里相对资源（`./styles.css`、`./img/*`）丢失 | v0.7 仅单文件；把 CSS/JS 内联或用绝对 URL。 |
| 一段时间无响应 | host 日志在 stderr（Chrome 的 Native Messaging 不回显）；可单独 `node bridge/host.mjs` 手测帧。 |

## 5. 卸载

```bash
node bridge/install-macos.mjs --uninstall
```

## 6. 安全模型（摘要）

- **只写 candidate**：原文件不被覆盖；启动前 / 运行后都校验完整 SHA-256，源文件变化即停。
- **单 origin 白名单**：Native Host manifest 的 `allowed_origins` 只含你的扩展 ID。
- **Codex sandbox**：candidate 目录可写、源父目录只读、关网、`approvalPolicy: never`。
- **只管 htmlGenius 自己创建的 thread**：不 `thread/list`、不 `thread/read`、不 `turn/steer`、不接管外部会话。
- **不落盘敏感数据**：host 仅存安装/崩溃恢复元数据；不保存 prompt、HTML 内容、Codex 响应或凭据。

## 7. v0.7 明确不做

- Claude Code / Copilot / 通用 adapter / MCP。
- candidate 与 source 的 diff、逐项接受、「提升为正式文件」（属于 v0.7.1）。
- 远程网页、协同 / 同步、服务端 API。
- 运行中取消、任务队列、并行多任务。

## 8. 测试

```bash
cd bridge && node --test test/
```

覆盖：native 帧 codec、installer、host 帧端到端、App Server client（正常 / 错误 / 超时 / server request / continue / stop）、run manager（文件 / 哈希 / candidate / sandbox）、start_run 编排（成功 / 源变化 / turn 失败 / 无 result / continue / restructure 防御）、completion double-check（任一字段不匹配即拒）。

真实 Codex 的 smoke 只在手工端到端中验证「可 handshake」，不在自动测试里消耗你的模型额度。
