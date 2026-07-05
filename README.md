# htmlGenius · v0.4(多人协同批注)

> 在 HTML 上划词批注 → 一键复制结构化 prompt → 粘贴给 AI 改 → 闭环。
> 非侵入 overlay 高亮 + 飞书式锚定侧边栏,不破坏原文 DOM。

htmlGenius 把「AI 生成的 HTML」变成可批注、可回灌的闭环:你在浏览器里对 HTML 划词写评论,系统把批注组装成带「前文 + 原文 + 后文」精确定位的 prompt 复制到剪贴板,粘贴进 Claude Code / 任意 AI 会话即可让其逐条修改。设计文档见 `docs/2026-06-25-html-annotation-feedback-loop-design.md`,阶段 0 实现计划见 `docs/2026-06-25-stage0-plan.md`。

## Beta v0.1 功能

- **划词批注**:选中正文 → 选区正上方弹出「批注」按钮 → inline 写评论 → 提交(不再松手即触发,稳定可控)。
- **overlay 高亮(非侵入)**:DOM Range 完全不动,半透明矩形覆盖选区,`pointer-events:none`——绝不破坏原文结构(目录编号、章节内容都不会再崩)。
- **飞书式锚定侧边栏**:批注卡片贴在对应原文行的右侧、同高;滚动正文时侧栏用 `transform` 同步跟随(GPU 合成、无 reflow,顺滑);相邻卡片自动避让。
- **跨版本重定位 + 自动归档**:基于 TextQuoteSelector(exact+prefix+suffix),原文还在→自动重定位;原文被改/删→自动归档到「已归档」区(数据保留、可删),主列表只留待处理项。
- **删除批注**:每张卡片可删除(`DELETE /api/annotations/{id}`)。
- **回灌 sink**:工具栏「回灌」→ 把所有批注组装成结构化 prompt(三段联合定位 + 章节兜底 + 总指令:只改命中处 / question 入清单 / 输出完整 HTML)→ 复制剪贴板。
- **Locator**:忠实复刻 Hypothesis text-quote anchoring 算法(BSD-2,源码标注来源)。

## 运行

```bash
uv run uvicorn server.app:app --port 8000 --reload
```

浏览器打开:
- 卡片样本:`http://localhost:8000/static/viewer.html?doc=01_token`(也支持 `02_rag` / `03_fine-tuning`)
- 本项目 spec(dogfooding):`http://localhost:8000/static/viewer.html?doc=spec`

> 改前端/后端文件,`--reload` 自动重载。浏览器侧若看不到新效果,用**无痕窗口**或 DevTools → Network → Disable cache。

## 测试

```bash
uv run pytest -v          # 全量 69 项(Python 3.9)
```

覆盖:健康检查 / 数据模型 / SQLite 存储 / HTTP API / Locator 三件套 / 端到端重定位 / UI e2e / 编辑器·工具栏·序列化·sanitize / 版本管理 / **v0.4 协同(schema 迁移 · team token 鉴权 · SSE 房间 · 写后广播 · presence GC · 仅作者删除级联)**。

## 架构(骨架决策,spec §5)

S1 标准 selector · S2 批注与版本解耦 · S3 非侵入 overlay · S4 统一 payload · S5 sink 抽象(导出 sink 已实现)· S6 存储留字段。

分层:`存储层(SQLite)` → `定位引擎(text-quote anchoring)` → `批注运行时(overlay)` → `回灌层(sink)` → `宿主(FastAPI)`。

## v0.2 新增:HTML 实时编辑

- **contenteditable 常驻**:整文档可编辑,光标直接改文字。
- **浮工具栏**:选中文字 → 浮栏(加粗 / 颜色 / 字号 / 对齐)。
- **自动版本**:编辑防抖自动存版本(滚动窗口最近 20 版,超删旧;删版本时批注引用迁移到当前版)。
- **撤销**:Ctrl+Shift+Z(内存栈 50 步,避开浏览器原生 Ctrl+Z 的字符级 undo 死结)。
- **结构安全**:粘贴纯文本(防外部污染)、还原 sanitize(去 script/on*)、序列化剥离注入元素、SQLite WAL + 单事务。
- **编辑↔批注并存**:编辑改 DOM 后批注 debounce re-anchor;text-quote 最低分门槛避免静默漂移到错误位置。
- 设计:`docs/2026-06-27-v0.2-html-editing-design.md`;计划:`docs/2026-06-27-v0.2-html-editing-plan.md`。

## v0.4 新增:多人协同批注(自托管后端 + Chrome 插件)

在 v0.3 插件基础上接入**自托管 FastAPI 后端**,实现团队内实时协同批注。**所有数据自存自管**(SQLite 文件 + 团队 token 鉴权),不依赖任何第三方 SaaS。

