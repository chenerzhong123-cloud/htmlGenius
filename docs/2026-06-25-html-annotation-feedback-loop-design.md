# HTML 批注与反馈回灌闭环 — 设计文档

> 状态:Draft · 日期:2026-06-25 · 作者:与 Claude 协作
> 关联场景:`output/apple-static-mobile-100/`(100 篇 AI 科普卡片 HTML)、`lesson-learn-sharing.html`、`output/html-to-xhs-design.md`

---

## 1. 背景与动机

生成 HTML(而非 Markdown)正在成为内容生产的新主流:HTML 支持图文混排、自定义视觉,对人阅读友好。但 HTML 一旦生成,就暴露两个痛点:

1. **反馈回灌断链**:模型厂商(Claude/GPT)能让 HTML 在自家 CLI/应用会话内渲染并继续编辑,但普通用户生成的 HTML 离开会话后,想基于它做点评/优化,只能把要改的部分复制、编辑、再贴回会话——摩擦很大,闭环不成立。
2. **群组协同缺失**:HTML 不像飞书/钉钉文档那样支持"多人在线划词评论",难以在工作群里被共享和点评。

本项目作者已在大量生成 HTML(百篇 AI 科普卡片、分享页),上述痛点是每天亲历的真实场景。本设计要做一个**逐步演进**的系统:从"个人批注 + 反馈回灌闭环"出发,最终具备"群组协同"与"任意 HTML 可嵌入"的能力。

## 2. 目标与非目标

### 目标
- **G1 闭环**:在生成的 HTML 上划词批注 → 结构化回灌到 AI 会话 → AI 重写 → 新版本 HTML → 批注自动重定位,跑通完整回路。
- **G2 协同(后期)**:HTML 链接分享到群组后,多人可像飞书文档那样实时划词点评。
- **G3 可嵌入(后期)**:批注能力可作为组件嵌入任意 HTML 页面。
- **G4 演进友好**:核心架构在第一天就预留好,使 A→B→C 是"换实现"而非"改设计"。

### 非目标(YAGNI,明确排除以防范围蔓延)
- **不做富文本编辑器**:只对 HTML 做"批注",不改 HTML 内容本体;内容修改一律通过"回灌 → AI 重写 → 新版本"完成。
- **不做版本 diff 可视化 UI**:阶段 A 不做,后续视需要再加。
- **不做多模态批注**(图片/视频区域标注):阶段范围内只做文本选区批注。
- **不自建 AI**:回灌是"投递到已有的 AI 会话/API",系统本身不托管模型推理。

## 3. 核心洞察:骨架与血肉

系统的能力可分两类:
- **骨架(Structure)**:少数几个一旦第一天做错、后期推倒成本极高的设计决策。**必须在阶段 0 立对**——这就是"早期预留"。
- **血肉(Flesh)**:存储引擎、鉴权、实时同步、UI 等可随阶段替换升级的实现细节。

本设计的核心,是把骨架在阶段 0 用最小代码立住,血肉按 A→B→C 逐步替换。

## 4. 架构取向选择

| 取向 | 做法 | 代价 | 能否到 A/B/C |
|---|---|---|---|
| **① Web Annotation + 非侵入 overlay(选定)** | 批注用 W3C Web Annotation 标准定位,以浮层覆盖在 HTML 之上,不改 HTML 本体 | selector 重定位存在边界情况,需专门处理 | ✅ 全部满足 |
| ② 侵入式内联标注 | 往 HTML 注入 `<span>` / `data-*` | 破坏 HTML 纯净度,与 AI 重写互相破坏,无法注释第三方页面 | ⚠️ 堵死 C |
| ③ 寄生飞书/Notion 批注 | HTML 转成飞书文档再用其评论 | 失去自定义视觉,回灌需另接一层,受制平台 | ⚠️ 堵死回灌闭环 |

**选定取向①**:它是唯一让"早期预留"成立、且能同时满足 A/B/C 的取向。

## 5. 六个骨架决策(预留的实质)

### S1. 批注定位采用 W3C Web Annotation 的 selector 组合
**禁用**字符 offset、禁用整页级评论。采用组合 selector:
- `TextQuoteSelector`:`{ exact, prefix, suffix }`——按"选中文本 + 前后缀上下文"定位。**核心特性:只要那段文字还在,就能在新版本里重新找到**,这是跨版本重定位的命脉。
- `CssSelector`:定位所在节点,作为辅助锚点。
- `RangeSelector`:`{ startSelector, endSelector }`——当选区跨越多个块级元素时使用。

