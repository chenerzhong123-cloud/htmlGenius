# htmlGenius 项目说明

> 本文件是 htmlGenius 项目专属指令，补充上级 `claudeproject/CLAUDE.md`。两者冲突时以本文件为准（仅限 htmlGenius 范围）。

## 打 dist 商店包（Chrome Web Store）

**必须用 `scripts/pack.sh`，严禁手动 zip 打包上传。** 历史上手动 zip 上传被商店拒收（"清单中 key 字段的值与当前内容不符"）。

- 产物：`dist/htmlGenius-<version>.zip`，`manifest.json` 在 zip 根目录（商店硬性要求）。
- 脚本关键操作（**手动 zip 会漏，导致商店拒收**）：
  - **删除 manifest 的 `key` 与 `update_url` 字段**（只动 staging 副本，源 `extension/manifest.json` 保留 `key`）。`key` 是本地开发用来钉死扩展 ID 的；商店包里带了 `key` 会被拒，报「清单中 "key" 字段的值与当前内容不符」。商店端会按其登记的公钥分配 ID，不需要 manifest 里的 key。
  - 排除 `*-test.html`、`*-test.js`、`icons/icon-512*`（512 是商店图标素材，manifest 只引用 16/48/128）、弃用的 cormorant 字体、`.DS_Store`、`__MACOSX`。
  - 三道自检：安全（无 pem/db/client_secret）→ manifest 合规（无 key/update_url）→ 结构（关键文件在根）。任一不过即中止。
- 发版顺序：`manifest.version` 递增 → `git add` 本次相关文件 → commit（中文，`feat(<版本>): …`）→ `push origin main` → `bash scripts/pack.sh`。`dist/` 整目录已 gitignore，不入库。

## Feature branch 迭代约定（合并回 main 前）

在 feature branch 上做迭代时（尚未合并回 main 成为主版本）：

- **不打 dist 包**：`scripts/pack.sh` 只在合并回 main / 发布主版本时跑；branch 上的中间提交不打包。
- **不反复递增版本号**：整个 branch 的开发**停在切入时的当前版本**（例如切入时是 0.9.13，就一直用 0.9.13），多次提交共用同一版本号，不要每个提交都 bump `manifest.version`。
- **合并回 main 时统一收口**：成为主版本时才递增**一个**版本号 + 按上节同步用户向文档（README/RELEASE_NOTES 等）+ 打 dist。
- 即：版本号的递增与 dist 打包是「回到主版本」的动作，不是 branch 内每次迭代的动作。

## 发版 / 推送 main 前必做：同步文档

**推送到 main 前必须同步更新用户向文档，不能只提交代码。** 每次发版（含安全 / 重构批次）都要：

- **`RELEASE_NOTES.md`**：文件顶部加新版本条目，写**用户可见**的变化（不写内部实现 / 审计编号），最新版本在最上。
- **`README.md`**：① 若有用户可见的能力 / 限制 / 权限变化，同步更新描述与「已知限制」段；② **`## 最近更新` 段只保留最近 3 条版本条目**（最新一条标「当前版本」），发新版时：加新条目到顶、删掉第 4 条，并保持与 `RELEASE_NOTES.md` 一致；段尾保留「完整历史见 RELEASE_NOTES.md」链接。其余正文是 evergreen 产品介绍，不放逐版本流水账。
- **`DEVELOPMENT.md` / `LOCAL_BRIDGE.md`**：架构、部署、bridge 用法、环境变量有变时同步（如新增 env、改了打包 / 部署口径）。
- 版本号：扩展看 `extension/manifest.json`（0.x.x）；bridge 看 `bridge/package.json`（自 1.0.0 起独立编号，发 npm 时单独递增）。
- `docs/` 已 gitignore：审计报告 / spec / 计划等本地工作文档不入库；README / DEVELOPMENT 只链根目录下的文档，docs/ 内容一律以「本地工作文档，不入库」说明，不留断链。

## Bridge 版本升级：必须同步所有引用点

升 `bridge/package.json` 版本（发 npm）时，**所有写死/引用 bridge 版本的地方必须一起改到同版本**，否则用户按旧版本号 `npx` 安装会拿到旧包、或指向不存在的版本。已知引用点（升级时逐一核对）：

