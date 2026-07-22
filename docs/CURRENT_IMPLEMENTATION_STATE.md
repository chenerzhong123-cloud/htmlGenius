# HTML Genius 当前实现状态

> **用途：** 产品路线与实际仓库之间唯一的短事实层。施工 Agent 开始前必读、验证并完成后整体重写。
> **更新规则：** 不追加"更新记录"；保留结构，替换过期事实；≤150 行。
> **最后静态核对：** 2026-07-23（v0.9：Agent-assisted Local Bridge 与 Connection Center；受控 CLI doctor/setup/repair/uninstall + health 契约 + host health/repair 协议 + 后台 bootstrap；v0.8.2 三 provider 无回归。bridge 测试 268 通过）。

## 1. 当前产品边界（不可擅自改变）

- Chrome Side Panel MV3 插件，本地优先；无托管 AI、统一 Token、云端转发或账号系统。
- Agent 只用用户本机登录态；只新建 task（session_mode=new），不列举/读取/恢复/注入/续发用户已有会话；禁 RPC 清单沿用 v0.8.2（Codex thread/* 与 Copilot SDK listSessions/resumeSession/getEvents…）。
- Change Contract 是唯一任务输入；prompt 不是安全边界。
- source HTML 永不自动覆盖：Agent 只写 workspace 内 candidate，host 校验后以**版本号 sibling**（`原名V1.N.html`）发布。
- **v0.9 安装边界**：扩展不能自行安装 host；首次初始化 = 用户明确授权的一次动作（Agent-assisted Setup Prompt 或一条 Terminal 命令）。Setup Prompt 固定模板 + 严格变量（仅扩展 ID/版本），绝不拼页面/评论/契约/路径/凭证；Agent 只运行官方 CLI、不改项目文件。CLI 只写用户级 HTML Genius 目录 + Chrome host manifest；`--scope user` only，拒 root；单 origin 白名单；卸载只删受控标记文件。
- **v0.9 协议边界**：health/repair 输出绝不含路径/stderr/token/cookie/session/thread；repair 仅 allow-list（`repair_native_host`）且需用户二次确认；不静默升级（host 过旧 → 提示修复，用户执行后才替换）。
- 未安装/未连接时始终保留「复制 Prompt」降级路径。
- 不向 UI 暴露 runtime 路径 / TeamID / schema 路径 / stderr / 完整命令体 / 思维链正文 / session ID；hash 永不跨侧比较。

## 2. 已确认的实现基线

| 能力 | 状态 | 实际入口 / 证据 |
|---|---|---|
| Change Contract / artifact 协议 / 评论体系 | 已存在 | `change-contract.js` / `artifact-version.js` / content-script（v0.8.2 无改动）。 |
| 三 provider 候选+计划闭环 | 已存在 | Claude（host-runner）/ Codex（codex-adapter + app-server client）/ Copilot（copilot-runtime + copilot-adapter，SDK 1.0.7 精确锁，local_cli→bundled 双 runtime，pre-tool 围栏，Plan runtime 锁定）。 |
| **受控 CLI `htmlgenius-bridge`** | **已就绪（未 publish）** | `bridge/bin/htmlgenius-bridge.mjs`：doctor/setup/repair/uninstall/version；`--json` stdout 唯一 JSON；退出码 0/1/2/3/64；受管布局 `~/.htmlgenius/bridge/versions/<v>/`（0700，launcher 不指向 npx 缓存）；幂等 setup；V0.8.2 迁移（同 ID 替换/异 ID 拒）；卸载只删受控文件。`bin` 已在 package.json 暴露，**npm 未发布**（发行是后续外部授权事项）。 |
| **共享安装核心** | **已就绪** | `bridge/bridge-install.mjs` 为安装规则唯一实现源；`install-macos.mjs` 降级为开发兼容薄包装（就地安装，launcher 指向仓库 host.mjs）。 |
| **health 契约** | **已就绪** | `bridge/bridge-health.mjs`：schema_version=1；overall/bridge.status/browser.status/providers[]/actions + reason_code 机器码 + remediation{kind,label_key}；sanitizeHealth 纵深脱敏。 |
| **host health/repair 协议** | **已就绪** | `host.mjs`：bridge_health → bridge_health_result（host 在运行即 bridge ready，origin 由 Chrome 路由保证）；bridge_repair allow-list（confirmed_actions 必含 repair_native_host）只重写自身 launcher+manifest；stdout 纪律不变。旧 host 不识 bridge_health → unknown_message。 |
| **后台协议（v0.9）** | **已就绪** | `background.js`：bridge-query-health（connect 失败/断开 → BRIDGE_NOT_INSTALLED；旧 host → BRIDGE_PROTOCOL_TOO_OLD；host 过新 → BRIDGE_PROTOCOL_TOO_NEW）；bridge-repair（allow-list 透传）；bridge-get-bootstrap（纯本地模板 zh/en/ja + `BOOTSTRAP_DISTRIBUTION="development"` 开发态标注）。版本单一来源：扩展版本取 getManifest().version（0.9.0），TARGET_BRIDGE_VERSION=0.9.0，BRIDGE_PROTOCOL_VERSION=1；0.8.1 漂移已除。 |
| **Connection Center（sidepanel）** | **已就绪** | `sidepanel.html/.css/.js`：契约发送区上方可折叠卡片；§5.2 状态矩阵（未安装/需修复/OS 不支持/扩展需更新/组件就绪无 Agent/已连接 N 个）；让 Agent 帮我连接（复制 Setup Prompt）/复制 Terminal 命令/检查连接/复制诊断/安全修复（二次确认）；任何状态保留复制 Prompt；mint token 浅/深色自适应；全量文案 i18n 三语（key 完整性自动测试）。 |
| plan-first bridge | 后端就绪，前端隐去 | 三家 executePlanRun + §5.4 校验（plan_sha256 闭环 v0.8.2 已修）；`#contract-plan` 仍 hidden。 |

## 3. 关键代码地图

```text
bridge/bridge-install.mjs   安装规则唯一源:校验/manifest/launcher(受控标记)/原子写/受管布局/迁移/卸载
bridge/bin/htmlgenius-bridge.mjs  CLI 五子命令(JSON 唯一输出/稳定退出码/env 测试注入)
bridge/bridge-health.mjs    health 契约纯逻辑:reason_code 映射/remediation/sanitize/兜底形态
bridge/host.mjs             + bridge_health / bridge_repair(allow-list)分支
bridge/copilot-runtime.mjs / copilot-adapter.mjs   Copilot SDK 运行时与编排(v0.8.2)
bridge/install-macos.mjs    开发兼容薄包装(调用 bridge-install)
extension/background.js     + queryBridgeHealth/nativeRoundTrip/requestBridgeRepair/makeBootstrap(固定模板)
extension/sidepanel.*       + Connection Center(状态矩阵/复制动作/修复确认)
extension/i18n.js           + conn.* 三语(39 key × 3)
bridge/test/  268 pass（新增:bridge-install 18 / cli 13 / bridge-health 6 / host-health 6 /
              background-health-wiring 9 / sidepanel-conn-wiring 7 / i18n-keys 3）
```

## 4. 可运行检查（结果 2026-07-23）

```text
cd bridge && npm test                # 268 pass / 0 fail
node --check extension/{background,sidepanel,plan-validate,i18n}.js   # 全绿
CLI 冒烟:node bridge/bin/htmlgenius-bridge.mjs version --json        # {"name":"htmlgenius-bridge","version":"0.9.0","protocol_version":1,...}
```

CLI/host 端到端测试用 env 注入 tmp home/hosts-dir（内部测试接口，非公开接口）；host-health 测试以真实 native 帧往返。

## 5. 当前工作树与已知限制

- **npm 包未发布**：Connection Center 处于开发态（`BOOTSTRAP_DISTRIBUTION="development"`，显著标注「仅开发环境」，给仓库内命令）；正式渠道发布前不得宣称 npx 可用。发布流程（`@htmlgenius/bridge` + provenance）是后续外部授权事项；发布后需把 BOOTSTRAP_DISTRIBUTION 改 production 并核对 TARGET_BRIDGE_VERSION。
- **平台**：仅 macOS；Windows/Linux 在 UI 准确标为不支持（OS_UNSUPPORTED），不给失效命令。
- **真实 macOS 端到端**（Setup Prompt 粘给真实 Agent 跑 doctor/setup）尚未人工验收；真实 Copilot smoke 需有权益设备。mock 通过 ≠ 真实可用。
- plan 按钮前端仍隐去；diff/review/promote 在路线图未实现。
- landing/ 已 gitignore（独立部署）；agents.html 已含 Copilot 段，待重部署。

## 6. 下一个获授权施工包

- **v0.9.1 provider 认证 harness**（spec 已就位：docs/2026-07-23-v0.9.1-provider-certification-harness-spec.md）。
- 真实端到端人工验收（MANUAL_VERIFICATION.md v0.9 清单）+ Copilot 真机 smoke。
- npm 发布授权后切 production bootstrap。
- plan UI 放出；diff/review/promote（M5）。
