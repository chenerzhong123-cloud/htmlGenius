# 开发与部署

> 面向开发者 / 贡献者。用户文档请看 [README.md](README.md)。

## 运行（本地）

```bash
uv run uvicorn server.app:app --port 8000 --reload
```

打开样本页（仅供本地调试 web 形态）：

- 卡片样本：`http://localhost:8000/static/viewer.html?doc=01_token`（也支持 `02_rag` / `03_fine-tuning`）
- dogfooding：`http://localhost:8000/static/viewer.html?doc=spec`

> 改文件后 `--reload` 自动重载；浏览器侧看不到新效果时用**无痕窗口**或 DevTools → Network → Disable cache。

## 测试

产品主形态是 **Chrome 扩展**，测试分两块：扩展（JS，主要）与协同后端（Python，可选）。

### 扩展（JS）

```bash
cd bridge && node --test test/        # Native Host / bridge 逻辑：native 帧 · installer · task-bundle ·
                                      #   claude-cli(真实 spawn + argv 注入安全) · host 编排 · candidate-workspace ·
                                      #   candidate-run · completion 双校验
node tests/test_undo_history.js       # 撤销/重做状态机（纯逻辑）
# 浏览器测试页（在浏览器或 jsdom 中打开，document.title 报 PASS/FAIL）：
#   extension/*-test.html（change-contract / buildprompt / artifact-version / artifact-storage /
#   apply-delta / sync / remote-store / version / login / comment-task-selection）
```

浏览器测试页可用 **jsdom** 无头驱动（注入 `crypto.webcrypto` + `indexedDB`(fake-indexeddb) + `fetch` 后 `runScripts:"dangerously"`，轮询 `document.title`）；390px 三态截图用 **puppeteer-core + 系统 Chrome（headful）**。`/tmp` 下常备 `puppeteer-core / jsdom / fake-indexeddb` 用于本地复现与截图。真实 Claude Code 运行属手工 smoke（消耗本机额度），自动化用假 CLI 覆盖，**不得伪造通过**。

覆盖：Change Contract 构建/校验/序列化 · 评论选择流（初始全选 / 取消后 rootIds 精确相等 / reply 不勾选 / stale 过滤 / M=0 禁用 / 关闭清空）· artifact 版本对账 · 撤销重做 · 候选工作区不可覆盖协议（snapshot 0400 / manifest 0600 / sibling 原子 / 形态校验 / symlink 逃逸防御）· 候选执行编排（写候选→sibling+ready manifest / 写 Markdown 拒绝 / source 突变拒绝）· argv 注入安全。

### 协同后端（Python，可选）

```bash
uv run pytest -v          # 仅多人协同自托管后端
```

覆盖：健康检查 / 数据模型 / SQLite 存储 / HTTP API / 定位算法 / 端到端重定位 / UI e2e / 编辑器·工具栏·序列化·sanitize / 版本管理 / v0.4 协同（schema 迁移 · SSE 房间 · 写后广播 · presence GC · 仅作者删除级联）/ v0.5 飞书 OAuth（sessions · lark 客户端 · require_session · /auth 端点 · 硬身份作者）/ v0.5.1 评论编辑（PATCH 作者校验 · 跨团队/非作者 403 · 不存在 404）。

## 架构（Chrome 扩展 + 本机 Agent 桥，主形态）