- **SSE 实时推送**:写走 REST、推走 SSE(单向 server→client);A 划词 → B/C 秒级出高亮 + 卡片;EventSource 自动重连,重连后 `GET` 全量对账。
- **团队 token 鉴权**:管理员造随机串(如 `tok_alpha_a3f9b2e7`),配进后端 env;token → `team_id` 注入,**批注按 team 隔离**(team A 查不到 team B 数据,前端塞 body.team_id 被忽略以 token 为准)。
- **多级回复**:批注支持 `parent_id`,卡片 hover → 回复,任意深度线索树(DFS 重建)。
- **仅作者删除 + 级联**:hover 卡片出删除按钮(仅作者可见);删除级联整棵子树并提示 N 条;非作者调 `DELETE` 返回 403。
- **一键复制全量**:底栏「复制所有评论」用 DFS 遍历顶层 + 所有嵌套回复,产物含全部层级。
- **presence 在线状态**:进入文档即加入房间并广播;60s 无心跳自动 GC 移除;关标签后他端看到离线。
- **编辑/查看 toggle**:底栏切换 contenteditable 常驻编辑模式与只读查看模式。
- **跨版本重锚定**:AI 重写产出新版本挂在**同一稳定 URL**(`/d/<document_id>`,URL 不含版本号),批注基于 text-quote selector 自动 re-anchor 到新版本。

> 设计:`docs/2026-07-05-v0.4-plugin-collab-design.md`;计划:`docs/2026-07-05-v0.4-plugin-collab-plan.md`;部署清单:`docs/2026-07-05-v0.4-deploy.md`。

### 后端起服

```bash
HG_TEAMS='{"tok_alpha":"team_alpha"}' uv run uvicorn server.app:app --port 8000 --reload
```

`HG_TEAMS` 是一个 JSON map:键是团队 token,值是 team_id。多个团队用逗号分隔:`'{"tok_a":"team_a","tok_b":"team_b"}'`。

### 插件配置

1. `chrome://extensions` → 打开开发者模式 → 「加载已解压的扩展程序」→ 选 `extension/` 目录。
2. 打开任意被批注的 HTML 页面,点扩展图标打开 side panel。
3. side panel 切到「**协同**」标签页,填:**后端地址**(如 `https://api.example.com`)、**团队 token**(对应 `HG_TEAMS` 里的某个键)、**你的名字**(presence 显示用)→ 点「保存」。
4. **刷新被批注页面**——content-script 重新注入后即接入 SSE。

### 稳定 URL 约束(跨版本 re-anchor 的前提)

生成的 HTML **必须挂在不含版本号的稳定 URL** 上(如 `/d/spec`,而非 `/d/spec/v2`)。版本切换由后端取 current,URL 保持不变——这样回灌 AI 重写出的新版本后,旧批注才能基于同一 URL + text-quote selector 自动 re-anchor 到新内容。若 URL 带版本号,跨版本锚定会断。

### 已知边界(v0.4)

- **仅作者删除为软约束**:在 team-token 鉴权下,「仅作者」靠 header 里的用户名,**不是强身份**——拿到 token 的人可伪造任意作者名强行删(后端无法区分)。要硬化成硬约束需上 OAuth/飞书鉴权(v0.5 范畴)。
- **严格 CSP 第三方站点回退轮询**:content-script 里直接跑 `EventSource` 连后端,若被批注页面下发了严格的 `Content-Security-Policy: connect-src`,SSE 会被页面 CSP 拦下;此时退化为定时 `GET /api/annotations` 轮询对账(数据不丢,只是不实时)。MV3 `host_permissions` 只控扩展自己的跨域权限,管不到页面 CSP。
- **EventSource 在 content-script**:SSE 连接随页面生命周期,关标签即断(`bye` 心跳负责 presence 移除)。

## 已知边界(Beta)

- **v0.4 协同为 team-token 级**:**不是**强身份鉴权(见上「仅作者删除为软约束」);飞书 OAuth 为后续演进。
- **回灌为人驱动**:复制 prompt → 人工粘贴 AI 会话(非自动重写);CLI 自动注入 / 网页对话框为后续演进。
- **RangeSelector 未实现**:选区跨多个块级元素时,exact 会被压成单段(spec §11 后续)。
- **章节锚点兜底**:依赖原文有 h1/h2/h3 结构;无标题时仅靠前后文消歧。

## 下一阶段

- **强身份鉴权**:飞书 OAuth 替换 team-token(硬化仅作者删除)。
- **群组管理 UI**:团队/成员/分享链接的可视化配置。
- **Postgres + Yjs**:从 SSE 增量推送升级到 CRDT 实时协同编辑。
