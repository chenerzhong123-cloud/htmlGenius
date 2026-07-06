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
uv run pytest -v          # 全量 69 项（Python 3.9）
```

覆盖：健康检查 / 数据模型 / SQLite 存储 / HTTP API / 定位算法 / 端到端重定位 / UI e2e / 编辑器·工具栏·序列化·sanitize / 版本管理 / v0.4 协同（schema 迁移 · team token 鉴权 · SSE 房间 · 写后广播 · presence GC · 仅作者删除级联）。

## 架构（骨架决策）

- **S1** 标准 selector · **S2** 批注与版本解耦 · **S3** 非侵入 overlay · **S4** 统一 payload · **S5** sink 抽象（导出 sink 已实现）· **S6** 存储留字段。
- 分层：`存储层(SQLite)` → `定位引擎(text-quote anchoring)` → `批注运行时(overlay)` → `回灌层(sink)` → `宿主(FastAPI)`。

## 多人协同后端

```bash
HG_TEAMS='{"tok_alpha_a3f9b2e7":"team_alpha"}' uv run uvicorn server.app:app --port 8000 --reload
```

`HG_TEAMS` 是 JSON map：**键 = 团队 token（随机串），值 = team_id**；多团队逗号分隔。不配或 JSON 非法 → 所有需鉴权接口 401。所有数据自存自管（SQLite 文件），不依赖任何第三方 SaaS。

完整部署（Nginx SSE 关 buffering、HTTP/2、`HG_TEAMS` 环境文件、manifest `host_permissions`、稳定 URL 约束、集成验收矩阵、常见坑）：见 [`docs/2026-07-05-v0.4-deploy.md`](docs/2026-07-05-v0.4-deploy.md)。

### 稳定 URL 约束（跨版本 re-anchor 的前提）

生成的 HTML **必须挂在不含版本号的稳定 URL** 上（如 `/d/spec`，而非 `/d/spec/v2`）。版本切换由后端取 current，URL 保持不变——这样回灌 AI 重写出的新版本挂回同一 URL 后，旧批注才能基于 text-quote selector 自动 re-anchor 到新内容。

## 已知技术边界

- **仅作者删除为软约束**：team-token 鉴权下，「仅作者」靠 header 里的用户名，不是强身份——拿到 token 的人可伪造任意作者名强行删（后端无法区分）。硬化成硬约束需上 OAuth/飞书鉴权（下一阶段）。
- **严格 CSP 第三方站点回退轮询**：content-script 里直接跑 `EventSource` 连后端，若被批注页面下发了严格的 `Content-Security-Policy: connect-src`，SSE 会被页面 CSP 拦下；此时退化为定时 `GET /api/annotations` 轮询对账（数据不丢，只是不实时）。MV3 `host_permissions` 只控扩展自己的跨域权限，管不到页面 CSP。
- **EventSource 在 content-script**：SSE 连接随页面生命周期，关标签即断（`bye` 心跳负责 presence 移除）。
- **RangeSelector 未实现**：选区跨多个块级元素时，exact 会被压成单段。
- **章节锚点兜底**：依赖原文有 h1/h2/h3 结构；无标题时仅靠前后文消歧。

## 路线图

- **强身份鉴权**：飞书 OAuth 替换 team-token（硬化仅作者删除），随后开放协同入口。
- **群组管理 UI**：团队 / 成员 / 分享链接的可视化配置。
- **Postgres + Yjs**：从 SSE 增量推送升级到 CRDT 实时协同编辑。

## 设计与实现计划

| 版本 | 设计 | 计划 |
|---|---|---|
| v0.1（阶段 0） | [`docs/2026-06-25-html-annotation-feedback-loop-design.md`](docs/2026-06-25-html-annotation-feedback-loop-design.md) | [`docs/2026-06-25-stage0-plan.md`](docs/2026-06-25-stage0-plan.md) |
| v0.2 | [`docs/2026-06-27-v0.2-html-editing-design.md`](docs/2026-06-27-v0.2-html-editing-design.md) | [`docs/2026-06-27-v0.2-html-editing-plan.md`](docs/2026-06-27-v0.2-html-editing-plan.md) |
| v0.3 | [`docs/2026-06-30-v0.3-chrome-extension-design.md`](docs/2026-06-30-v0.3-chrome-extension-design.md) | [`docs/2026-06-30-v0.3-chrome-extension-plan.md`](docs/2026-06-30-v0.3-chrome-extension-plan.md) |
| v0.4 | [`docs/2026-07-05-v0.4-plugin-collab-design.md`](docs/2026-07-05-v0.4-plugin-collab-design.md) | [`docs/2026-07-05-v0.4-plugin-collab-plan.md`](docs/2026-07-05-v0.4-plugin-collab-plan.md) |
| v0.4.1 | [`docs/2026-07-06-v0.4.1-ui-redesign-design.md`](docs/2026-07-06-v0.4.1-ui-redesign-design.md) | — |
| v0.4 部署 | — | [`docs/2026-07-05-v0.4-deploy.md`](docs/2026-07-05-v0.4-deploy.md) |
