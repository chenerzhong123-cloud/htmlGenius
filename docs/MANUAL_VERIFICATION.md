# 人工验收清单（v0.9 Agent-assisted Local Bridge & Connection Center）

> 用途：自动化测试（`cd bridge && npm test` → 268 例）覆盖协议与纯逻辑；本清单覆盖**自动化测不到**的真实交互：真实 Native Messaging、真实 Agent 执行 Setup Prompt、真实 Chrome 扩展 UI。
> 勾选即通过；失败按「现象 / 复现 / 期望」记录。环境：macOS + Chrome（加载未打包 `extension/`，v0.9.0）+ Node `^20.19.0 || >=22.12.0`。

## 0. 环境准备

- [ ] `chrome://extensions` 开发者模式加载 `extension/`，记下扩展 ID（32 位 a–p）。
- [ ] 准备单文件本地 HTML（`file:///…/report.html`）+ 至少 2 条评论。
- [ ] 至少一个 Agent 可登录（Codex App / `claude auth login` / 本机 Copilot）。
- [ ] 开发态说明：npm 包未发布，Connection Center 显示「仅开发环境」命令属预期。

## 1. 未安装态（先 `install-macos.mjs --uninstall` 或全新用户配置）

1. [ ] 打开契约页：Connection Center 显示「尚未连接本地 Agent」+ 说明文案。
2. [ ] 「让 Agent 帮我连接」→ 剪贴板得到 Setup Prompt；**核对**：只含扩展 ID 与固定 Bridge 版本/仓库命令（开发态），无评论内容、无页面 HTML、无绝对用户路径、无 token。
3. [ ] 「复制 Terminal 命令」→ 剪贴板得到开发态命令（带「仅开发环境」标注）。
4. [ ] **「复制 Prompt」仍然可用**（不要求连接）。
5. [ ] 发送按钮禁用（无 ready provider），但无任何误导文案（无"万能修复/自动安装所有 Agent"）。

## 2. Agent-assisted 初始化（§8.2 核心）

1. [ ] 把 Setup Prompt 粘贴给一个可执行 shell 的本机 Agent（Claude Code / Codex / Copilot 任一）。
2. [ ] Agent **只**执行了 doctor → setup → doctor（开发态为仓库内 npm install + install-macos）；**未修改任何项目文件 / HTML / Agent 配置**；未请求管理员权限；未读取历史会话。
3. [ ] 回到 Side Panel 点「检查连接」→ Connection Center 变为「本地连接组件已就绪」或「已连接 N 个 Agent」。
4. [ ] 同一扩展 ID 再跑一次 setup：幂等（`changed:false`），不产生重复 launcher/manifest（`ls ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/` 只有一对文件）。

## 3. origin 与迁移

1. [ ] 换一个/伪造一个 extension ID 执行 setup：拒绝覆盖（EXTENSION_ORIGIN_MISMATCH），现有 manifest 的 allowed_origins 不变。
2. [ ] Side Panel 与 CLI 输出均**不显示底层路径**（成功 JSON 无绝对路径；错误只有机器码与简短文案）。

## 4. Bridge 已连接但 Agent 未就绪（§5.2 矩阵）

1. [ ] Claude 未登录 / Codex 未装 / Copilot 不兼容时：三项**各自**显示真实状态（如「需要在本机登录 Claude Code」「未检测到可用 Codex App」）+ 「查看如何完成 →」链接。
2. [ ] 一个 provider probe 失败不污染另外两个。
3. [ ] 「复制 Prompt」仍可用；「复制诊断」得到脱敏 health JSON（无路径/token/session）。

## 5. 已就绪回归（v0.8.2 安全闭环不回归）

1. [ ] ready provider 存在时：Connection Center 显示「已连接 N 个 Agent」且**默认折叠**，不抢占发送动作。
2. [ ] 发送 candidate：候选生成 → sibling `reportV1.N.html` → 自动打开 + 通知；原文件未动。
3. [ ] Copilot 菜单显示 runtime（本地 Copilot CLI / SDK runtime）；发送链路正常（需有 Copilot 权益，否则跳过此项记为未验证）。
4. [ ] 运行中重开契约页：按钮为「终止任务」态（syncRunStateFromBackground 生效）。

## 6. 安全修复（仅 host 可达且判定可自修时）

1. [ ] 手动删除 host manifest（保留受管目录）→「检查连接」→ 显示「本地连接组件需要修复」，出现「安全修复」按钮。
2. [ ] 点「安全修复」→ **先出二次确认**，明确写出"重写 HTML Genius 的 Chrome Host 注册文件；不安装 Agent、不改项目文件"。
3. [ ] 确认修复 → manifest 恢复 → health ready；它**没有**安装 Agent / 打开登录 / 改动 source/candidate 工作区。
4. [ ] 未安装态（host 完全不存在）**绝不出现**安全修复按钮（只能走 Setup Prompt/Terminal）。

## 7. UI 与三语

1. [ ] 浅色 / 深色主题各检查一遍 Connection Center：配色正常、无横向滚动（窄 Side Panel）、按钮可触达、长文本换行。
2. [ ] 中文 / English / 日本語切换：Connection Center 全部文案随语言切换（标题/描述/按钮/状态/提示），无漏翻 key。
3. [ ] 评论列表、评论树、修改范围、Plan review 等既有交互无变化。

## 8. 协议兼容（可选，需旧版 host）

1. [ ] 若机器上是 v0.8.2 host：「检查连接」→ 显示「本地连接组件需要修复/更新」，提供 Setup Prompt；不自动覆盖；原发送功能（provider_probe + handoff）仍可用。

---

**未验证项记录处：**（真实 Copilot smoke、Windows/Linux 表现、npm 发布后 production bootstrap 均待后续。）
