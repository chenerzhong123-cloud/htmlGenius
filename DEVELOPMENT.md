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

```bash
uv run pytest -v          # 全量 87 项（Python 3.9）
```

覆盖：健康检查 / 数据模型 / SQLite 存储 / HTTP API / 定位算法 / 端到端重定位 / UI e2e / 编辑器·工具栏·序列化·sanitize / 版本管理 / v0.4 协同（schema 迁移 · SSE 房间 · 写后广播 · presence GC · 仅作者删除级联）/ v0.5 飞书 OAuth（sessions · lark 客户端 · require_session · /auth 端点 · 硬身份作者）。

## 架构（骨架决策）

- **S1** 标准 selector · **S2** 批注与版本解耦 · **S3** 非侵入 overlay · **S4** 统一 payload · **S5** sink 抽象（导出 sink 已实现）· **S6** 存储留字段。
- 分层：`存储层(SQLite)` → `定位引擎(text-quote anchoring)` → `批注运行时(overlay)` → `回灌层(sink)` → `宿主(FastAPI)`。

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

鉴权：扩展走 `chrome.identity.launchWebAuthFlow` → `/auth/lark/login` → 飞书授权 → `/auth/lark/callback` 换 session token；后续请求带 `Authorization: Bearer <session_token>`。批注 author = 飞书 `open_id`（后端 session 注入，硬身份）。所有数据自存自管（SQLite），不用 SaaS。

完整部署（Nginx SSE 关 buffering、HTTP/2、env 文件、manifest `host_permissions`、飞书后台重定向 URI、稳定 URL 约束、集成验收矩阵、常见坑）：见 [`docs/2026-07-05-v0.4-deploy.md`](docs/2026-07-05-v0.4-deploy.md)（含 v0.5 补充）。

### 稳定 URL 约束（跨版本 re-anchor 的前提）

生成的 HTML **必须挂在不含版本号的稳定 URL** 上（如 `/d/spec`，而非 `/d/spec/v2`）。版本切换由后端取 current，URL 保持不变——这样回灌 AI 重写出的新版本挂回同一 URL 后，旧批注才能基于 text-quote selector 自动 re-anchor 到新内容。

## 已知技术边界

- **仅作者删除为硬约束（v0.5 起）**：author = 飞书 `open_id`，由后端 session 注入；删除校验 `session.open_id`，不可伪造。
- **飞书 authen 端点版本**：实现采用 v1 `/authen/v1/authorize` + `/authen/v1/access_token`；飞书另有 v2 端点，若 v1 不可用改 `server/lark.py` 端点字符串即可（流程不变）。
- **严格 CSP 第三方站点回退轮询**：content-script 里直接跑 `EventSource` 连后端，若被批注页面下发了严格的 `Content-Security-Policy: connect-src`，SSE 会被页面 CSP 拦下；此时退化为定时 `GET /api/annotations` 轮询对账（数据不丢，只是不实时）。MV3 `host_permissions` 只控扩展自己的跨域权限，管不到页面 CSP。
- **EventSource 在 content-script**：SSE 连接随页面生命周期，关标签即断（`bye` 心跳负责 presence 移除）。
- **RangeSelector 未实现**：选区跨多个块级元素时，exact 会被压成单段。
- **章节锚点兜底**：依赖原文有 h1/h2/h3 结构；无标题时仅靠前后文消歧。

## 路线图

- ~~强身份鉴权：飞书 OAuth 替换 team-token~~（v0.5 已完成）。
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
| v0.4 部署 | — | [`docs/2026-07-05-v0.4-deploy.md`](docs/2026-07-05-v0.4-deploy.md) |
