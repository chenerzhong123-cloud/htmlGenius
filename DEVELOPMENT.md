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
#   apply-delta / sync / remote-store / version / login / invite-email-login / site-export /
#   comment-task-selection）
```

浏览器测试页可用 **jsdom** 无头驱动（注入 `crypto.webcrypto` + `indexedDB`(fake-indexeddb) + `fetch` 后 `runScripts:"dangerously"`，轮询 `document.title`）；390px 三态截图用 **puppeteer-core + 系统 Chrome（headful）**。`/tmp` 下常备 `puppeteer-core / jsdom / fake-indexeddb` 用于本地复现与截图。真实 Claude Code 运行属手工 smoke（消耗本机额度），自动化用假 CLI 覆盖，**不得伪造通过**。

覆盖：Change Contract 构建/校验/序列化 · 评论选择流（初始全选 / 取消后 rootIds 精确相等 / reply 不勾选 / stale 过滤 / M=0 禁用 / 关闭清空）· artifact 版本对账 · 撤销重做 · 候选工作区不可覆盖协议（snapshot 0400 / manifest 0600 / sibling 原子 / 形态校验 / symlink 逃逸防御）· 候选执行编排（写候选→sibling+ready manifest / 写 Markdown 拒绝 / source 突变拒绝）· argv 注入安全。

### 协同后端（Python，可选）

```bash
uv run pytest -v          # 仅多人协同自托管后端
```

覆盖：健康检查 / 数据模型 / SQLite 存储 / HTTP API / 定位算法 / 端到端重定位 / UI e2e / 编辑器·工具栏·序列化·sanitize / 版本管理 / v0.4 协同（schema 迁移 · SSE 房间 · 写后广播 · presence GC · 仅作者删除级联）/ v0.5 飞书 OAuth（sessions · lark 客户端 · require_session · /auth 端点 · 硬身份作者）/ v0.5.1 评论编辑（PATCH 作者校验 · 跨团队/非作者 403 · 不存在 404）/ 邀请码 + 邮箱验证码免密码入团 / 按团队与网站 origin 聚合未解决评论。

## 架构（Chrome 扩展 + 本机 Agent 桥，主形态）

- **content-script**（注入页面）：text-quote 定位、非侵入 overlay、富文本/元素级编辑、`get-export`/`artifact-update-ready` 受控消费（打开新版本 + 重锚）。
- **sidepanel**：评论收件箱 / 评论选择流 / 整站评论 Prompt 导出 / 邀请码 + 邮箱免密码入团 / Change Contract 表单 / 本机 Agent 发送与只读结果态；状态机用 `data-step="select|compose"` 显式表达，临时选择只存内存。
- **background**（service worker）：`bridge-start` 严格校验（自取 artifact state、`run_kind` 透传、restructure 拒绝 candidate）→ 连 Native Host → 路由 host 事件 → completion 逐字段双校验。v0.9.13：「精准修补」+ provider 支持 `patch` 时内部升级为 `patch_preview`/`patch_apply` 两阶段（预览可确认 / 直接应用，坏 JSON 自动回落 candidate）。
- **bridge/**（Node Native Messaging host，`com.htmlgenius.local_bridge`，provider-neutral）：`claude-cli.mjs`（固定 argv、`shell:false`、auth、超时）、`task-bundle.mjs`（规范化 JSON + SHA-256 + 固定 prompt）、`candidate-workspace.mjs`（source 快照 + manifest + sibling + 形态/路径校验）、`patch-edits.mjs`（v0.9.13 确定性编辑：编辑 schema 校验 + 范围映射 + 文本级外科应用，未改字节逐字保留）、`host-runner.mjs`（handoff / candidate / plan / patch 编排）。
- **安全模型**：source 永不自动覆盖；Claude 只写 workspace 内 candidate，host 校验后复制 sibling；run 记录只存元数据；无 promote/overwrite/auto-accept 路径。candidate 的 `--allowed-tools` 仅 `Read,Glob,Grep,Write`，handoff / patch 仅只读（patch 模式 Claude 只输出结构化编辑 JSON、不写任何文件，由 host 确定性应用）。
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
| `HG_LARK_APP_ID` / `HG_LARK_APP_SECRET` | 飞书自建应用凭据（真 OAuth 必填）;v0.9.17 起 `APP_SECRET` 同时是 OAuth state 签名密钥,**生产缺失时 `/auth/lark/login` fail-closed → 503**(不再回退公开常量) | — |
| `HG_DEFAULT_TEAM` | `tenant_key` 缺失时的 team_id 回退（单组织=单团队） | `"default"` |
| `HG_AUTH_ALLOW_DEV` | 开放 `/auth/dev-login` 旁路（本地开发/测试，**生产必须 `0`**） | `"0"` |
| `HG_SESSION_TTL` | session 有效期（秒） | `604800`（7 天） |
| `HG_LARK_BASE` | 飞书 API 域名（国际版 Larksuite 改之） | `https://open.feishu.cn` |
| `HG_ENV` | 环境标识;`dev`/`test`/`local` 等视为非生产(开放 dev-login、流密钥用一次性内存兜底);未设或 `production` 等一律按生产(安全默认) | 生产 |
| `HG_STREAM_SECRET` | SSE 流票据签名密钥;**生产必填**,缺失则 `POST /api/stream/ticket` fail-closed → 503(飞书部署可用 `HG_LARK_APP_SECRET` 兼作来源) | — |
| `HG_MAX_TEAMS_PER_USER` | 单用户可拥有的团队数上限(防团队/文档无序蔓延) | `10` |
| `HG_SMTP_HOST` / `HG_SMTP_PORT` | 邮箱验证码发信 SMTP(留空=**日志模式**,验证码打到 stdout 不真实发信;配了走 `smtplib` SSL)。生产推荐阿里云邮件推送(`smtpdm.aliyun.com:465`) | 空(日志模式) |
| `HG_SMTP_USER` / `HG_SMTP_PASS` | SMTP 登录账号 / 密码(阿里云邮件推送=发信地址 + 控制台设的 SMTP 密码;个人邮箱=邮箱地址 + 授权码) | — |
| `HG_SMTP_FROM` | 发件人地址(默认取 `HG_SMTP_USER`) | — |

