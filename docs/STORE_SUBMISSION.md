# Chrome Web Store 提交资料（htmlGenius v0.5.1）

> 提交时直接从本文复制。英文在前（审核员用），中文备注在后。

---

## 一、单一用途声明（Single Purpose，必填一句话）

> 商店要求扩展只能有「一个明确用途」。填：

**English（粘贴这个）：**
> htmlGenius lets users highlight, annotate, and collaboratively edit text on any web page, then export those annotations as a prompt for AI tools.

**中文（对照）：** htmlGenius 让用户在任意网页上做划词批注、实时协同编辑，并把批注一键导出给 AI 工具。

---

## 二、权限用途说明（Permissions，逐项填）

> 「权限」标签里每个权限都要写一句用途。下面是中英对照，提交填英文。

| 权限 | English justification（粘贴） | 中文 |
|---|---|---|
| `activeTab` | Access the user's current tab only when they invoke htmlGenius, to read the text they select and render highlights/annotations on the page. | 仅在用户主动启用 htmlGenius 时访问当前标签页，读取其选中的文字并渲染高亮/批注。 |
| `sidePanel` | Display the htmlGenius annotation panel inside the Chrome side panel. | 在 Chrome 侧边栏中显示批注面板。 |
| `storage` | Store the user's preferences (language, theme), login session, and local-mode annotations in the browser. | 在浏览器本地保存用户偏好（语言、主题）、登录会话与本地批注。 |
| `identity` | Authenticate the user via Google or Lark (Feishu) OAuth, so annotations are tied to a real account and can be shared within a team. | 通过 Google / 飞书 OAuth 完成登录，让批注绑定真实账号并能在团队内共享。 |
| `host_permissions`（内容脚本 `<all_urls>` + `https://*/*`） | The extension annotates text on whatever page the user opens, so it must run on all URLs; it also sends annotations to and receives them from our own backend (www.deuce.monster) to sync team comments in real time. | 扩展需要在用户打开的任意网页上批注，故须在所有 URL 上运行；并与我们自有的后端（www.deuce.monster）收发批注，实现团队评论实时同步。 |

---

## 三、隐私权勾选（Privacy Practices）

> 隐私政策 URL（必填）：**https://www.deuce.monster/htmlgenius/privacy.html**

「我们收集的数据」如实勾选如下（其余一律选「否」）：

| 类别 | 是否收集 | 说明 |
|---|---|---|
| 个人身份信息（Personally identifiable information） | **是** | 用户登录后收集 Google 邮箱/姓名/头像，或飞书 open_id/姓名 |
| 身份验证信息（Authentication information） | **是** | OAuth 登录产生的会话 token |
| 网站内容（Website content） | **是** | 用户选中的网页原文片段随批注保存 |
| 个人通信（Personal communications） | 否 | |
| 金融/支付信息 | 否 | |
| 健康信息 | 否 | |
| 位置信息 | 否 | |
| 网页历史 | 否 | |
| 用户活动（搜索/浏览行为追踪） | 否 | |
| 跨网站追踪（用于广告/分析） | 否 | |

「数据用途」勾选：**仅用于实现扩展核心功能（账号身份 + 团队协作批注）**，不用于广告、不用于分析、不出售。

「数据加密传输」：**是**（全链路 HTTPS）。

「是否出售或转移给第三方」：**否**（仅登录时与 Google / 飞书交互做鉴权）。

---

## 四、商店详情文案（商品详情，中英日）

> 在「商品详情」标签为每种语言添加一条本地化描述。下面每条都是「简短摘要 + 详细描述」。
> 简短摘要上限 132 字符。

---

### 中文（zh-CN）

**简短摘要：**
> 在任意网页划词批注、实时团队协同编辑，一键把评论回灌给 AI。HTML 协作评审利器。

**详细描述：**

htmlGenius 把「网页」变成可讨论、可改、可回灌给 AI 的协作画布。无论是 AI 生成的 HTML 原型、设计稿、还是任何在线文档，你和团队都能直接在页面上圈点、批注、修改，再把所有人的意见一键整理成给 AI 的提示词。

**核心能力**
- 🖊️ **划词批注**：选中任意文字即可留下评论，支持多级回复，讨论有上下文。
- ✏️ **实时编辑**：加粗 / 斜体 / 下划线 / 删除线、文字颜色、字号、左中右对齐、荧光笔，所见即所得，Ctrl+Z 可撤销。
- 👥 **团队协同**：登录后建团队、发邀请码，成员间的批注秒级实时同步，谁在线一目了然。
- 🤖 **一键回灌 AI**：把全部评论（含多级回复）按层级复制成结构化提示词，直接喂给 AI 改稿。
- 🌗 **深色 / 浅色主题** + 🌐 **中英日三语**，跟随浏览器、随手切换。
- 🔒 **作者绑定**：批注绑定账号身份，只有作者本人能删 / 改自己的评论。