> 参考:[W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)

### S2. 批注与 HTML 实例解耦
每篇文档有稳定逻辑 `document_id` + `version`;批注挂在 `(document_id, selector)` 上,**绝不绑 DOM 节点**。AI 重写产出新 version 后,批注按 selector 在新 version 上重定位,不丢失。

### S3. 前端批注层为"非侵入 overlay"
用 DOM Range + 浮层实现高亮与气泡,被注释的 HTML 保持结构纯净。这是 C 阶段能注释"任意 HTML"的前提,也避免与 AI 重写互相破坏。

### S4. 统一的批注 payload 协议
**批注的数据结构就是回灌给 AI 的数据结构**。第一天就把 schema 定死(见 §6),回灌只是"把 payload 投递到某个 sink"。这样 A(回灌自己会话)与 C(嵌入别人系统)共用同一套回灌逻辑。

### S5. 回灌走 sink 抽象(可插拔投递端)
回灌 = 生成 payload + 选择 sink。sink 是可插拔的:`导出` / `注入本地 CLI` / `调 API 重写` / `飞书 Bot 推送`。新增 sink 不改动核心逻辑。

### S6. 存储 / 身份 / 权限只"留字段、缓实现"
数据模型第一天就带 `owner_id`、`scope(private|group|public)`、`document_id`、`version`,即使第一版全部填默认值。实现先用 SQLite/JSON,接口封装好,到 B 换 Postgres + 实时同步不破上层。

## 6. 数据模型

### 6.1 批注(Annotation)
```jsonc
{
  "id": "ann_01j_...",            // 批注唯一 ID
  "document_id": "doc_01_token",  // 所属文档(逻辑 ID,与版本无关)
  "version": 3,                   // 创建时所基于的版本
  "created_at": "2026-06-25T...",
  "updated_at": "2026-06-25T...",
  "author": { "id": "u_self", "name": "作者", "avatar": "..." },
  "scope": "private",             // private | group | public
  "status": "open",               // open | resolved | stale

  "selector": {                   // W3C Web Annotation selector
    "type": "TextQuoteSelector",
    "exact": "Token 是模型处理文本的最小单位",
    "prefix": "在 NLP 中,",
    "suffix": "。它将..."
  },

  "quote": "Token 是模型处理文本的最小单位",  // 冗余存选中原文,便于回灌与审计

  "body": {
    "comment": "这里说'最小单位'容易和字符混淆,建议改成'基本单元'",
    "action": "rewrite",          // rewrite | delete | question | none
    "instruction": "将'最小单位'改为'基本单元',并补充一句和字符的区别"  // 可选,更具体的修改意图
  }
}
```
> 跨节点选区时,`selector` 改用 `RangeSelector`(内含起止两个 `TextQuoteSelector`)。

### 6.2 文档与版本(Document)
```jsonc
{
  "document_id": "doc_01_token",
  "title": "Token — AI 百科 #01",
  "current_version": 3,
  "versions": [
    { "version": 1, "html_path": ".../01_token.html",   "created_at": "...", "source": "ai-gen",     "parent": null },
    { "version": 2, "html_path": ".../01_token_v2.html","created_at": "...", "source": "ai-rewrite", "parent": 1 },
    { "version": 3, "html_path": ".../01_token_v3.html","created_at": "...", "source": "ai-rewrite", "parent": 2 }
  ]
}
```

### 6.3 回灌 payload(由批注组装,投递给 sink)
```jsonc
{
  "document_id": "doc_01_token",
  "base_version": 3,
  "items": [
    {
      "quote": "Token 是模型处理文本的最小单位",
      "comment": "...",
      "action": "rewrite",
      "instruction": "...",
      "context": "周边段落文本(给 AI 足够上下文)"
    }
    // ...多条批注聚合
  ],
  "sink": "export"               // export | cli | api | lark
}
```

## 7. 系统组件与分层

```
┌─────────────────────────────────────────────┐
│  宿主 / 外壳(Host)                          │
│  阶段A:本地 server  │ B:Web App(鉴权+实时) │ C:embeddable widget
├─────────────────────────────────────────────┤
│  回灌层(Sink)                               │
│  payload 组装 → 投递:export / cli / api / lark
├─────────────────────────────────────────────┤
│  批注运行时(Annotation Runtime)            │
│  非侵入 overlay:高亮渲染、选区捕获、批注气泡
├─────────────────────────────────────────────┤
│  定位引擎(Locator)            ★ 核心骨架    │
│  selector ⇄ DOM Range 双向转换 + 跨版本重定位
├─────────────────────────────────────────────┤
│  存储层(Storage)                            │
│  批注库 + 文档版本库;A:SQLite │ B:Postgres  │
└─────────────────────────────────────────────┘
```

