# htmlGenius · Beta v0.1

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
uv run pytest -v          # 全量 19 项(Python 3.9)
```

覆盖:健康检查 / 数据模型 / SQLite 存储 / HTTP API(含删除)/ Locator 三件套(生成·重定位·消歧)/ 端到端重定位(退出标准)/ UI e2e(浮层·侧栏·删除·归档·回灌 prompt·overlay 不破坏 DOM·卡片 transform 跟随)。

## 架构(骨架决策,spec §5)

S1 标准 selector · S2 批注与版本解耦 · S3 非侵入 overlay · S4 统一 payload · S5 sink 抽象(导出 sink 已实现)· S6 存储留字段。

分层:`存储层(SQLite)` → `定位引擎(text-quote anchoring)` → `批注运行时(overlay)` → `回灌层(sink)` → `宿主(FastAPI)`。

## 已知边界(Beta)

- **单用户、本地**:SQLite 单文件、无鉴权、无实时协同(阶段 B 换 Postgres + WebSocket/Yjs)。
- **回灌为人驱动**:复制 prompt → 人工粘贴 AI 会话(非自动重写);CLI 自动注入 / 网页对话框为后续演进。
- **RangeSelector 未实现**:选区跨多个块级元素时,exact 会被压成单段(spec §11 后续)。
- **章节锚点兜底**:依赖原文有 h1/h2/h3 结构;无标题时仅靠前后文消歧。

## 下一阶段

- **阶段 A 收尾**:版本管理 UI(回灌后新版本入库、历史切换)、action 在卡片上可编辑(rewrite/delete/question)。
- **阶段 B**:群组协同(多人实时批注、飞书 OAuth、分享链接)。