### Zeabur 部署

仓库根目录的 `Dockerfile` 固定使用 Python 3.12、uv 与 Uvicorn，并只安装生产依赖；这样可避免 Zeabur 因开发依赖中的 Playwright 自动安装浏览器。`zbpack.json` 保留为非 Docker 构建器的启动配置。首次部署后必须在 Zeabur 为服务挂载持久卷到 `/data`；镜像已设置 `HTMLEDITOR_DB=/data/annotations.db`，未挂卷时 SQLite 会随重新部署丢失。生产环境还必须设置 `HG_ENV=production`、随机生成的 `HG_STREAM_SECRET`，以及上表中的 SMTP 发信变量。部署后至少检查 `/healthz`、邮箱验证码投递、免密码邀请加入和整站评论导出。

**邮箱登录(邮箱 + 密码 · 带 email 验证码)**:第三个 provider,与 Google/飞书并存,服务无 VPN 用户。端点 `/auth/email/{register,verify,login,resend}`;注册带邮箱验证码(验证码服务端只存 pbkdf2 哈希)。身份模型统一为 `user_id`——老 Google 数据 `user_id == google_sub`,迁移纯改名+加列、零数据改写、幂等;邮箱用户可凭邀请码加入团队、与 Google 用户协作。邮件 env 未配=日志模式(开发/测试用,验证码进服务端日志,解耦邮件基建)。

**免密码邀请加入**：受邀者调用 `/auth/invite-email/request` 提交邀请码与邮箱；服务端先校验邀请，再发送 6 位、10 分钟有效且最多尝试 5 次的验证码。`/auth/invite-email/verify` 验证邮箱归属后原子兑换邀请、创建或复用邮箱身份并签发普通 team session，全程不设置或存储密码。客户端默认在当前设备启用该 session 的自动恢复。

**整站评论导出**：`GET /api/site-annotations?site_origin=https://example.com&status=open` 必须携带 session，只查询当前 `team_id` 且 `document_id` 属于精确 HTTP(S) origin 的评论；默认上限 1000、最大 5000，并显式返回 `truncated`。扩展将结果按页面分组、剔除团队标识后生成结构化 Prompt 并仅写入本机剪贴板。

**匿名使用统计(漏斗埋点 · v0.9.16)**:双写架构——扩展侧 `analytics-core.js`(纯函数:白名单/seq/游标/GA 时间窗) + `analytics.js`(页面薄壳) + background SW 单写者队列(`chrome.storage.local` 的 `hg_events`/`hg_cursors`,上限 500 条);事件经 `POST /api/events`(无鉴权、每 IP 每分钟 30 次 `WindowLimiter` 限流、每请求 ≤50 条 + 32KB 413、事件名与参数值双层白名单、`UNIQUE(client_id,seq)` 幂等、90 天惰性清理)落 `analytics_events` 表,GA4 走 Measurement Protocol 直发(`config.js` 的 `ga_measurement_id`/`ga_api_secret` 为空时整路跳过)。重试语义为"下次唤醒时整段补发"(不申请 alarms 权限);GA 补发受 72h 回填上限约束(≤72h 真实时间戳 / ≤7 天钳制 / 超出放弃)。