各组件职责单一,通过明确接口通信,可独立理解与测试。

## 8. 核心数据流

### 8.1 创建批注
`用户选区` → Locator 由 DOM 选区生成 selector → Runtime 弹出批注气泡 → 用户填 comment / action / instruction → Storage 写入批注 payload。

### 8.2 渲染高亮(含跨版本重定位)
`加载某 version HTML` → Storage 取该 document_id 全部批注 → Locator 对每条 selector 在**当前 version** 上计算 DOM Range → Runtime 渲染高亮。
- **重定位失败**的批注:标记 `status: stale`,**自动归档**到侧边栏"已归档"区(主列表隐藏、数据保留可查、可删除)。不混入主列表,避免已处理反馈堆积成噪音(方案 C:匹配不上视为"可能已被 AI 采纳",归档而非删除,避免误删有价值反馈)。

### 8.3 回灌与重写
`用户点击"回灌"` → Sink 层把选中批注组装成 payload → 投递到目标 sink(阶段 A:导出)→ 用户在 AI 会话中粘贴 → AI 产出新 HTML → 用户保存为**新 version** 入库 → 回到 8.2,批注在新 version 上重定位。

## 9. 演进路径

### 阶段 0 — 地基验证(预计 1–2 天)
**目标**:用最小代码立住 6 个骨架决策,验证核心可行性。
**交付**:
- 批注/文档/版本的数据 schema(§6)落地。
- Locator 原型:能在一篇真实 `apple-static` HTML 上,把 DOM 选区转成 `TextQuoteSelector`,并存回。
- 重定位验证脚本:加载批注 → 手动改动 HTML(模拟 AI 局部重写)→ 重载 → 批注仍能高亮。
**退出标准**:**在一篇真实 HTML 上**,选词 → 存 → 改 HTML → 重载,批注重定位成功。这一步是"保险栓",验证 TextQuote 在作者真实内容上确实有效后才往下走。

### 阶段 A — 个人闭环(预计 1–2 周)
**目标**:跑通 G1 完整闭环。
**交付**:
- 在阶段 0 骨架上加:多批注管理、payload 编辑(comment/action/instruction)、Runtime 完整 overlay、第一批 sink。
- 第一批 sink:`导出结构化 prompt`(一键复制,你在 Claude Code 里 `Cmd+V` 粘贴)。**阶段 A 不做 CLI 自动注入,也不做自建网页对话框**——二者均列为阶段 A 之后的演进项,待导出 sink 用顺后再评估。
- 版本管理:AI 重写产出新 version,保留历史。
**退出标准**:在 100 篇 AI 科普卡片上实际使用,「批注 → 回灌 → AI 重写 → 新 version → 批注重定位」跑通;stale 批注有清晰提示。

### 阶段 B — 群组协同(预计 1–2 月)
**目标**:实现 G2。
**交付**:
- 存储换 Postgres + 实时通道(WebSocket 或 Yjs CRDT)。
- 鉴权:飞书 OAuth + 群组 scope;批注线程、@提及。
- 分享:HTML 链接发到飞书群,点开即可多人划词点评。
**退出标准**:2 人以上同时批注实时可见,权限生效,体验对标飞书文档评论。**因骨架早已对齐,此阶段主要是"换实现"而非"改设计"。**

### 阶段 C — 通用嵌入(预计 2–3 月+)
**目标**:实现 G3。
**交付**:
- 注释层打包为可嵌入 widget(`<script src>`),注释任意页面。
- 回灌 sink 暴开放 API,供外部接入自有 AI。
- 多租户与权限模型完整化。
**退出标准**:widget 能在第三方页面批注;sink API 可被外部调用。

## 10. 关键技术选型(建议,实现计划阶段可调)