- `extension/background.js`：`TARGET_BRIDGE_VERSION = "..."`（bootstrap 安装命令、setup prompt 都从此派生）+ 附近注释里的 `@htmlgenius/bridge@<ver>`。
- `landing/demo-2026-07/shared.js`：`var bridgeVersion = '...'`（官网 setup prompt / 命令由此派生）。
- `landing/demo-2026-07/setup.html`：写死的 `npx --yes @htmlgenius/bridge@<ver> doctor/setup/uninstall`（含 `data-copy` 属性，多处）。
- 全仓核对：`grep -rn "@htmlgenius/bridge@\|TARGET_BRIDGE_VERSION\|bridgeVersion" extension/ landing/`。

顺序：**先确认新版本上 registry，再提交/部署引用了新版本号的改动**（否则安装命令会指向不存在的版本）。发布通道见下。

## Bridge 发 npm 的两条通道（2026-08-04 踩坑，必读）

npm 已收紧策略：**bypass 类 token（Automation / Granular）被限制用于"direct publishing"**（日志见 `npm tokens that bypass 2FA are being restricted for … direct publishing`，`gh.io/npm-gat-bypass2fa-deprecation`）。后果：**本地 `npm publish` 现在强制 OTP**，即便 `NPM_TOKEN` 是 Automation 类型也绕不过（报 `EOTP`）。

- **CI 发布（免 OTP，首选）**：推 tag `bridge-v<ver>`（如 `bridge-v1.0.2`）→ `.github/workflows/publish-bridge.yml` 在 `macos-latest` 跑 `npm ci → npm test → npm publish --provenance`，用仓库 **Secrets 的 `NPM_TOKEN`（须 Automation 类型）** + GitHub OIDC provenance，**CI 非交互不弹 OTP**。这是当前免 OTP 发 bridge 的可靠通道。
  - 流程：改版本 + 同步引用 → commit → `git push origin <分支>` → `git tag bridge-v<ver> && git push origin bridge-v<ver>` → 看 Actions 跑通 → `npm view @htmlgenius/bridge@<ver> version` 确认上 registry。
  - 历史：`bridge-v0.9.2/0.9.3/0.9.4/1.0.0` 走 CI；`1.0.1` 当时是**本地带 OTP** 发的（无对应 tag）。
- **本地 `npm publish`（需 OTP，兜底）**：`cd bridge && npm publish --otp=<6位码>`，OTP 来自绑定的 Authenticator（30 秒有效）。CI 被拦或临时发版时用。
  - `NPM_TOKEN` 定义在 `~/.zshenv`（`export NPM_TOKEN=...`），`~/.npmrc` 通过 `${NPM_TOKEN}` 引用；**轮换 token 改 `~/.zshenv` 那一行**（注释已写明）。token 类型用 `npm token list` 看——只有 Automation 能免 OTP，Publish/Granular 都要 OTP。
  - 本地直发顺序：先 `npm publish --otp=` 确认上 registry，再提交引用（避免提交指向不存在版本的引用）。

## 安全审计修复批次（2026-07-29，v0.9.10）

本批次按 `docs/AUDIT-2026-07-28.md`（v1）与 `docs/AUDIT-2026-07-28-v2.md`（v2）修复。完成范围与**有意排除**项（用户决定）记录如下，避免后续重复劳动或误以为未做：

- **已完成**：BE-1/2/3、SUP-1/2、CORE-1/2/3/4/5/6/7、SUP-3/4/7/8/9/10/11/12、BR-1、R-2/4/5/6/7/9/10/11/12、BE-4/5/6/7/9、BR-4/5/6/7、WEB-1/2/3/4/5/6、R-8/R-24、OAuth 凭据轮换与本地文件清理。
- **有意排除（仍开放，需用户决策）**：R-1（跨租户 IDOR，需 documents 表加 team_id + 数据迁移）、R-3（HMAC 密钥 fail-closed，需运维先配 `HG_STREAM_SECRET`）、SUP-5（token 迁 `storage.local`，多设备 UX 变更）、BE-11（session 绝对寿命上限，强制重登）、CORE-8（权限面收窄——本版反而为修 hint 加了 `tabs` 权限）。
- **测试**：bridge `npm test` 319/0；服务端 pytest（除 Playwright UI）全绿。`tests/test_relocate.py`、`tests/test_ui.py` 3 个失败为 v0.4/v0.5 时代遗留的过时 UI 测试（选择器引用旧结构），非本批引入。
