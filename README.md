# htmlGenius

<p align="center"><img src="assets/html-genius-logo.png" width="120" alt="htmlGenius"></p>

> 不要再对着 AI 描述“这里改一下”。

网页已经摆在眼前，问题也已经看得见。可一旦回到对话框，你还要把位置、上下文和限制条件重新讲一遍，AI 仍可能改偏。

htmlGenius 把反馈留在页面上：圈出一句话，写下想法，选中要处理的意见，再交给你本机的 Codex、Claude Code 或 GitHub Copilot。它生成的是一份独立候选版，不是对原文件的覆盖。

不想交给 AI 时，也可以直接在页面上改。文字、样式和排版所见即所得，改完立刻看到结果；需要撤销时，按下 Ctrl+Z 即可回退。

让网页评审从反复解释，变成直接指出。

🌐 官网：<https://www.deuce.monster/htmlgenius/>

## 它如何工作

1. **在页面上指出问题**

   选中一段文字即可评论，也可以直接编辑页面内容。讨论和上下文都留在原位置，不必再截屏、转述或猜测 AI 说的是哪一块。

2. **只处理这次想改的内容**

   点击“基于评论修改文档”，选择 AI 修改力度，再选定要处理的评论。你决定修改范围和保护规则，而不是把整页交给 AI 碰运气。

3. **先得到候选版，再决定是否采用**

   本机 Agent 会生成带版本号的新 HTML 文件，例如 `原名V1.1.html`。原文件不会被覆盖；你可以审阅、比较、继续讨论，也可以直接放弃候选版。

## 一个人收口，或和团队一起定稿

htmlGenius 适合审阅 AI 生成的 HTML 原型、设计稿和网页内容。独自使用时，它是更准确的页面反馈工具；需要协作时，登录后创建团队、邀请成员，所有人都能在同一网页上实时讨论。

团队批注绑定账号身份，只有作者本人可以编辑或删除自己的评论。已有团队的账号登录后会回到上次活跃的团队；加入其他团队由用户主动发起。

## 安装

### 从 Chrome Web Store 安装（推荐）

打开 [htmlGenius Chrome Web Store 页面](https://chromewebstore.google.com/detail/htmlgenius/fcapmgclnpiljjlcaficmjjclkaepaon)，点击“添加至 Chrome”即可安装。安装后打开任意网页，点击工具栏的 htmlGenius 图标。

### 从源码加载（开发者）

1. 打开 `chrome://extensions`，开启“开发者模式”。
2. 选择“加载已解压的扩展程序”，选中本仓库的 `extension/` 目录。
3. 打开任意网页，点击工具栏的 htmlGenius 图标。
4. 选中文字并评论；也可以直接进入编辑模式修改页面。准备交给 AI 时，在侧边栏点击“基于评论修改文档”。

## 本机 Agent（可选）

不安装本机连接组件，也可以把评论复制为结构化 Prompt，粘到任何 AI 对话框中。

如果希望一键生成候选 HTML，可在 macOS 上安装本机 host（Node 20+），并登录 Codex、Claude Code 或 GitHub Copilot。host 只在你的设备上调用对应 Agent；评论和页面内容通过本机处理，用于生成候选版。

连接配置见[配置文档](https://www.deuce.monster/htmlgenius/setup.html)、[Agent 说明](https://www.deuce.monster/htmlgenius/agents.html)和[`LOCAL_BRIDGE.md`](LOCAL_BRIDGE.md)。

## 数据边界

未登录时，批注保存在浏览器本地。主动使用团队协同时，团队批注会同步到 htmlGenius 自有服务，以便成员实时查看。不会收集浏览历史，不接广告；统计仅为匿名功能使用事件（不含页面内容与账号信息，详见隐私政策的「匿名使用统计」）。

详见[隐私政策](https://www.deuce.monster/htmlgenius/privacy.html)。

## 最近更新

- **v0.9.17（当前版本）**：全站批注权限改为按需授权（安装时不再索取所有网站权限，首次使用时一键开启）；安全加固——登录限流防密码爆破、团队治理审计日志、服务端内容清洗与标准安全响应头、gitleaks 密钥扫描 CI。
- **v0.9.16**：邮箱登录与注册（无 Google 账号可用）；团队模式全面板（加入/创建/邀请/成员/重命名/转移所有权/多团队切换）；实时同步按页签省流；GitHub Copilot 修复为可正常生成本地候选；新增匿名使用统计（不含页面内容与账号信息）。
- **v0.9.15**：修 Copilot 读源被拒、Codex 未登录误报「已连接」等连接问题（bridge 1.0.2）。

完整历史见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

## 更多

- [RELEASE_NOTES.md](RELEASE_NOTES.md)：版本历史
- [DEVELOPMENT.md](DEVELOPMENT.md)：开发、测试与架构说明
- [`landing/demo-2026-07/`](landing/demo-2026-07/)：官网静态源码与发布说明
