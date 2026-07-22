# HTML Genius 当前实现状态

> **用途：** 产品路线与实际仓库之间唯一的短事实层。施工 Agent 开始前必读、验证并完成后整体重写。
> **更新规则：** 不追加"更新记录"；保留结构，替换过期事实；≤150 行。
> **最后静态核对：** 2026-07-23（v0.9.1：provider 认证 harness 与自动化验证体系。provider registry 单一 allow-list；三家 fake runtime fixture + 统一 certification（probe/candidate/plan/安全不变量）；bootstrap verifier（install→幂等→origin 拒绝→损坏→repair→Native 帧→uninstall）；report 脱敏；real smoke 双环境门；Connection Center 纯函数化。bridge 测试 283 通过 + verify:bootstrap 13 项 + verify:providers 37 项全绿）。

## 1. 当前产品边界（不可擅自改变）

- Chrome Side Panel MV3 插件，本地优先；无托管 AI、统一 Token、云端转发或账号系统。
- Agent 只用用户本机登录态；只新建 task（session_mode=new），不列举/读取/恢复/注入/续发用户已有会话。
- Change Contract 是唯一任务输入；source HTML 永不自动覆盖（版本号 sibling `原名V1.N.html`）。
- **provider 准入（v0.9.1）**：新增 Agent 必须交付 descriptor + probe/reason 映射 + candidate(/plan) adapter + fake fixture + 通过统一 certification + 三语言文案 + `docs/providers/<id>.md`；缺一不得进正式发送菜单。生产运行时只信 registry 静态能力，probe 自报能力不得扩权。
- **安装边界（v0.9）**：扩展不能自装 host；用户明确授权的 Setup Prompt / Terminal 一次初始化；CLI 只写用户级目录 + Chrome manifest；单 origin 白名单；卸载只删受控文件。
- **验证边界（v0.9.1）**：默认验证（test/verify:bootstrap/verify:providers）无账号、无网络、无真实 Chrome/Agent；真实 smoke 必须双环境门 opt-in（`HTMLGENIUS_ALLOW_REAL_SMOKE=1` + 隔离 workspace），成功不自动提升 provider 为正式支持；report 一律脱敏（无路径/token/session/stderr/prompt）。
- 不向 UI 暴露路径 / TeamID / schema 路径 / stderr / 命令体 / 思维链 / session ID；hash 永不跨侧比较。未连接时始终保留「复制 Prompt」。

## 2. 已确认的实现基线

