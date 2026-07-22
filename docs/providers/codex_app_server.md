# Provider:codex_app_server(Codex)

## 官方前提

- 安装 **Codex Mac App**(ChatGPT.app 内置 `codex app-server`,bundle id `com.openai.codex`)并已登录。
- macOS + Chrome + Node `^20.19.0 || >=22.12.0` + 已安装 HTML Genius Local Bridge。

## 能力

| 能力 | 支持 | 说明 |
|---|---|---|
| candidate | ✅ | App Server JSON-RPC:initialize → thread/start → turn/start → turn/completed;sandbox `workspaceWrite` + `approvalPolicy=never`;turn 超时 15 分钟;token 逐字流式。 |
| plan | ✅ | 永远 thread/start(不续发);只允许写 `output/plan.json`。 |
| runtime policy | `signed_app_only` | 仅信任 codesign TeamID 校验通过的 `com.openai.codex` bundle;**不搜 PATH、不接受任意二进制**。 |

## 用户手动登录方式

在 Codex Mac App / ChatGPT.app 内完成账号登录即可;Bridge 复用 App 登录态,**不读取/不保存**任何凭证。未登录/未安装时 Connection Center 显示对应状态并链接官方说明。

## 已知限制

- 仅 macOS(依赖 Codex Mac App bundle)。
- 禁用 RPC 清单不发:`thread/list`、`thread/read`、`thread/fork`、`turn/steer`、`thread/inject_items`。
- schema 兼容:`generate-json-schema` 生成 + `verifySchema` 校验,不兼容报 `CODEX_APP_INCOMPATIBLE`。

## 验证状态

- **mock 认证:已过**(`npm run verify:providers`,fixture `codex-app-server.fixture.mjs`,probe 5 场景 + candidate 5 项 + plan 2 项全绿)。
- **真实 smoke:未验证**(需本机 Codex 权益;`npm run smoke:provider -- --provider codex_app_server`,双环境门 opt-in)。
