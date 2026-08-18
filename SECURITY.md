# 安全策略与加固记录

## 报告漏洞

请勿通过公开 issue 报告安全漏洞。联系：见仓库所有者邮箱（deuce.monster 站点公示）。

## 2026-08 安全加固（feat/security-hardening 分支）

依据 Mimosa 深度扫描（scan-2026-08-18T00-40-14.648Z，sealed）+ 人工代码审计：

| 项 | 措施 | 状态 |
|---|---|---|
| P0-2 | auth(20/min/IP)、密码登录(8/5min/IP+email)、diagnostics(10/min/IP)、批注写(60/min/user) 限流 | ✅ 已落地 |
| P0-3 | 生产缺 `HG_LARK_APP_SECRET` 时 OAuth state fail-closed（503，不再回退公开常量） | ✅ 已落地 |
| P1-5 | 扩展全站 host 权限改 `optional_host_permissions` 按需授权；content script 改 `scripting.registerContentScripts` 动态注册 | ✅ 已落地（发布新版商店包生效） |
| P1-6 | 批注 comment/quote/instruction 服务端剥离 C0 控制符（渲染侧已有 esc + 安全 linkify，纵深防御） | ✅ 已落地 |
| P2-9 | 全局安全响应头：nosniff / Referrer-Policy / X-Frame-Options: SAMEORIGIN / HSTS(https) | ✅ 已落地 |
| P2-10 | `audit_log` 表：登录成功与团队治理动作（加人/转让/移除/解散）落库 | ✅ 已落地 |
| P0-1 | gitleaks CI（全历史扫描）+ `.gitleaksignore`（manifest 公钥误报） | ✅ 已落地 |

### 扫描器 finding 人工复核结论（P1-4）

- `content-script.js:139 SSRF`：**误报**。是 content script 在浏览器里 fetch 当前页面自身的 artifact URI（同源、客户端行为），非服务端请求。
- `storage.js:237/242 Mongo sort 注入`：**误报**。是 JS `Array.prototype.sort`，非 MongoDB。
- `applyRestoredArtifact XSS (content-script.js:847/1476)`：**低风险、按设计接受**。输入仅来自本机 IndexedDB 的本地快照（用户自己的编辑内容），且恢复前经 SHA-256 哈希校验；对其实施 sanitize 会破坏字节级哈希匹配（功能依赖）。粘贴路径已走 DOMPurify（`content-script.js` paste 处理）。

### 依赖审计（pip-audit）

- 运行时依赖中 **starlette 0.49.3 有 6 条已知公告**，修复版（≥1.3.1）需 fastapi≥0.129 → **Python ≥3.10**；当前运行环境为 Python 3.9（已 EOL）。见下方"待运维处理"。
- 其余公告（pip/requests/urllib3/pytest 等）属审计工具临时环境或 dev 依赖，不影响线上。
- `uv.lock` 已整体升级（uvicorn 0.52.3 等）。

## 待运维处理（用户操作清单）

1. **升级服务器 Python 3.9 → 3.11/3.12**，随后 `fastapi>=0.129` + `starlette>=1.3.1`（消除 6 条 starlette 公告；Python 3.9 已 EOL 无安全补丁）。
2. 确认 `/etc/htmlgenius/env`（600 权限）中已配 `HG_LARK_APP_SECRET`（P0-3 后生产缺它 = OAuth state 503，部署前必须核对，否则飞书登录不可用）。
3. 预防性轮换 Lark App Secret（历史扫描未发现真实泄露，仅占位值；轮换属低成本防御）。
4. SQLite 隐私数据：确认服务器上 `annotations.db*` 属主为服务用户且权限 600；备份通道加密；评估是否需要定期清理 diagnostics 表。
5. （可选）Chrome Web Store 发新版本，使扩展权限收窄生效——注意老用户升级后需在侧边栏重新点"启用全站批注权限"。
