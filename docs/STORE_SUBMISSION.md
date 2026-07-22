# Chrome Web Store 提交资料（htmlGenius v0.8.1）

> 提交时直接从本文复制。英文在前（审核员用），中文备注在后。
> **本次相对已上线版本 v0.5.1 的新增权限**：`nativeMessaging`、`notifications`、`offscreen`（其余权限与 v0.5.1 一致，未变更）。老用户更新时会因 `nativeMessaging` 收到一次权限确认弹窗，属正常。

---

## 一、单一用途声明（Single Purpose，必填一句话）

**English（粘贴）：**
> htmlGenius lets users highlight, annotate, and edit text on any web page, organize selected comments into a change brief, and optionally hand that brief to the user's own locally-installed AI agent (Claude Code / Codex) to produce a reviewable candidate version of the page.

**中文：** htmlGenius 让用户在任意网页上划词批注、编辑文字，把选中的评论整理成修改契约，并可选地交给用户本机已安装的 AI Agent（Claude Code / Codex）生成一份可评审的候选版本。

---

## 二、权限用途说明（Permissions，逐项填）

> 「权限」标签里每个权限都要写一句用途。下面是中英对照，提交填英文。
> **标 ⭐ 的是本次新增**（相对 v0.5.1），重点写清楚。

| 权限 | English justification（粘贴） | 中文 |
|---|---|---|
| `activeTab` | Access the user's current tab only when they invoke htmlGenius, to read the text they select and render highlights/annotations on the page. | 仅在用户主动启用 htmlGenius 时访问当前标签页，读取其选中的文字并渲染高亮/批注。 |
| `sidePanel` | Display the htmlGenius annotation panel inside the Chrome side panel. | 在 Chrome 侧边栏中显示批注面板。 |
| `storage` | Store the user's preferences (language, theme), login session, and local-mode annotations in the browser. | 在浏览器本地保存用户偏好（语言、主题）、登录会话与本地批注。 |
| `identity` | Authenticate the user via Google or Lark (Feishu) OAuth, so annotations are tied to a real account and can be shared within a team. | 通过 Google / 飞书 OAuth 完成登录，让批注绑定真实账号并能在团队内共享。 |
| ⭐ `nativeMessaging`（**新增**） | Communicate — via Chrome's Native Messaging — **only with an AI agent the user has installed and signed into on their own machine** (the Claude Code CLI or the Codex Mac App), to turn the user's selected comments into a candidate HTML file. The extension reuses the user's existing local sign-in; it **does not collect, store, or transmit any credentials, cookies, or page content to the extension author or any server**. The native host runs solely on the user's device, is installed separately by the user, and is macOS-only; when it is not installed the extension degrades gracefully with a clear "bridge not installed" message and all other features keep working. | 仅通过浏览器原生消息与**用户本机已安装并登录的** Claude Code CLI / Codex Mac App 通信，把用户勾选的评论变成候选 HTML。复用用户本机已有登录态；**不收集/不保存/不外传任何凭证、Cookie 或页面内容给插件作者或任何服务器**。host 只在用户本机运行、由用户另行安装、仅 macOS；未安装时优雅降级提示，其余功能不受影响。 |
| ⭐ `notifications`（**新增**） | Show a system notification when an AI-generated candidate version is ready, so the user knows to come back and review it (generation can take a few minutes and the user may have switched tabs). | 候选版本生成完成时弹系统通知，提醒用户回来查看（生成需数分钟，用户可能切走了）。 |
| ⭐ `offscreen`（**新增**） | Play a short, locally-synthesized "ding" sound (via the Web Audio API inside an offscreen document) when a candidate is ready. **No audio file is downloaded**; nothing leaves the device. | 候选就绪时用 offscreen 文档的 Web Audio 合成一声"叮"。**不下载音频文件**，无任何外传。 |
| `host_permissions`（`http://localhost/*`、`http://127.0.0.1/*`、`https://*/*`，未变更） | The extension annotates text on whatever page the user opens, so its content script runs on all URLs; it also talks to our own backend (www.deuce.monster) over HTTPS to sync team comments, and to localhost during development. Unchanged from the already-approved v0.5.1. | 内容脚本需在用户打开的任意网页上运行；并通过自有后端（www.deuce.monster）HTTPS 同步团队评论，开发期用 localhost。与已过审的 v0.5.1 一致，未变更。 |

---