| 能力 | 状态 | 实际入口 / 证据 |
|---|---|---|
| 三 provider 候选+计划闭环 | 已存在 | Claude（host-runner，plan-ready 现携带 provider）/ Codex（codex-adapter）/ Copilot（copilot-adapter，SDK 1.0.7 锁，双 runtime，runtime 锁定）。 |
| v0.9 接入层 | 已存在 | CLI `bin/htmlgenius-bridge.mjs`（doctor/setup/repair/uninstall/version）；`bridge-install.mjs` 唯一安装源；`bridge-health.mjs` health 契约；host `bridge_health`/`bridge_repair`（allow-list）；background bridge-query-health/repair/get-bootstrap；Connection Center（§5.2 矩阵）。 |
| **provider registry** | **已就绪** | `bridge/provider-registry.mjs`（frozen allow-list；listProviderIds/getProviderDescriptor/assertProviderDescriptor/providerSupports）+ `extension/provider-metadata.js`（同源只读）；background 的 SUPPORTED_PROVIDERS/HANDOFF_START_TYPES 与 host/provider-probe 默认列表均由 registry 派生；一致性测试硬门（ID/label_key/capabilities/dispatch_type 两侧逐字段比对）。 |
| **fake runtime fixtures** | **已就绪** | `bridge/test/providers/`：contract 模块（必需场景清单/不变量扫描/脱敏断言/形状硬门）+ claude-code / codex-app-server / github-copilot 三个 fixture（包装现有 fake，不触真实账号/网络/$HOME）。fixture contract test = "忘记写 fake" 的第一道门。 |
| **certification harness** | **已就绪** | `bridge/verify/provider-certify.mjs`：probe 矩阵（ready/not_installed/auth_required/incompatible/probe_error + health reason_code/remediation 校验）+ candidate 矩阵（success/missing/out_of_scope/source_mutated/**shell 注入安全**）+ plan 矩阵（success/invalid/runtime_changed）+ §5.4 不变量（source 字节未改写/无越界文件/事件脱敏/Copilot 无 session 键）；单 provider 崩溃不中断其他；`--all/--provider/--report`。当前 **37 项全绿（2 skipped = 非 runtime_locked 的 runtime_changed，设计如此）**。 |
| **bootstrap verifier** | **已就绪** | `bridge/verify/bootstrap-verify.mjs`：mkdtemp HOME/hosts 下 10 步序列（doctor 无副作用 → setup changed:true → 幂等 + 单 origin + 0700 + 不指向 npx → ready → origin mismatch 拒绝 → 损坏检出 → repair 恢复 → Native 帧 health/repair 允许与拒绝 + stdout 纪律 → uninstall 只删受控文件）+ report 脱敏扫描。**13 项全绿**。 |
| **report 脱敏** | **已就绪** | `bridge/verify/report-sanitize.mjs`：sanitizeVerificationReport（递归剥敏感键 + 绝对路径占位）+ makeReportSkeleton/finalizeReport（schema_version=1）；泄露回归单测。 |
| **real smoke（opt-in）** | **已就绪** | `bridge/verify/real-smoke.mjs`：双环境门 + workspace 隔离校验（拒 repo/HOME/Desktop/Documents/非空）；Bridge/provider 真实闭环 smoke（未就绪 → blocked）；Chrome Native Messaging 仅 runner 骨架 + 结构化人工步骤（`unattended_e2e_claimed:false`）。默认拒绝运行（exit 2）。门纯函数测试全绿；**真实 smoke 未执行**（无账号环境）。 |
| **Connection Center 纯函数** | **已就绪** | `extension/connection-center-state.js`：connStateFor（§5.2 矩阵）/ assertBootstrapSafe / canSelectProvider；sidepanel 渲染改由其驱动；node:test 覆盖五状态 + 修复按钮不在未安装态出现 + bootstrap 安全 + CSS 无 overflow-x + 三语 key 完整。 |
| npm scripts | 已就绪 | `npm test` / `verify:bootstrap` / `verify:providers` / `verify`（三门）/ `smoke:local` / `smoke:provider`（后两者默认拒绝）。 |

## 3. 关键代码地图

```text
bridge/provider-registry.mjs     生产 descriptor 唯一 allow-list(启动自检)
extension/provider-metadata.js   extension 同源只读元数据(一致性测试兜底)
bridge/test/providers/           fixture contract + 三家 fake runtime 包装
bridge/verify/provider-certify.mjs / bootstrap-verify.mjs / real-smoke.mjs / report-sanitize.mjs
extension/connection-center-state.js  Connection Center 纯函数状态层
docs/providers/                  README(认证契约/施工模板) + 三家 provider 文档
bridge/(v0.8.2/v0.9 既有)        adapter/host/CLI/health/install/probe 不变
```

## 4. 可运行检查（结果 2026-07-23）

```text
cd bridge && npm run verify
  npm test               # 283 pass / 0 fail
  verify:bootstrap       # 13 passed / 0 failed
  verify:providers       # 37 passed / 0 failed / 2 skipped
node verify/real-smoke.mjs   # 默认拒绝:SMOKE_NOT_ALLOWED(exit 2)— 预期行为
```

## 5. 当前工作树与已知限制

- **真实验证状态**：三 provider 均为「mock 认证已过，真实 smoke 未验证」（无账号环境）；Chrome 真实 Native Messaging E2E 为人工门（MANUAL_VERIFICATION §8/runner 骨架）。不得把 mock 通过写成真实可用。
- **npm 包未发布**：Connection Center 仍为开发态（`BOOTSTRAP_DISTRIBUTION="development"`）；`@htmlgenius/bridge` 发布是后续外部授权事项，发布后切 production 并核对 TARGET_BRIDGE_VERSION。
- **平台**：仅 macOS；Windows/Linux 准确标为不支持。
- plan 按钮前端仍隐去；diff/review/promote 未实现。
- landing/ 已 gitignore（独立部署）；agents.html 已含 Copilot 段，待重部署。
- `verify:providers` 的 fixture 放在 test/providers/（不被 `node --test test/*.test.mjs` 当测试执行）。

## 6. 下一个获授权施工包

- 真实端到端人工验收（MANUAL_VERIFICATION v0.9 清单）+ 有权益设备上的三 provider real smoke。
- npm 发布授权后切 production bootstrap。
- plan UI 放出；diff/review/promote（M5）。
- （可选）Playwright 增强 `verify:sidepanel`（§9.2，非硬前提）。
