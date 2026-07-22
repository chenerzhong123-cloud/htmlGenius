# Provider 认证契约与新增 Agent 施工模板(v0.9.1)

> 本目录每个 `<provider-id>.md` 描述一个已认证 provider 的官方前提、登录方式、能力与验证状态。
> 新增第 4/5 家 Agent 时,**先读这里再施工**;认证 harness 会自动拦截缺交付物的 provider。

## 新增 provider 的强制交付物(缺一不能进正式发送菜单)

1. **生产 descriptor**:`bridge/provider-registry.mjs` + `extension/provider-metadata.js`(两侧一致性测试兜底);
2. **probe adapter + reason-code 映射**:`bridge/provider-probe.mjs` 与 `bridge-health.mjs`;
3. **candidate adapter**;声明 `plan` 则必须有 plan adapter;
4. **fake runtime fixture**:`bridge/test/providers/<name>.fixture.mjs`(§4 契约:不触真实账号/网络/$HOME;失败场景可精确制造);
5. **certification 证据**:`npm run verify:providers -- --provider <id>` 通过;
6. **i18n 三语言** label + remediation + 状态文案;
7. **本文档**:`docs/providers/<id>.md`;
8. **真实 smoke**(强烈建议):`HTMLGENIUS_ALLOW_REAL_SMOKE=1 HTMLGENIUS_SMOKE_WORKSPACE=<新目录> npm run smoke:provider -- --provider <id>`;未做必须在实现状态中标「mock 认证已过,真实 smoke 未验证」。

## 标准施工顺序

1. **声明**:registry descriptor(能力/runtime policy/官方前提),不要先改 UI;
2. **安全 adapter**:先 probe 与受限 candidate workspace;未验证 API 不得用"默认 shell"绕过;
3. **fixture**:全部必需失败场景(not_installed/auth_required/incompatible/probe_error/candidate_missing/out_of_scope/source_mutated/plan_invalid;runtime_locked 还要 runtime_changed);
4. **认证**:`npm run verify:providers -- --provider <id>` 通过才接 Side panel 菜单;
5. **文案与文档**:三语言 + 本文档 + 已验证/未验证状态;
6. **真实 smoke**:有授权环境时运行;没有则明确标未验证,不得伪称 E2E;
7. **回归**:`npm run verify` 全绿;脱敏 report 存档或附 PR。

## 验证金字塔

| 层 | 命令 | 账号/网络 | 证明 |
|---|---|---|---|
| L0/L1 | `npm test` + `npm run verify:bootstrap` | 无 | 纯函数/install/Native framing/artifact 闭环 |
| L2 | `npm run verify:providers` | 无(fake) | provider 语义满足共同契约 |
| L3 | `npm run smoke:local` / `smoke:provider`(双环境门 opt-in) | 真实 | 真实 Agent 认证/权益/协议仍可用 |

## 当前 provider

- [claude_code_cli](claude_code_cli.md) — Claude Code CLI
- [codex_app_server](codex_app_server.md) — Codex App Server
- [github_copilot](github_copilot.md) — GitHub Copilot(官方 SDK)
