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

## 百度 SEO 发布要求

本目录的 `sitemap.xml` 会发布为 `https://www.deuce.monster/htmlgenius/sitemap.xml`，并在百度搜索资源平台的「普通收录」中提交。它只包含 htmlGenius 子路径页面。

`robots.txt` **只能**部署在域名根路径 `https://www.deuce.monster/robots.txt`，不应放在本目录。根站点的发布源需要提供真实纯文本文件，并至少包含：

```text
User-agent: *
Allow: /
Sitemap: https://www.deuce.monster/htmlgenius/sitemap.xml
```

发布后先用 `curl -I` 确认根 `robots.txt` 的 `Content-Type` 为 `text/plain`、子路径 sitemap 为 `application/xml` 或 `text/xml`，再在百度搜索资源平台提交 sitemap 和首页 URL。提交只加快发现，不保证收录。

首页 canonical 统一为 `https://www.deuce.monster/htmlgenius/`；根站点的 Nginx 配置还应将 `https://www.deuce.monster/htmlgenius/index.html` 以 **301** 重定向到该 URL，避免同一内容被两个可索引 URL 分散信号。