## 三、隐私权勾选（Privacy Practices）

> 隐私政策 URL（必填）：**https://www.deuce.monster/htmlgenius/privacy.html**（已更新，含本机 AI Agent 数据流说明）

「我们收集的数据」如实勾选如下（其余一律选「否」）：

| 类别 | 是否收集 | 说明 |
|---|---|---|
| 个人身份信息 | **是** | 登录后收集 Google 邮箱/姓名/头像，或飞书 open_id/姓名 |
| 身份验证信息 | **是** | OAuth 登录产生的会话 token |
| 网站内容（Website content） | **是** | 用户选中的网页原文片段随批注保存；**另外**：当用户主动使用本机 Agent 功能时，勾选的评论 + 相关页面文本会经 Native Messaging 发往**用户本机**的 Claude/Codex（见隐私政策"本机 AI Agent"段），**不发给 htmlGenius 服务器** |
| 个人通信 / 金融 / 健康 / 位置 / 网页历史 / 跨站追踪 | 否 | |

「数据用途」：**仅用于实现核心功能（账号身份 + 团队协作批注 + 用户主动触发的本机 AI 候选生成）**，不用于广告、不用于分析、不出售。
「数据加密传输」：**是**（全链路 HTTPS；本机 Agent 走 Native Messaging 不经网络）。
「是否出售或转移给第三方」：**否**。

---

## 四、商店详情文案（商品详情，中英日）

> 简短摘要上限 132 字符。

### 中文（zh-CN）

**简短摘要：**
> 在任意网页划词批注、实时编辑，一键把评论交给本机 Codex / Claude Code 生成可回退的候选 HTML。HTML 评审利器。

**详细描述：**

htmlGenius 把「网页」变成可讨论、可改、可回灌给 AI 的协作画布。无论是 AI 生成的 HTML 原型、设计稿、还是任何在线文档，你都能直接在页面上圈点、批注、修改，再把意见交给本机 AI 产出一份**只写候选、绝不覆盖原文件**的新版本。

**核心能力**
- 🖊️ **划词批注**：选中任意文字即可留下评论，支持多级回复，讨论有上下文。
- ✏️ **实时编辑**：加粗 / 斜体 / 下划线 / 删除线、文字颜色、字号、对齐、荧光笔，所见即所得，Ctrl+Z 可撤销。
- 🤖 **交给本机 Codex / Claude Code**（macOS）：把勾选的评论整理成修改契约，交给你本机已登录的 Codex（推荐，更快）或 Claude Code，产出带版本号的候选 HTML（`原名V1.1.html`、`V1.2.html`…），**原文件全程不被覆盖**。生成过程实时可见、可随时终止，完成自动打开 + 系统通知。
- 📋 **复制 Prompt**：也可一键把全部评论复制成结构化提示词，粘到任意 AI 对话框。
- 👥 **团队协同**（可选）：登录后建团队、发邀请码，成员间批注秒级实时同步。
- 🌗 **Mint 深色 / 浅色主题** + 🌐 **中英日三语**。
- 🔒 **作者绑定**：批注绑定账号身份，仅作者本人能删/改自己的评论。

