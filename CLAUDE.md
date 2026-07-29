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

## 发版 / 推送 main 前必做：同步文档

**推送到 main 前必须同步更新用户向文档，不能只提交代码。** 每次发版（含安全 / 重构批次）都要：

- **`RELEASE_NOTES.md`**：文件顶部加新版本条目，写**用户可见**的变化（不写内部实现 / 审计编号），最新版本在最上。
- **`README.md`**：若有用户可见的能力 / 限制 / 权限变化，同步更新描述与「已知限制」段。README 是 evergreen 产品介绍，不做逐版本流水账，版本细节只链 `RELEASE_NOTES.md`。
- **`DEVELOPMENT.md` / `LOCAL_BRIDGE.md`**：架构、部署、bridge 用法、环境变量有变时同步（如新增 env、改了打包 / 部署口径）。
- 版本号：扩展看 `extension/manifest.json`（0.x.x）；bridge 看 `bridge/package.json`（自 1.0.0 起独立编号，发 npm 时单独递增）。
- `docs/` 已 gitignore：审计报告 / spec / 计划等本地工作文档不入库；README / DEVELOPMENT 只链根目录下的文档，docs/ 内容一律以「本地工作文档，不入库」说明，不留断链。

## Bridge 版本升级：必须同步所有引用点

升 `bridge/package.json` 版本（发 npm）时，**所有写死/引用 bridge 版本的地方必须一起改到同版本**，否则用户按旧版本号 `npx` 安装会拿到旧包、或指向不存在的版本。已知引用点（升级时逐一核对）：

- `extension/background.js`：`TARGET_BRIDGE_VERSION = "..."`（bootstrap 安装命令、setup prompt 都从此派生）+ 附近注释里的 `@htmlgenius/bridge@<ver>`。
- `landing/demo-2026-07/shared.js`：`var bridgeVersion = '...'`（官网 setup prompt / 命令由此派生）。
- `landing/demo-2026-07/setup.html`：写死的 `npx --yes @htmlgenius/bridge@<ver> doctor/setup/uninstall`（含 `data-copy` 属性，多处）。
- 全仓核对：`grep -rn "@htmlgenius/bridge@\|TARGET_BRIDGE_VERSION\|bridgeVersion" extension/ landing/`。

顺序：**先 `npm publish` 确认新版本上 registry，再提交/部署引用了新版本号的改动**（否则安装命令会指向不存在的版本）。bridge 走 2FA 时发布需 OTP。

## 安全审计修复批次（2026-07-29，v0.9.10）

本批次按 `docs/AUDIT-2026-07-28.md`（v1）与 `docs/AUDIT-2026-07-28-v2.md`（v2）修复。完成范围与**有意排除**项（用户决定）记录如下，避免后续重复劳动或误以为未做：

- **已完成**：BE-1/2/3、SUP-1/2、CORE-1/2/3/4/5/6/7、SUP-3/4/7/8/9/10/11/12、BR-1、R-2/4/5/6/7/9/10/11/12、BE-4/5/6/7/9、BR-4/5/6/7、WEB-1/2/3/4/5/6、R-8/R-24、OAuth 凭据轮换与本地文件清理。
- **有意排除（仍开放，需用户决策）**：R-1（跨租户 IDOR，需 documents 表加 team_id + 数据迁移）、R-3（HMAC 密钥 fail-closed，需运维先配 `HG_STREAM_SECRET`）、SUP-5（token 迁 `storage.local`，多设备 UX 变更）、BE-11（session 绝对寿命上限，强制重登）、CORE-8（权限面收窄——本版反而为修 hint 加了 `tabs` 权限）。
- **测试**：bridge `npm test` 319/0；服务端 pytest（除 Playwright UI）全绿。`tests/test_relocate.py`、`tests/test_ui.py` 3 个失败为 v0.4/v0.5 时代遗留的过时 UI 测试（选择器引用旧结构），非本批引入。
