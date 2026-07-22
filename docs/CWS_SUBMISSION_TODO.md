# Chrome Web Store 提交 To-Do（htmlGenius v0.8.1）

> 所有文案 / 权限说明 / 隐私声明都在 [`STORE_SUBMISSION.md`](./STORE_SUBMISSION.md)，直接复制即可。
> Dashboard 入口：https://chrome.google.com/webstore/devconsole → 选 htmlGenius。
>
> **⚠️ 上传文件**：用 `dist/htmlGenius-0.8.1.zip`（pack.sh 产物，已剥离 `key`）。
> **不要**手动压缩 `extension/` 目录——源 manifest 带 `key`（本地开发钉 ID 用），上传会报「key 字段值与当前内容不符」。
> 本次相对已上线 v0.5.1 的新增权限：`nativeMessaging`、`notifications`、`offscreen`（其余未变）。

---

## A. 提交前自查（5 分钟）

- [ ] `chrome://extensions` → 开发者模式 → 「加载已解压」选 `extension/` → 重载，确认：
  - 划词评论 / 编辑 / 复制 Prompt 正常
  - **新权限能跑**：发一次给 Codex/Claude → 完成时**弹通知 + 叮声**（notifications / offscreen）
  - host 未装时优雅提示「bridge not installed」（nativeMessaging 降级）
- [ ] macOS 上 Codex + Claude 候选闭环各跑一次（已跑过 ✅）
- [ ] Google Cloud OAuth 同意屏 = **Production**；`https://<扩展ID>.chromiumapp.org/` 已注册（identity 沿用 v0.5.1，大概率已配，确认下）

## B. Dashboard ——「打包 / Package」

- [ ] 上传 `dist/htmlGenius-0.8.1.zip`
- [ ] 系统会标记 **3 个新增权限**（nativeMessaging / notifications / offscreen），逐个点开填 justification（粘 `STORE_SUBMISSION.md §2` 里 ⭐ 那三行英文）

## C. Dashboard ——「商品详情 / Store Listing」

- [ ] **图标**：上传新的 128×128（用 `extension/icons/icon128.png`）
- [ ] **截图**：换 3–5 张 1280×800（Mint 主题 + 候选版本号 `原名V1.1.html` + 发送/终止琥珀按钮 + 实时进度栏）
- [ ] **宣传图**（可选）：440×280 小图
- [ ] **类目**：Productivity / 生产力
- [ ] **简短摘要（≤132 字符）+ 详细描述**：三语都填，文案见 `STORE_SUBMISSION.md §4`（中/英/日现成）
- [ ] 语言勾选：中文 / English / 日本語

## D. Dashboard ——「隐私权 / Privacy Practices」

- [ ] **隐私政策 URL**：`https://www.deuce.monster/htmlgenius/privacy.html`（已上线，含「本机 AI Agent」段）
- [ ] **数据收集勾选**（照 `STORE_SUBMISSION.md §3`）：
  - 个人身份信息 = **是** | 身份验证 = **是** | **网站内容 = 是**（补一句：「用户主动用本机 Agent 时，评论+页面文本经 Native Messaging 发往用户本机 Claude/Codex，不发往 htmlGenius 服务器」）
  - 其余（通信 / 金融 / 健康 / 位置 / 网页历史 / 跨站追踪）= **否**
- [ ] 数据用途 = 仅核心功能；**不广告 / 不分析 / 不出售**；加密传输 = 是

## E. Dashboard ——「权限 / Permissions」+「单一用途」

- [ ] 每个权限粘 justification（`STORE_SUBMISSION.md §2` 全表）；重点是 3 个新增
- [ ] 单一用途一句话（`STORE_SUBMISSION.md §1`，已含英文）

## F. 提交审核

- [ ] 点「Submit for review / 提交审核」
- [ ] **已知预期**：老 v0.5.1 用户更新时会弹**一次** nativeMessaging 权限确认（Chrome 机制，正常）
- [ ] 审核时长：更新通常几天；nativeMessaging 是新增重点项，可能要求补充「数据流向」说明——`§2` 那句已写清「仅本机、不外传」，直接回即可

---

## 一句话总览

A 自查 → B 传 `dist/htmlGenius-0.8.1.zip` + 填 3 个新权限 → C 换图标/截图/文案 → D 隐私 URL + 勾选 → E 权限表 + 单一用途 → F 提交。
