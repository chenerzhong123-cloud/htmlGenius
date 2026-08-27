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

> **流程护栏（2026-08-17 起）**：`.claude/settings.json` 配了 Claude Code hook——push main 时 `scripts/release-check.sh` 会**阻断**文档未同步（RELEASE_NOTES/README 缺当前版本条目）的推送；push 成功后自动注入收尾清单（删已合并分支 / 部署 server 变更 / 发版打包）。紧急热修逃生门：`HG_SKIP_RELEASE_CHECK=1`，须在提交信息里说明原因。改校验规则 = 直接改该脚本并提交（git 即版本管理）。

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

顺序：改 `bridge/package.json` 版本 + 同步三处引用 **一起 commit** → push 分支 → 打 tag → CI 自动发布（Trusted Publishing，详见 `MAINTENANCE.md`）→ `npm view` 确认上 registry **后**再把分支合并到 main（避免 main 的引用指向还没发上去的版本）。

## 低频操作与历史记录 → `MAINTENANCE.md`

Bridge 发 npm 的 Trusted Publishing 详细流程（OIDC 配置、CI 挂了重发、应急本地兜底）、安全审计修复批次（2026-07-29 v0.9.10）的完成/排除清单等**低频内容已迁至 `MAINTENANCE.md`**，做对应操作时再查，不必常驻上下文。

## 埋点数据拉取（方案已固定，2026-08-27 起）

**看埋点/分析数据不要再探索拉取方式，直接跑 `scripts/analytics-pull.sh`**（线上模式已验证可用）：

- `bash scripts/analytics-pull.sh` —— 线上库报表：ssh aliyun，stdin 管道把 `scripts/analytics-report.py` 送上服务器执行，**只读 SELECT，不 scp 库文件**。报表含：漏斗（用户级）/ 留存（次日、7 日）/ 活跃（按天）/ 编辑时长（edit_start→edit_end 配对）/ 参数分布健康检查。主机与库路径可用 `HG_ANALYTICS_HOST` / `HG_ANALYTICS_DB` 覆盖（默认 aliyun / `/root/htmlGenius/annotations.db`）。
- `bash scripts/analytics-pull.sh /path/to/annotations.db` —— 本地 sqlite 库。
- `bash scripts/analytics-pull.sh --exclude hgcid_9d695fa8` —— 剔除自有/测试 client（前缀匹配；`hgcid_9d695fa8` 是 deuce 本人主力机，看真实用户数据时必须剔除）。
- 约束：线上 python3 < 3.7（无 fromisoformat、`%z` 不认冒号），`analytics-report.py` 必须保持纯 stdlib + 宽松时间戳解析；事件白名单镜像在 `extension/analytics-core.js`，加事件要两侧同步。
