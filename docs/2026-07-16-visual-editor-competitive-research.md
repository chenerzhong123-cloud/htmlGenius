# HTML Genius：竞品研究、个人 Agent 路线与修改契约

> 状态：当前产品判断（2026-07-17）  
> 本文替代此前所有增量更新；只保留一套有效的结论、边界和里程碑。  
> 研究样本：三条小红书实际案例、Webflow、Pinegrow、GrapesJS，以及 Codex / Claude Code / Copilot 的官方集成文档。

## 1. 结论

HTML Genius 不应成为通用的「HTML 可视化编辑器」，也不应成为托管 Agent、账户和 token 的 SaaS。

它应定位为：

> **个人本地环境中，连接“页面反馈”与“用户自带 Agent 修改”的控制层。**

用户在渲染后的 HTML 上指出问题；HTML Genius 将问题、定位、修改范围和保护规则编译成任务；用户已安装、已登录、已付费的 Agent 在本地完成修改；HTML Genius 把结果重新呈现在页面上供用户复审。

直接编辑仍然有价值，但只服务确定、低风险、不需要模型理解的最后一公里。复杂内容、整体结构或跨多人决策，应由明确的修改契约约束 Agent 执行。

## 2. 已确定的产品边界

1. **个人级、本地优先**：不托管模型、账户、token、Agent session 或用户文件。
2. **不是通用 Builder**：不追逐全量 CSS Inspector、表格、画板、PDF、CMS、托管和完整建站能力。
3. **编辑范围受限**：本地静态 HTML 可直接编辑；React / Vue 等动态页面只做批注，不承诺直接改 DOM。
4. **Agent session 有归属**：只能创建 `hg-bridge` 自己管理的 session，或续发由 bridge 保存过 `session_id` 的 session。
5. **不侵犯其他会话**：不扫描、不读取、不展示历史 Agent 会话；不向用户正在其他应用中运行的会话注入消息。
6. **MCP 不是触发路径**：不要求用户点评论后再切换应用让 Agent 拉取任务。MCP 未来最多作为 bridge 所管理 Agent 的补充上下文工具。
7. **每次写入可复审**：Agent 的文件改动必须回到页面中重载和核对；版本不一致或目标不明确时，停止而不是静默覆盖。

## 3. 市场证据：直接编辑已是品类基础能力