鉴权：扩展走 `chrome.identity.launchWebAuthFlow` → `/auth/lark/login` → 飞书授权 → `/auth/lark/callback` 换 session token；后续请求带 `Authorization: Bearer <session_token>`。批注 author = 飞书 `open_id`（后端 session 注入，硬身份）。批注写后经 SSE 广播 `annotation:created` / `annotation:updated` / `annotation:deleted`；作者可编辑（`PATCH /api/annotations/:id`，跨团队/非作者 403）、删除（级联子树）自己的批注。所有数据自存自管（SQLite），不用 SaaS。

**团队地基（v0.9.x · scope A）**：文档/版本按 `(team_id, document_id)` 复合主键强制隔离（修跨租户 IDOR,R-1）；流密钥生产必填（R-3 fail-closed,缺失 → SSE 票据 503）；建团者=owner,可解散团队（级联删数据）/移除成员,任意成员可生邀请码;Lark 团队=飞书租户,成员由飞书后台管（治理端点仅适用 Google 自建团队）。详见本地 `docs/2026-08-02-team-foundation-design.md`。

完整部署（Nginx SSE 关 buffering、HTTP/2、env 文件、manifest `host_permissions`、飞书后台重定向 URI、稳定 URL 约束、集成验收矩阵、常见坑）：详见本地 `docs/2026-07-05-v0.4-deploy.md`（含 v0.5 补充；该文档为本地工作文档，已 `.gitignore`，不入库）。

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

## Bridge 发布到 npm

`@htmlgenius/bridge` 用 **npm Trusted Publishing（GitHub OIDC）** 发布——**免长效 token、免 OTP**。npm 废弃 bypass token（Automation/Granular）用于 direct publishing 后，旧 `NPM_TOKEN`+publish 已失效（CI 报 E404/EOTP），已迁移到 trusted publishing（1.0.2 起验证可用）。

- **日常发布（全自动）**：改 `bridge/package.json` 版本 + 同步三处引用 → commit → push 分支 → 推 tag：
  ```bash
  git tag bridge-v<ver> && git push origin bridge-v<ver>
  # CI(macos-latest)升 npm≥11.5.1 → npm ci → npm test → npm publish(OIDC) → 看 Actions 跑通:
  npm view @htmlgenius/bridge@<ver> version
  ```
  - CI 挂了重发：`git tag -f bridge-v<ver> <commit>` → `git push origin :refs/tags/bridge-v<ver>` → `git push origin bridge-v<ver>`（删旧+推新；勿用 `--force`）。
- **前置（npmjs.com，已配）**：`@htmlgenius/bridge` → Settings → Trusted Publisher → GitHub Actions：owner=`chenerzhong123-cloud`、repo=`htmlGenius`、workflow=`publish-bridge.yml`（精确匹配）。要求 npm≥11.5.1、Node≥22.14。
- **本地兜底（需 OTP，仅应急）**：`cd bridge && npm publish --otp=<6位码>`。`NPM_TOKEN` 在 `~/.zshenv`（`~/.npmrc` 用 `${NPM_TOKEN}` 引用）；`npm token list` 看类型。

升版**必须同步**所有引用点（`extension/background.js` 的 `TARGET_BRIDGE_VERSION`、官网 `shared.js` 的 `bridgeVersion`、`setup.html` 的 npx 命令），详见 `CLAUDE.md`「Bridge 版本升级」。发 bridge 与扩展发版（商店 dist）、阿里云后端部署是三件独立的事。

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
| v0.1（阶段 0） | 已归档（v0.9.1 起不随仓库分发） | 已归档 |
| v0.2 | 已归档 | 已归档 |
| v0.3 | 已归档 | 已归档 |
| v0.4 | 已归档 | 已归档 |
| v0.4.1 | 已归档 | — |
| v0.5 | 已归档 | 已归档 |
| v0.5 验收 | — | 已归档 |
| v0.5.1 / v0.5.2 | — | — |
| v0.6 | 本地 `docs/`（不入库） | — |
| v0.6.1 | 本地 `docs/`（不入库） | — |
| v0.6.2 | — | 本地 `docs/`（不入库） |
| v0.7 | 本地 `docs/`（不入库） | — |
| v0.7.1 | 本地 `docs/`（不入库） | — |
| v0.7.2（选择流） | 本地 `docs/`（不入库） | — |
| Night Pack A（候选闭环） | 本地 `docs/`（不入库） | 本地 `docs/`（不入库） |
| v0.4 部署 | — | 本地 `docs/`（不入库） |

> v0.6 起的各版本设计 / 实现计划均为**本地工作文档**，存于本地 `docs/`（已 `.gitignore`，不入库），需要时本机查阅。路线 ↔ 代码的**唯一事实层**为本地 `docs/CURRENT_IMPLEMENTATION_STATE.md`（每次施工后整体重写，不入库）。本机 Agent 桥安装/登录/诊断：[`LOCAL_BRIDGE.md`](LOCAL_BRIDGE.md)。
