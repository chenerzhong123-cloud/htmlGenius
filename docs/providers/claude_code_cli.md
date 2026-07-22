# Provider:claude_code_cli(Claude Code)

## 官方前提

- 安装 Claude Code CLI(`claude --version` 可用)。
- 已完成 `claude auth login`(Bridge 复用本机登录态,**不读取/不保存** API key / token / Cookie)。
- macOS + Chrome + Node `^20.19.0 || >=22.12.0` + 已安装 HTML Genius Local Bridge。

## 能力

| 能力 | 支持 | 说明 |
|---|---|---|
| candidate | ✅ | 固定 argv 沙箱:`Read,Glob,Grep,Write`,禁 Bash/Edit/联网/MCP;`spawn(shell:false)` 防注入;max-turns 24;candidate 超时 15 分钟。 |
| plan | ✅ | 只允许写 `output/plan.json`;plan 超时 3 分钟。 |
| runtime policy | `provider_default` | 无 runtime 锁定(Plan→Candidate 不要求同一 runtime 变体)。 |

## 用户手动登录方式

```bash
claude auth login      # 按官方流程完成登录
claude auth status     # 自检(JSON 输出登录状态)
```

Bridge 不会代登录;未登录时 Connection Center 显示「需要在本机登录 Claude Code」并链接官方说明。

## 已知限制

- CLI 冷启动:每次新起子进程,首 token 前有几秒~十几秒开销,整页重做明显慢于 Codex(正常现象)。
- 续发(continue)仅在旧 handoff 路径保留;candidate/plan 一律 `session_mode=new`。
- bridge_sessions 会保存 Claude session UUID 供续发(V0.8 既有行为);prompt/stdout/思维链不持久化。

## 验证状态

- **mock 认证:已过**(`npm run verify:providers`,fixture `claude-code.fixture.mjs`,probe 5 场景 + candidate 5 项 + plan 2 项全绿)。
- **真实 smoke:未验证**(需本机 Claude 订阅;`npm run smoke:provider -- --provider claude_code_cli`,双环境门 opt-in)。