- **content-script**（注入页面）：text-quote 定位、非侵入 overlay、富文本/元素级编辑、`get-export`/`artifact-update-ready` 受控消费（打开新版本 + 重锚）。
- **sidepanel**：评论收件箱 / 评论选择流 / Change Contract 表单 / 本机 Agent 发送与只读结果态；状态机用 `data-step="select|compose"` 显式表达，临时选择只存内存。
- **background**（service worker）：`bridge-start` 严格校验（自取 artifact state、`run_kind` 透传、restructure 拒绝 candidate）→ 连 Native Host → 路由 host 事件 → completion 逐字段双校验。
- **bridge/**（Node Native Messaging host，`com.htmlgenius.local_bridge`，provider-neutral）：`claude-cli.mjs`（固定 argv、`shell:false`、auth、超时）、`task-bundle.mjs`（规范化 JSON + SHA-256 + 固定 prompt）、`candidate-workspace.mjs`（source 快照 + manifest + sibling + 形态/路径校验）、`host-runner.mjs`（handoff / candidate 编排）。
- **安全模型**：source 永不自动覆盖；Claude 只写 workspace 内 candidate，host 校验后复制 sibling；run 记录只存元数据；无 promote/overwrite/auto-accept 路径。candidate 的 `--allowed-tools` 仅 `Read,Glob,Grep,Write`，handoff 仅只读。
- **artifact 协议（v0.6.2）**：逻辑文档 ID + artifact SHA-256；候选经 `new_artifact` 受控路径打开，base hash 不一致即拒绝导航/链接。
- **存储**：扩展用 IndexedDB（`annotations` / `versions` / `documents` / `artifact_versions` / `bridge_sessions` / `bridge_runs`，DB v4）；协同模式才走自托管后端。

## 架构（骨架决策 · 协同后端层，可选）

- **S1** 标准 selector · **S2** 评论与版本解耦 · **S3** 非侵入 overlay · **S4** 统一 payload · **S5** sink 抽象（导出 sink 已实现）· **S6** 存储留字段。
- 分层：`存储层(SQLite)` → `定位引擎(text-quote anchoring)` → `评论运行时(overlay)` → `回灌层(sink)` → `宿主(FastAPI)`。

## 多人协同后端（v0.5：飞书 OAuth + session）

```bash
HG_LARK_APP_ID=cli_xxx HG_LARK_APP_SECRET=sec_xxx \
HG_AUTH_ALLOW_DEV=1 \
uv run uvicorn server.app:app --port 8000 --reload
```

| env | 用途 | 默认 |
|---|---|---|
| `HG_LARK_APP_ID` / `HG_LARK_APP_SECRET` | 飞书自建应用凭据（真 OAuth 必填） | — |
| `HG_DEFAULT_TEAM` | `tenant_key` 缺失时的 team_id 回退（单组织=单团队） | `"default"` |
| `HG_AUTH_ALLOW_DEV` | 开放 `/auth/dev-login` 旁路（本地开发/测试，**生产必须 `0`**） | `"0"` |
| `HG_SESSION_TTL` | session 有效期（秒） | `604800`（7 天） |
| `HG_LARK_BASE` | 飞书 API 域名（国际版 Larksuite 改之） | `https://open.feishu.cn` |

鉴权：扩展走 `chrome.identity.launchWebAuthFlow` → `/auth/lark/login` → 飞书授权 → `/auth/lark/callback` 换 session token；后续请求带 `Authorization: Bearer <session_token>`。批注 author = 飞书 `open_id`（后端 session 注入，硬身份）。批注写后经 SSE 广播 `annotation:created` / `annotation:updated` / `annotation:deleted`；作者可编辑（`PATCH /api/annotations/:id`，跨团队/非作者 403）、删除（级联子树）自己的批注。所有数据自存自管（SQLite），不用 SaaS。

完整部署（Nginx SSE 关 buffering、HTTP/2、env 文件、manifest `host_permissions`、飞书后台重定向 URI、稳定 URL 约束、集成验收矩阵、常见坑）：见 [`docs/2026-07-05-v0.4-deploy.md`](docs/2026-07-05-v0.4-deploy.md)（含 v0.5 补充）。

### 稳定 URL 约束（跨版本 re-anchor 的前提）

生成的 HTML **必须挂在不含版本号的稳定 URL** 上（如 `/d/spec`，而非 `/d/spec/v2`）。版本切换由后端取 current，URL 保持不变——这样回灌 AI 重写出的新版本挂回同一 URL 后，旧批注才能基于 text-quote selector 自动 re-anchor 到新内容。

## 已知技术边界

- **仅作者删除为硬约束（v0.5 起）**：author = 飞书 `open_id`，由后端 session 注入；删除校验 `session.open_id`，不可伪造。
- **飞书 authen V2**：实现采用 V2（`/authen/v2/oauth/token` + `/authen/v2/user_info`，标准 OAuth2；V1 已被飞书标为历史版本）。授权页 `accounts.feishu.cn/open-apis/authen/v1/authorize`。真机联调若 `user_info` 路径不符，改 `server/lark.py` 即可。
- **session 滑动续期**：剩余 < 1 天时，鉴权请求自动续一个 TTL（活跃即不过期，闲置 7 天才失效）。
- **严格 CSP 第三方站点回退轮询**：content-script 里直接跑 `EventSource` 连后端，若被批注页面下发了严格的 `Content-Security-Policy: connect-src`，SSE 会被页面 CSP 拦下；此时退化为定时 `GET /api/annotations` 轮询对账（数据不丢，只是不实时）。MV3 `host_permissions` 只控扩展自己的跨域权限，管不到页面 CSP。
- **EventSource 在 content-script**：SSE 连接随页面生命周期，关标签即断（`bye` 心跳负责 presence 移除）。
- **RangeSelector 未实现**：选区跨多个块级元素时，exact 会被压成单段。
- **章节锚点兜底**：依赖原文有 h1/h2/h3 结构；无标题时仅靠前后文消歧。

## 路线图

- ~~强身份鉴权：飞书 OAuth 替换 team-token~~（v0.5 已完成）。
- ~~元素级编辑 / 修改契约 / 本地版本对账~~（v0.6–v0.6.2 已完成）。
- ~~评论选择流 + 本机 Agent 交接 + 候选闭环~~（v0.7.1 / v0.7.2 / Night Pack A 已完成；候选只写、不覆盖原文件）。
- **M5 候选审查与提升**：source/candidate diff、修改范围审查、越界变化告警、用户**显式 promote**。候选生命周期 / hash / artifact relation / 重锚统计稳定后才做，**不提前设计 diff UI 格式或混入 promote**。
- **Codex adapter**：复用 `com.htmlgenius.local_bridge` host 接入 Codex（与 Claude Code 并列的 provider）。
- **群组管理 UI**：团队 / 成员 / 分享链接的可视化配置。
- **CRDT 实时协同编辑**：从 SSE 增量推送升级到 Postgres + Yjs。
- **登录态热切换**：登录后免刷新即接入协同（当前需刷新页面）。

## 设计与实现计划

| 版本 | 设计 | 计划 |
|---|---|---|
| v0.1（阶段 0） | [`docs/2026-06-25-html-annotation-feedback-loop-design.md`](docs/2026-06-25-html-annotation-feedback-loop-design.md) | [`docs/2026-06-25-stage0-plan.md`](docs/2026-06-25-stage0-plan.md) |
| v0.2 | [`docs/2026-06-27-v0.2-html-editing-design.md`](docs/2026-06-27-v0.2-html-editing-design.md) | [`docs/2026-06-27-v0.2-html-editing-plan.md`](docs/2026-06-27-v0.2-html-editing-plan.md) |
| v0.3 | [`docs/2026-06-30-v0.3-chrome-extension-design.md`](docs/2026-06-30-v0.3-chrome-extension-design.md) | [`docs/2026-06-30-v0.3-chrome-extension-plan.md`](docs/2026-06-30-v0.3-chrome-extension-plan.md) |
| v0.4 | [`docs/2026-07-05-v0.4-plugin-collab-design.md`](docs/2026-07-05-v0.4-plugin-collab-design.md) | [`docs/2026-07-05-v0.4-plugin-collab-plan.md`](docs/2026-07-05-v0.4-plugin-collab-plan.md) |
| v0.4.1 | [`docs/2026-07-06-v0.4.1-ui-redesign-design.md`](docs/2026-07-06-v0.4.1-ui-redesign-design.md) | — |
| v0.5 | [`docs/2026-07-06-v0.5-lark-oauth-design.md`](docs/2026-07-06-v0.5-lark-oauth-design.md) | [`docs/2026-07-06-v0.5-lark-oauth-plan.md`](docs/2026-07-06-v0.5-lark-oauth-plan.md) |
| v0.5 验收 | — | [`docs/2026-07-08-v0.5-acceptance-tests.md`](docs/2026-07-08-v0.5-acceptance-tests.md) |
| v0.5.1 / v0.5.2 | — | — |
| v0.6 | [`docs/2026-07-15-v0.6-element-editing-design.md`](docs/2026-07-15-v0.6-element-editing-design.md) | — |
| v0.6.1 | [`docs/2026-07-18-v0.6.1-change-contract-spec.md`](docs/2026-07-18-v0.6.1-change-contract-spec.md) | — |
| v0.6.2 | — | [`docs/2026-07-18-v0.6.2-artifact-version-reconciliation-plan.md`](docs/2026-07-18-v0.6.2-artifact-version-reconciliation-plan.md) |
| v0.7 | [`docs/2026-07-18-v0.7-codex-local-bridge-spec.md`](docs/2026-07-18-v0.7-codex-local-bridge-spec.md) | — |
| v0.7.1 | [`docs/2026-07-19-v0.7.1-claude-code-handoff-spec.md`](docs/2026-07-19-v0.7.1-claude-code-handoff-spec.md) | — |
| v0.7.2（选择流） | [`docs/2026-07-20-v0.7.1-comment-task-selection-ui-spec.md`](docs/2026-07-20-v0.7.1-comment-task-selection-ui-spec.md) | — |
| Night Pack A（候选闭环） | [`docs/2026-07-20-night-pack-a-candidate-closed-loop-spec.md`](docs/2026-07-20-night-pack-a-candidate-closed-loop-spec.md) | [`docs/implementation-notes/2026-07-20-night-pack-a-preflight.md`](docs/implementation-notes/2026-07-20-night-pack-a-preflight.md) |
| v0.4 部署 | — | [`docs/2026-07-05-v0.4-deploy.md`](docs/2026-07-05-v0.4-deploy.md) |

> 路线 ↔ 代码的**唯一事实层**：[`docs/CURRENT_IMPLEMENTATION_STATE.md`](docs/CURRENT_IMPLEMENTATION_STATE.md)（每次施工后整体重写）。本机 Agent 桥安装/登录/诊断：[`docs/LOCAL_BRIDGE.md`](docs/LOCAL_BRIDGE.md)。