| 组件 | 阶段 A 建议 | 备选 / 演进 |
|---|---|---|
| 后端 | Python + FastAPI(与现有 `approach-*.py`/Playwright 栈一致) | — |
| 定位/overlay | **借用 Hypothesis client 的 text-quote anchoring 算法**(业界最成熟、边界处理最全),overlay/气泡 UI 自研 | 自研 Locator 作为长期可控兜底 |
| 存储 | SQLite | Postgres(阶段 B) |
| 实时 | 手动刷新 / 轮询 | WebSocket / Yjs(阶段 B) |
| 回灌 sink | **导出 prompt**(一键复制) | CLI 自动注入、网页对话框、API 自动重写、飞书 Bot(后续演进) |
| 前端 | Vanilla JS overlay | — |

> 选型原则:Locator 是系统命脉,**采用经过大规模验证的 Hypothesis text-quote anchoring 算法**以最大化重定位鲁棒性、降低边界踩坑风险;overlay/气泡 UI 自研以便后续 B/C 深度定制。其余选型保持与作者现有技术栈一致。

## 11. 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| TextQuote 重定位失败(文字被改/删除) | 批注标记 `stale`,**自动归档到侧边栏归档区**(主列表隐藏、数据保留、可删除);不直接删数据,避免误删有价值反馈 |
| 选区跨越多个块级元素 | 使用 `RangeSelector`(起止两个 TextQuoteSelector)兜底 |
| AI 大段重写导致多批注失效 | 失效批注集中提示;未来可加"语义重定位"(embedding 检索最近段落)作为增强 |
| overlay 在复杂 CSS 下高亮错位(Apple 风格深色 tile、固定宽度) | 阶段 0 优先在真实卡片上验证 overlay 精度 |
| 阶段 B 并发编辑冲突 | 批注以创建为准(append-only 优先);编辑冲突给出 last-write-wins + 提示 |
| 回灌后 AI 未产出合法 HTML | 新 version 入库前做基本校验;失败则不入库,保留旧 version |

## 12. 测试策略

- **Locator 单元测试(重点)**:`TextQuoteSelector` 在多种 HTML 结构(嵌套节点、跨节点选区、重复文本、有 prefix/suffix 消歧)下的生成与重定位正确性。
- **重定位鲁棒性测试**:模拟 AI 局部重写(改字、加段、删段),断言哪些 selector 仍可定位、哪些正确转为 stale。
- **真实内容集成基座**:以 `apple-static-mobile-100/` 的 100 篇卡片作为集成测试与手动验收的数据集。
- **闭环端到端测试(阶段 A)**:批注 → 回灌 payload → (mock AI 重写)→ 新 version → 重定位,自动化跑通。

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| TextQuote 在"大段重写"下失效 | 重定位丢失,闭环体验下降 | 鼓励 AI 局部改写 + stale 机制兜底;后续加语义重定位 |
| 复杂 CSS 下 overlay 高亮不准 | 视觉体验差 | 阶段 0 在真实卡片上验证;必要时约束 HTML 结构或用节点级锚点辅助 |
| 回灌自动化的演进依赖外部能力 | 未来若做 CLI 自动注入 / 网页对话框,依赖 Claude Code 能力或自建对话后端 | 阶段 A 先用导出 sink 验证闭环价值;自动化列为后续演进,不进阶段 A 范围 |
| 范围蔓延(想做编辑器/diff UI) | 延误 | §2 非目标明确排除,严格按阶段推进 |

## 14. 已确认的决策(本次拍板)

- **回灌形态:人驱动,阶段 A 用导出 sink**。批注组装成结构化 prompt,一键复制,你在 Claude Code 会话里 `Cmd+V` 粘贴,由你继续与 AI 对话完成修改。**阶段 A 不做 CLI 自动注入、不做自建网页对话框**——二者列为阶段 A 之后的演进项;sink 抽象同时为"机驱动(自动重写)"和后续自动化预留。
- **版本治理:保留新版本 + 历史**。AI 重写产出新 version,历史版本保留,批注跨版本重定位。
- **部署起点:本地起步**。阶段 0/A 纯本地(本地 server + 浏览器),阶段 B 再上阿里云。
- **Locator:借用 Hypothesis anchoring 算法**。正式定位引擎采用 Hypothesis client 的 text-quote anchoring(业界最成熟、边界处理最全),最大化重定位鲁棒性;overlay/气泡 UI 自研,以便后续 B/C 深度定制。

## 15. 待定项

进入实现计划前已无阻塞项。以下为“进入实现后再细化”的非阻塞问题,不影响开工:

- 导出 sink 的 prompt 模板具体措辞(实现时定,可快速迭代)。
- Hypothesis anchoring 的具体引入方式(直接抽取其模块 vs vendor 一份精简实现)——实现计划阶段确定。
