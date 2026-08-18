# htmlGenius 官网静态 Demo（2026-07）

这是 htmlGenius 官网的静态源码，发布到 `https://www.deuce.monster/htmlgenius/`。修改完成后需同步到 `/var/www/htmlgenius/`，并保留上一版作为可回退副本。

- `index.html`：官网首页，展示就地编辑、批注交给 Agent、本机候选版与团队内协作四个核心流程。
- `agents.html`：支持的 Codex / Claude Code 说明。
- `privacy.html`：统一视觉后的隐私页信息结构。正式发布时须将现有政策完整法律文本、日期与联系方式逐条迁入并复核。
- `shared.css` / `shared.js`：三页共用的视觉 token、响应式与语言菜单交互。

线上路径：

- `/htmlgenius/` → `index.html`
- `/htmlgenius/agents.html` → `agents.html`
- `/htmlgenius/privacy.html` → `privacy.html`
- `/htmlgenius/setup.html` → `setup.html`
