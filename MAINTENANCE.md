# 维护手册（低频操作与历史记录）

> 从 CLAUDE.md 迁出的内容（2026-08-27 精简）：这里放**低频才用的操作流程**和**历史批次记录**。
> 每次会话必读的工程约定与硬规则仍在 `CLAUDE.md` / `AGENTS.md`。

## Bridge 发 npm：Trusted Publishing（GitHub OIDC，2026-08-04 起为唯一免 OTP 通道）

npm 废弃 bypass token（Automation/Granular）用于 direct publishing 后，旧「`NPM_TOKEN` secret + `npm publish`」在 CI 开始被拦（E404/EOTP）。bridge 已迁移到 **npm Trusted Publishing**：CI 用 OIDC 短期 token 发布，**免长效 token、免 OTP**，provenance 自动生成。**1.0.2 已用此通道验证发布成功**。

- **发布流程（日常，全自动）**：改 `bridge/package.json` 版本 + 同步引用 → commit → `git push origin <分支>` → `git tag bridge-v<ver> && git push origin bridge-v<ver>` → `.github/workflows/publish-bridge.yml` 在 `macos-latest` 升 npm≥11.5.1 → `npm ci → npm test → npm publish`（OIDC 鉴权）→ `npm view @htmlgenius/bridge@<ver> version` 确认上 registry。
  - CI 挂了要重发：`git tag -f bridge-v<ver> <修复后的 commit>` → `git push origin :refs/tags/bridge-v<ver>` → `git push origin bridge-v<ver>`（删旧+推新触发 CI；**不要用 `--force`**，会被安全分类器拦）。
- **一次性前置（npmjs.com，已配）**：`@htmlgenius/bridge` → Settings → Trusted Publisher → GitHub Actions：owner=`chenerzhong123-cloud`、repo=`htmlGenius`、workflow=`publish-bridge.yml`（大小写敏感，必须精确）。`repository.url` 须与仓库精确匹配（已匹配 `git+https://github.com/chenerzhong123-cloud/htmlGenius.git`）。要求 npm≥11.5.1、Node≥22.14、GitHub-hosted runner（用 macos-latest，兼顾测试）。
- **收紧（建议做）**：npmjs.com Settings → Publishing access → "Require two-factor authentication and disallow tokens" → trusted publishing 成为唯一通道；之后 revoke 旧 token、删 GitHub `NPM_TOKEN` secret（已不需要）。
- **本地兜底（需 OTP，仅应急）**：`cd bridge && npm publish --otp=<6位码>`。`NPM_TOKEN` 在 `~/.zshenv`（`~/.npmrc` 用 `${NPM_TOKEN}` 引用）；`npm token list` 看类型（只有 Automation 曾免 OTP，**现已失效**）。仅 CI 不可用时用。

## 安全审计修复批次（2026-07-29，v0.9.10）

本批次按 `docs/AUDIT-2026-07-28.md`（v1）与 `docs/AUDIT-2026-07-28-v2.md`（v2）修复。完成范围与**有意排除**项（用户决定）记录如下，避免后续重复劳动或误以为未做：

- **已完成**：BE-1/2/3、SUP-1/2、CORE-1/2/3/4/5/6/7、SUP-3/4/7/8/9/10/11/12、BR-1、R-2/4/5/6/7/9/10/11/12、BE-4/5/6/7/9、BR-4/5/6/7、WEB-1/2/3/4/5/6、R-8/R-24、OAuth 凭据轮换与本地文件清理。
- **有意排除（仍开放，需用户决策）**：R-1（跨租户 IDOR，需 documents 表加 team_id + 数据迁移）、R-3（HMAC 密钥 fail-closed，需运维先配 `HG_STREAM_SECRET`）、SUP-5（token 迁 `storage.local`，多设备 UX 变更）、BE-11（session 绝对寿命上限，强制重登）、CORE-8（权限面收窄——本版反而为修 hint 加了 `tabs` 权限）。
- **测试**：bridge `npm test` 319/0；服务端 pytest（除 Playwright UI）全绿。`tests/test_relocate.py`、`tests/test_ui.py` 3 个失败为 v0.4/v0.5 时代遗留的过时 UI 测试（选择器引用旧结构），非本批引入。