**适合谁**：用 AI 生成 HTML/落地页的团队、做网页设计评审的产研团队、需要在线文档协作的人。

不收集浏览历史、不接广告、不用第三方分析——详见隐私政策。

---

### English (en)

**Short summary:**
> Highlight, annotate & collaboratively edit any web page — then export all comments as an AI prompt.

**Detailed description:**

htmlGenius turns any web page into a canvas your team can discuss, edit, and feed back to AI. Whether it's an AI-generated HTML prototype, a design mockup, or any online document, you and your team can highlight, comment, and rewrite directly on the page — then export everyone's feedback as a single structured prompt for your AI tool.

**Key features**
- 🖊️ **Highlight & annotate**: select any text to leave a comment; threaded replies keep discussion in context.
- ✏️ **Live editing**: bold / italic / underline / strikethrough, text color, font size, alignment, and highlighter — WYSIWYG, with Ctrl+Z undo.
- 👥 **Real-time team sync**: log in, create a team, share an invite code; comments sync live and you can see who's online.
- 🤖 **One-click AI handoff**: copy every comment (including threaded replies) as a structured prompt to hand straight to your AI.
- 🌗 **Dark / light themes** and 🌐 **Chinese / English / Japanese** UI — follows your browser, switchable anytime.
- 🔒 **Author-bound**: annotations are tied to a real account; only the author can delete or edit their own comments.

**Who it's for**: teams generating HTML/landing pages with AI, product & design teams reviewing web mockups, anyone who collaborates on online documents.

No browsing history collected, no ads, no third-party analytics — see our privacy policy.

---

### 日本語 (ja)

**要約:**
> ウェブページ上でテキストを注釈・リアルタイム共同編集し、コメントをAI用プロンプトとして書き出し。

**詳細説明:**

htmlGenius は、ウェブページをチームで議論・編集し、AI にフィードバックできるキャンバスに変えます。AI 生成の HTML プロトタイプ、デザインモックアップ、オンライン文書など、ページ上で直接ハイライト・コメント・書き換えができ、全員のフィードバックを AI 用の構造化プロンプトとして書き出せます。

**主な機能**
- 🖊️ **ハイライト＆注釈**: 任意のテキストを選んでコメント。スレッド返信で文脈を保った議論が可能。
- ✏️ **リアルタイム編集**: 太字／イタリック／下線／取り消し線、文字色、サイズ、配置、マーカー。WYSIWYG、Ctrl+Z で元に戻せます。
- 👥 **チーム同期**: ログインしてチーム作成・招待コード共有。コメントはリアルタイム同期、オンライン表示も。
- 🤖 **AI へ一括受け渡し**: 全コメント（スレッド含む）を構造化プロンプトとしてコピーし、AI にそのまま渡せます。
- 🌗 **ダーク／ライトテーマ** と 🌐 **中日英 3 言語 UI**。ブラウザに追従、いつでも切替。
- 🔒 **作成者紐付け**: 注釈は実アカウントに紐づき、本人のみが自身のコメントを削除・編集できます。

**対象**: AI で HTML／ランディングページを作るチーム、ウェブモックアップをレビューする製品・デザインチーム、オンライン文書で共同作業するすべての方。

閲覧履歴の収集なし、広告なし、サードパーティ分析なし — 詳細はプライバシーポリシーをご覧ください。

---

## 五、提交前最后自检（建议你过一遍）

- [ ] 在 `chrome://extensions` 加载 `dist/htmlGenius-0.5.1.zip`（或加载已解压的 `extension/`），实测：Google 登录、留批注、编辑批注、删除、主题/语言切换、收起侧边栏即失活——都正常。
- [ ] Google Cloud Console → OAuth 同意屏幕处于 **正式（Production）** 状态（不能停在「测试」），且两个 client_id（Web 类型，给 launchWebAuthFlow 用）都在。
- [ ] 飞书自建应用「重定向 URL」白名单含正式扩展 ID 的 `https://<扩展ID>.chromiumapp.org/`（开发 ID 与正式 ID 不同，分别加）。
- [ ] 商店截图 3–5 张（1280×800）+ 宣传小图 440×280 已准备。
- [ ] 「隐私权」「权限」「单一用途」三栏照本文档第二、三节填。
