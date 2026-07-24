# htmlGenius Local Bridge (v0.9.2 · macOS · Claude Code / Codex / GitHub Copilot)

让 Side Panel 把一份「修改契约」**一键交给你本机已登录的 AI Agent**，产出**只写候选、绝不覆盖原文件**的新版本（`原名V1.N.html`），或先生成可审阅的**修改计划**。

> 仅 macOS + Chrome + Node 20.x / 22+（GitHub Copilot 另需 `^20.19.0 || >=22.12.0`；不满足时仅 Copilot 不可用，Codex / Claude Code 照常）。host 名 provider-neutral（`com.htmlgenius.local_bridge`），三个 provider 复用同一个 host。

---

## 1. 用户接入路径（产品路径，无需进源码仓库）

Native Messaging 安全模型决定：扩展**不能**自行下载安装程序或注册 host。因此首次初始化是用户明确授权的一次动作，有两条路径：

### 路径 A（首选）：让 Agent 帮我连接

1. 打开契约页（「整理评论，创建编辑任务」）。未连接时发送区上方出现 **Connection Center**：「尚未连接本地 Agent」。
2. 点「**让 Agent 帮我连接**」→ 剪贴板得到一段**严格限定的 Setup Prompt**（只含扩展 ID 与固定 Bridge 版本；不含页面内容/评论/路径/凭证）。
3. 把它粘贴给你**正在使用的** Claude Code / Codex / Copilot。Agent 只会运行 HTML Genius 官方 CLI：`doctor`（只读检查）→ 必要时 `setup`（用户级安装）→ 再 `doctor`。
4. 回到 Side Panel 点「**检查连接**」。

### 路径 B（兜底）：一条 Terminal 命令

点「**复制 Terminal 命令**」→ 粘贴到 Terminal 执行。命令固定版本、用户级安装，**不会安装或登录任何 Agent**。

> ✅ **发行状态**：npm 包 `@htmlgenius/bridge` 已发布（MIT 开源可审计，CI 带 provenance 来源证明）。Connection Center 为**生产态**，「复制 Terminal 命令」给出固定版本命令：
> ```bash
> npx --yes @htmlgenius/bridge@0.9.2 setup --json --scope user --extension-id <你的扩展ID>
> ```
> 仓库内开发命令见 §4（仅开发/调试）。

### 前置条件（任一 Agent 就绪即可）

- **Codex（推荐）**：Codex Mac App（ChatGPT.app）已登录。
- **GitHub Copilot**：本机 Copilot 已登录；可选装 `copilot` CLI（优先走它，否则 SDK 自带 runtime）。
- **Claude Code**：`claude auth login` 完成。
- htmlGenius **不要求、不读取、不保存**任何 API key / token / Cookie——全部复用各 Agent 本机登录态。

## 2. Connection Center 状态说明

| 状态 | 含义 | 你能做什么 |
|---|---|---|
| 尚未连接本地 Agent | host 未注册 | 让 Agent 帮我连接 / 复制 Terminal 命令；**复制 Prompt 始终可用** |
| 本地连接组件需要修复 | host 过旧/注册文件缺失或损坏 | 让 Agent 帮我修复 / 安全修复（仅 host 可达且判定可自修时出现，二次确认，只重写注册文件） |
| 扩展需要更新 | host 协议比扩展新 | 更新 htmlGenius 扩展 |
| 当前系统暂不支持 | 非 macOS | 复制 Prompt 手动交给 Agent |
| 本地连接组件已就绪 | host 正常但无可用 Agent | 按逐项提示登录/安装各 Agent，再「检查连接」 |
| 已连接 N 个 Agent | 一切就绪 | 照常在发送菜单选择 Agent（卡片默认折叠） |

「复制诊断」只复制脱敏 health JSON（无路径/token/会话信息），可发给维护者排障。

## 3. 使用

1. 打开**单文件本地 HTML**（`file:///.../report.html`）。
2. 划词评论（至少一条顶层评论）。
3. 「**整理评论，创建编辑任务**」→ 勾选评论 → 选修改范围（精准 / 局部 / 全文重做）。
4. 发送菜单（⌄）选 Agent（仅「已连接」可选；Copilot 显示所用 runtime）→「**发送给 ×××**」。
5. 状态栏实时展开（流式输出 / 工具事件 / 计时器），可随时「终止任务」；完成自动新开候选页签 + 系统通知。
6. 审计证据在源文件目录旁：`.htmlgenius-bridge/<claude|codex|copilot>/<逻辑文档ID>/runs|plans/<run-id>/`。