**关于本机 Agent**：该功能为可选项，仅 macOS 可用，需另装本机 host（Node 20+）并登录 Claude Code（`claude auth login`）或 Codex Mac App。评论与页面内容只在你本机处理，不上传给插件作者。详见 [Agent 说明](https://www.deuce.monster/htmlgenius/agents.html)。

不收集浏览历史、不接广告、不用第三方分析——详见[隐私政策](https://www.deuce.monster/htmlgenius/privacy.html)。

### English (en)

**Short summary:**
> Highlight, annotate & edit any web page — hand comments to your own local Codex / Claude Code for a reviewable candidate version.

**Detailed description:**

htmlGenius turns any web page into a canvas your team can discuss, edit, and feed back to AI. Whether it's an AI-generated HTML prototype, a design mockup, or any online document, you can highlight, comment, and rewrite directly on the page — then hand the feedback to your own local AI to produce a candidate version that **never overwrites your original file**.

**Key features**
- 🖊️ **Highlight & annotate**: select any text to leave a comment; threaded replies keep discussion in context.
- ✏️ **Live editing**: bold / italic / underline / strikethrough, text color, font size, alignment, highlighter — WYSIWYG, with Ctrl+Z undo.
- 🤖 **Hand off to your own local Codex / Claude Code** (macOS): turn selected comments into a change brief and send it to your locally-signed-in Codex (recommended, faster) or Claude Code to produce a versioned candidate (`nameV1.1.html`, `V1.2.html`…). **Your original file is never overwritten.** Watch progress live, abort anytime; it auto-opens + notifies you when done.
- 📋 **Copy as prompt**: or copy every comment as a structured prompt into any AI chat.
- 👥 **Real-time team sync** (optional): log in, create a team, share an invite code; comments sync live.
- 🌗 **Mint dark / light themes** and 🌐 **Chinese / English / Japanese** UI.
- 🔒 **Author-bound**: annotations are tied to a real account; only the author can delete or edit their own.

**About the local Agent**: this is optional and macOS-only; it requires installing a local host (Node 20+) and signing into Claude Code (`claude auth login`) or the Codex Mac App. Comments and page content are processed on your machine only and never uploaded to the extension author. See the [Agents guide](https://www.deuce.monster/htmlgenius/agents.html).

No browsing history collected, no ads, no third-party analytics — see our [privacy policy](https://www.deuce.monster/htmlgenius/privacy.html).

### 日本語 (ja)

**要約:**
> ウェブページを注釈・編集し、コメントをローカルの Codex / Claude Code に渡して確認用候補を生成。

**詳細説明:**

htmlGenius はウェブページを、チームで議論・編集し AI にフィードバックできるキャンバスに変えます。ページ上で直接ハイライト・コメント・書き換えができ、フィードバックをローカルの AI に渡して**原本を上書きしない**候補版を作れます。

**主な機能**
- 🖊️ **ハイライト＆注釈**・✏️ **リアルタイム編集**（太字/色/サイズ/配置/マーカー、Ctrl+Z 元に戻す対応）。
- 🤖 **ローカル Codex / Claude Code に受け渡し**（macOS）：コメントを選んで契約にまとめ、ローカルの Codex（推奨・高速）または Claude Code に渡し、バージョン付き候補（`名前V1.1.html`…）を生成。**原本は上書きされません**。進捗がリアルタイムで見え、いつでも中止可能。完成時に自動で開き通知。
- 📋 **プロンプトとしてコピー**：全コメントを構造化プロンプトにして任意の AI に貼り付けも。
- 👥 **チーム同期**（任意）・🌗 **Mint ダーク/ライト**・🌐 **中日英 3 言語**・🔒 **作成者紐付け**。

**ローカル Agent について**:オプション・macOS 専用。別途ローカル host（Node 20+）のインストールと Claude Code（`claude auth login`）または Codex Mac App のログインが必要です。コメント・ページ内容はお使いの端末内でのみ処理され、作者に送信されません。[Agent ガイド](https://www.deuce.monster/htmlgenius/agents.html)参照。

閲覧履歴の収集なし、広告なし、サードパーティ分析なし — [プライバシーポリシー](https://www.deuce.monster/htmlgenius/privacy.html)をご覧ください。

---

## 五、提交前最后自检

- [ ] 在 `chrome://extensions` 加载 `dist/htmlGenius-0.8.1.zip`（或加载已解压的 `extension/`）实测：留批注 / 编辑 / 主题语言切换；复制 Prompt；（macOS）装 host 后发送给 Codex / Claude Code 跑通候选闭环；host 未装时优雅提示。
- [ ] **三个新增权限**（nativeMessaging / notifications / offscreen）的 justification 照本文第二节填。
- [ ] **minimum_chrome_version = 116** 已在 manifest（offscreen 需要）。
- [ ] Google Cloud Console OAuth 同意屏处于 **Production**；`https://<扩展ID>.chromiumapp.org/` 已注册（扩展 ID 由 manifest key 钉定，稳定）。
- [ ] 飞书自建应用重定向 URL 白名单含正式扩展 ID 的 `https://<扩展ID>.chromiumapp.org/`。
- [ ] 商店截图 3–5 张（1280×800，含 Mint 主题 + 候选版本号 + 发送/终止态）+ 宣传小图 440×280。
- [ ] 隐私政策 URL（privacy.html，已含"本机 AI Agent"段）已 scp 部署上线。
- [ ] 「隐私权」「权限」「单一用途」三栏照本文第二、三节填。
- [ ] 老用户会因 nativeMessaging 收到一次权限确认弹窗——已知、正常。