| 参考 | 用户任务与能力 | 对 HTML Genius 的启示 |
|---|---|---|
| [科技小亮 AGI：HTML 可视化编辑器](https://www.xiaohongshu.com/explore/6a296d8c0000000022008679) | 上传 HTML，在画布中选元素；属性面板可改文字、颜色、字号、间距、圆角、阴影；文本工具栏；源码与画布联动。 | 元素点选和属性面板已是用户预期，单独提供没有差异化。 |
| [椰椰修鲁鲁：不会写代码也能改 HTML](https://www.xiaohongshu.com/explore/69dcc887000000002301c380) | Chrome 插件，宣称拖拽、双击改字、表格、图片粘贴、对齐辅助线、画板、PDF 导出。 | 功能清单竞争会无限膨胀。不能因竞品有表格/画板/PDF 就跟做。 |
| [思酷素材：HTML 可视化编辑器](https://www.xiaohongshu.com/explore/6a3bad31000000001101cbc4) | 导入、编辑、保存、恢复、导出；改字、字体、字号、对齐、行高、颜色、Emoji。 | 本地文件的可逆保存与导出是编辑场景的基本门槛；恢复能力应保留。 |

注：后两条的功能来自作者自述，未独立验证实现质量或兼容范围。

## 4. 经典产品参考：学边界，不抄功能

| 产品 | 它解决的核心问题 | 应借鉴 | 不应跟随 |
|---|---|---|---|
| [Webflow Designer](https://webflow.com/feature/design) | 从设计到生产网站的完整视觉构建与发布。其 [Style panel](https://help.webflow.com/hc/en-us/articles/33961362040723-Style-panel-overview) 覆盖布局、背景、排版等 CSS 属性。 | 属性按布局、样式、响应式分层；设计系统优先于零散 inline style。 | CMS、托管、交互、完整建站。 |
| [Pinegrow Web Editor](https://pinegrow.com/docs/getting-started/quick-introduction-to-pinegrow/) | 编辑已有标准 HTML/CSS 项目，理解生效 CSS rule，并保持代码与画布联动。 | 编辑既有页面的关键是理解 CSS 来源与响应式；未来可做“为什么此元素长这样”的只读解释层。 | 桌面 IDE 级 CSS/SASS/框架支持。 |
| [GrapesJS](https://grapesjs.com/docs/getting-started.html) | 可嵌入的开源拖拽式网页编辑器，围绕 component、block、layer、style manager 构建。 | 按元素类型限制可编辑属性，避免给任意 DOM 暴露全部 CSS。 | 把 HTML Genius 重写为低代码 Builder 平台。 |

## 5. HTML Genius 的差异化

下列判断针对本次样本，不声称全市场绝对独有：

1. **从反馈起步**：在已渲染页面精确指出问题，而非要求用户进入编辑器理解 DOM 与 CSS。
2. **反馈可执行**：评论包含引用、上下文、定位、意图与约束，可直接变为 Agent 任务，而不是散落意见。
3. **反馈跨版本连续**：新版本生成后重新定位评论；无法定位的项归档，不丢失决策历史。
4. **人和 Agent 的双路径**：确定性小改直接编辑；语义性、结构性问题交给用户自带 Agent。
5. **本地 Agent 闭环**：不是复制提示词后离开页面，而是由本地 bridge 发送任务、接收修改、重载页面、继续复审。

## 6. 修改契约：产品的核心对象

“保守 / 激进”两套 prompt 不足以控制 Agent。每次修改应先形成一个显式的 **change contract**：

`目标 + 范围 + 允许操作 + 保护项 + 遇到歧义的行为 + 验收方式 + 输出方式`

| 模式 | 适用场景 | 允许范围 | 默认保护规则 |
|---|---|---|---|
| **精准修补** | 只改圈选文字或一个元素 | selection / 单 DOM element | 目标外文本、DOM、样式和其他文件全部锁定；找不到可靠定位即停止；必须回报前后片段或 diff。默认模式。 |
| **局部优化** | 优化一个卡片、段落、section | section | section 外锁定；保留整体风格、链接和数据；输出变更摘要。 |
| **结构重组** | 章节、信息架构、叙事顺序有问题 | document structure | 可移动、合并、新增、删除结构；保留明确列出的事实、资产与不可改内容；先给 plan，再执行。 |
| **重新生成** | 用户给出新的完整 brief，要重做页面或报告 | whole document | 可替换全文和版式；新 brief 优先；必须列出保留项、假设与待复核项。 |

### 文档修改也是修改契约的正式案例

本次对研究报告的请求属于：

| 契约字段 | 本次值 |
|---|---|
| 模式 | **重新生成 / 整篇重写** |
| 目标 | 本研究报告全文 |
| 允许操作 | 重排结构、删除过期表述、合并重复内容、替换路线图 |
| 必须保留 | 已核实素材链接、核心定位、本地优先边界、当前路线图 |
| 禁止事项 | 在旧正文后追加第二套有效结论；保留冲突里程碑 |
| 验收 | 一份可从头读到尾的自洽报告；每个主题只出现一套有效结论 |

这条规则也应体现在产品 UI：当用户的意图可能导致跨越当前选择范围时，HTML Genius 必须显示“将修改的范围”并要求用户明确升级契约，而不是自行推断。

### 任务包骨架

```jsonc
{
  "schema_version": 1,
  "mode": "precise_patch",
  "artifact": {
    "path": "report.html",
    "version_hash": "sha256:..."
  },
  "target": {
    "selector": "main > section:nth-of-type(3) > p:nth-of-type(2)",
    "quote": "当前被圈选的原文",
    "prefix": "前文上下文",
    "suffix": "后文上下文",
    "html_snippet": "<p>...</p>"
  },
  "request": "改成更准确的表述",
  "constraints": {
    "write_scope": "target_only",
    "locked_outside_scope": true,
    "preserve": ["DOM 结构", "所有未选中文本", "既有样式"],
    "on_ambiguous_target": "ask_or_stop"
  },
  "verification": [
    "确认只有目标元素被改动",
    "报告前后片段或 git diff",
    "不要修改其他文件"
  ]
}
```

同一任务包可渲染成复制 prompt、Codex turn input、Claude Code 命令或 Copilot 命令。任务语义不能绑在某一家 Agent 的 prompt 格式上。

## 7. 本地 Agent 方案：可行性与边界

### 推荐架构

```text
网页 / 本地 HTML
      │ 选区、DOM anchor、评论、change contract
      ▼
htmlGenius Chrome Extension
      │ Native Messaging（本机，不经云端）
      ▼
hg-bridge（用户可选安装的本地开源 companion）
 ├─ Task store: .htmlgenius/tasks/<id>.json + <id>.md
 ├─ Session binding: workspace + provider + session_id
 ├─ Claude Code adapter（第一个实现）
 ├─ Codex adapter（后续）
 ├─ Copilot adapter（后续）
 └─ 可选 MCP context server
```

`hg-bridge` 不需要 HTML Genius 账户或平台 API key；它使用用户已安装的 CLI、已有登录态或用户自配 API。Native Messaging 避免浏览器扩展暴露局域网端口。

### 三类能力必须区分

| 能力 | 结论 | 产品处理 |
|---|---|---|
| 创建 bridge 自己管理的新 Agent session | 可行 | 主路径。首次“发送并修改”时创建，保存绑定。 |
| 续发 bridge 已记录的 session | 可行 | 主路径。后续评论直接发到同一 session，保留上下文。 |
| 读取历史会话或控制其他正在运行的会话 | 不作为可靠、通用能力 | 不做。用户隐私和跨产品协议都不支持将其作为产品承诺。 |

### Provider 事实

| Provider | 已验证的可用能力 | 对 HTML Genius 的决定 |
|---|---|---|
| Claude Code | [CLI](https://code.claude.com/docs/en/cli-reference) 支持非交互 `-p`、JSON 输出、按已知 session ID 的 `--resume` 和 auth status。 | **第一个实现**。只新建或续发 bridge 已保存的 UUID；不使用 `-c`、picker 或其他会话。 |
| Codex | [App Server](https://learn.chatgpt.com/docs/app-server.md) 支持创建、恢复 thread，开始或 steering turn，并流式接收事件。 | 后续 adapter；复用 Claude 已验证的 Native Host、task store 与 session ownership 边界。 |
| Copilot | [SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence) 支持持久化 session 与按 ID 恢复；[ACP](https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/copilot-cli-reference/acp-server) 仍为 public preview。 | 最后评估；不将 preview 协议放进核心路径。 |

MCP 在这里不是任务触发器。用户点击评论后应立即由 bridge 发送任务；MCP 只可让 bridge 管理的 Agent 在执行中读取额外批注或任务上下文。

## 8. 产品体验：用户不需要切换应用

首次使用：

1. 用户选择“发送给 Claude Code”。
2. 扩展要求授权本地 `hg-bridge` 访问当前 workspace。
3. 用户点击“发送修改计划”，bridge 创建 `HTML Genius · 当前项目` 的 Claude Code session。

后续使用：

1. 用户圈选页面并选择修改契约。
2. 点击“发送给 Claude Code”。
3. Side Panel 显示发送中、完成或失败；用户无需切换应用。
4. 后续 candidate-execution 版本才会让 Agent 生成文件、扩展刷新页面并复审。

这里的“连接”不是连接用户当前任何 Codex 对话，而是建立一个为这个页面/项目专用、受 HTML Genius 管理的工作会话。

## 9. 路线图

| 里程碑 | 目标 | 最小交付与验收 |
|---|---|---|
| **M1 · v0.6 可信元素操作** | 完成静态 HTML 的直接、可撤销编辑 | inspect、点选、删除、复制、同级重排、撤销/重做；严格限制静态本地 HTML。 |
| **M2 · v0.6.1 修改契约** | 让每条反馈具有明确的修改力度与保护范围 | 四种模式；可见的 scope / preserve UI；复制结果同时含可读 prompt 与 JSON task；精准修补要求 diff。 |
| **M3 · v0.7.1 Claude Code handoff（优先实施）** | 先验证“点击即把修改计划送入用户本机 Agent” | Native Messaging + `claude -p`；完整 Change Contract task bundle；只新建/续发 bridge-owned session；Side Panel 显示发送结果；不写 HTML。 |
| **M4 · v0.7.2 Claude candidate execution** | 在已验证的交接通道上形成安全页面闭环 | Claude 只写 candidate；扩展走 v0.6.2 版本协议打开新 artifact、重锚定批注；不覆盖 source。 |
| **M5 · v0.7.3 review / promote** | 让用户检查并决定是否采用 candidate | source/candidate diff、变更范围审查、显式确认后提升；语义规则只作 review，不静默自动 apply。 |
| **M6 · v0.8 Codex adapter** | 增加第二个用户自带 Agent | 用 App Server 接入；复用 task schema、session ownership、Native Host 和 candidate 协议；不读取外部 thread。 |
| **M7 · v0.9 Copilot 与团队场景** | 最后扩展 provider 与协作 | 评估 Copilot 协议稳定性；workspace、解决状态、变更责任链；不变成托管 Agent 平台。 |

### M3 必须通过的技术验收

1. Side Panel 一次点击即可将完整 Change Contract 发送至本机 Claude Code CLI，无复制/切换应用。
2. 第一次创建并保存 bridge-owned Claude session UUID；第二次只能续发该 UUID，绝不使用 `-c` 或会话 picker。
3. 外部 Claude 会话不被列出、读取或注入消息。
4. bridge 能把发送中、成功、CLI 未登录、超时和 source hash 冲突回显到 Side Panel。
5. 本里程碑不改 HTML；文件写入必须等到 candidate-execution milestone，避免把 task handoff 与写回风险混在一起。

## 10. 成功指标与暂缓项

不要以“支持多少 CSS 属性”衡量成功。应观察：

- 打开页面到第一次有效反馈/修改的时间；
- 精准修补的越界修改率；
- 局部优化相较手工描述的返工率；
- Agent 修改后可成功复审和重新定位的比例；
- 用户从评论到看到修改结果所需的应用切换次数；
- 用户把任务从精准修补升级为结构重组的比例。

暂缓：全量 CSS 面板、表格编辑、画板、图片编辑、PDF、自动读取历史 Agent 会话、向任意活跃会话推送任务、HTML Genius 自建 Agent 平台。