## 4. 开发者路径（仓库内安装，仅开发/调试）

```bash
cd bridge
npm install                                   # 拉取 @github/copilot-sdk 1.0.7(精确锁定)
node install-macos.mjs --extension-id <扩展ID>  # 就地安装:launcher 直接指向仓库 host.mjs(改代码即生效)
node install-macos.mjs --uninstall              # 卸载
```

产品 CLI（`bridge/bin/htmlgenius-bridge.mjs`）子命令：`doctor` / `setup` / `repair` / `uninstall` / `version`；`--json` 时 stdout 仅一个 JSON object；退出码：0 ready / 1 action required / 2 unsupported / 3 error / 64 用法错误。安装布局：受管目录 `~/.htmlgenius/bridge/versions/<version>/`（0700），launcher 只引用受管目录（不指向 npx 临时缓存）。

## 5. 故障排查

| 现象 | 处理 |
|---|---|
| Connection Center 一直「正在检查」 | 扩展未刷新或 host 进程异常；`chrome://extensions` 刷新扩展，再「检查连接」。 |
| `需要在本机登录 ××` | 按提示登录对应 Agent（登录只能走官方流程，Bridge 不代登录）。 |
| `Copilot 运行时不兼容` | 升级本机 `copilot` CLI，或移除 CLI 让 Bridge 走 SDK 自带 runtime。 |
| 安全修复后仍异常 | 「复制诊断」获取脱敏 health JSON 反馈；或重走「让 Agent 帮我连接」。 |
| 源 HTML 已变化 | 发送前/期间源文件被改动；重新加载文件后再发起。 |

## 6. 安全模型（摘要）

- **安装**：CLI 只写用户级 `~/.htmlgenius/bridge/` 与 Chrome host manifest；`--scope user` only，拒绝 root；单 origin 白名单（ID 不匹配拒绝覆盖）；launcher 受控标记防误删第三方 host；原子写无半写 manifest。
- **Setup Prompt**：固定模板 + 严格变量（仅扩展 ID/版本）；绝不拼入页面 HTML/评论/契约/路径/凭证；Agent 只跑官方 CLI，不改项目文件。
- **health/repair 协议**：`bridge_health` 只读；`bridge_repair` 仅执行 allow-list（`repair_native_host`，需用户二次确认），只重写自身注册文件；输出绝不含路径/stderr/token/session。
- **Agent 沙箱（沿用 v0.8.2，不允许回归）**：Claude 只读+Write 白名单；Codex workspaceWrite+禁网+codesign 校验；Copilot SDK empty 模式 + 工具白名单 + onPreToolUse 路径围栏；均只写候选，永不覆盖 source；不触碰用户已有会话。

## 7. 测试与验证体系（v0.9.1）

```bash
cd bridge
npm test                 # L0/L1:283 pass / 0 fail(无账号/无网络)
npm run verify:bootstrap # L1:install→幂等→origin 拒绝→损坏→repair→Native 帧→uninstall(13 项)
npm run verify:providers # L2:三家 provider fake 认证(37 项)
npm run verify           # 三门总入口(施工完成的最低自动化门)
```

真实 smoke（L3，**默认拒绝运行**）：

```bash
HTMLGENIUS_ALLOW_REAL_SMOKE=1 HTMLGENIUS_SMOKE_WORKSPACE=<新建空目录> npm run smoke:local
HTMLGENIUS_ALLOW_REAL_SMOKE=1 HTMLGENIUS_SMOKE_WORKSPACE=<新建空目录> npm run smoke:provider -- --provider github_copilot
```

workspace 必须是新建空目录，拒绝项目根/HOME/Desktop/Documents 内路径；真实 smoke 通过**不自动提升** provider 为正式支持。

覆盖：安装核心（幂等/迁移/origin 拒绝/卸载选择/受管布局/原子写）、CLI（JSON 唯一性/退出码/doctor 无副作用/错误脱敏）、health 契约（reason_code/remediation/脱敏）、host health/repair（native 帧端到端/allow-list/未确认拒绝）、后台协议、Connection Center 纯函数状态矩阵、provider registry 一致性、fixture contract 硬门、report 脱敏泄露回归，及 v0.8.2 全部 provider 回归。

真实 macOS 端到端（Setup Prompt 粘贴给真实 Agent 执行）需人工验收，见 [MANUAL_VERIFICATION.md](MANUAL_VERIFICATION.md)；新增 Agent 的认证契约与交付物清单见 [providers/README.md](providers/README.md)。
