# 人工兜底验证清单(v0.6 → v0.7)

> 用途:这一轮 feature 主要靠自动化测试(node --test 67 例 + 浏览器纯函数测试页)兜底,
> 本清单覆盖**自动化测不到**的真实交互、真实文件改动、真实 Codex/Native Messaging、跨标签与回归。
> 勾选即通过;失败按「现象 / 复现 / 期望」记到 issue。

## 0. 环境准备

- [ ] Chrome 开启开发者模式,加载未打包 `extension/`(从 `v0.7-codex-local-bridge` 分支)。
- [ ] 准备测试文件:
  - [ ] `report.html`(单文件本地 HTML,内联 CSS/JS)
  - [ ] `report-v2.html`(同内容新路径,验 v0.6.2 受控 link)
  - [ ] 一个带相对资源(`./styles.css`)的本地页(验 v0.7 限制提示)
  - [ ] 一个远程网页(验远程临时编辑/批注不回归)
- [ ] (v0.7)Node ≥ 20、`codex login`、`codex --version` 支持 `app-server` + `generate-json-schema --out`。
- [ ] (v0.7)已跑 `cd bridge && node install-macos.mjs --extension-id <ID>` 并刷新扩展。
- [ ] 打开 DevTools console,全程留意有无 error。

## 1. v0.6 元素级编辑(交互密集,重点)

- [ ] 进入文字编辑后,右下出现「切换高级模式」;点开进入元素模式,**文字 contentEditable 关闭**(互斥)。
- [ ] 悬停页面元素:出现 inspect 框 + tooltip(标签/id/类/尺寸)。
- [ ] 点击元素:出现 select 框;「父级」可逐层上选。
- [ ] 选中元素按 **Del/Backspace** → 删除;侧边栏「删除控件」按钮同样生效。
- [ ] 「复制控件」→ 生成同级副本,可继续调整。
- [ ] 同级两个元素**拖拽重排**成功(中点跨越即插入)。
- [ ] 元素样式:字体 / 字间距 / 行距 / padding 四项都生效。
- [ ] Emoji 库打开 → 选中插入到光标位。
- [ ] **撤销/重做回归(历史 bug)**:改文字 → 改颜色(从 set panel)→ Ctrl+Z 两次 → 能撤回;Ctrl+Shift+Z / Ctrl+Y 能重做到颜色那一步。
- [ ] Esc:退出文字编辑 / 取消选中。
- [ ] 退出高级模式后,文字编辑恢复正常。

## 2. v0.6.1 修改契约 Composer

- [ ] 顶层批注卡片有「生成任务」按钮;**回复卡片没有**该按钮。
- [ ] 单条「生成任务」→ Composer 仅含该顶层批注及其完整回复树。
- [ ] 底部「生成修改任务」→ 含**所有未失效顶层批注**,不含 stale。
- [ ] 无顶层批注时,底部按钮 **disabled**,点击不打开空 Composer。
- [ ] 四模式默认选中「精准修补」;模式卡选中态清晰。
- [ ] 切「结构重组」/「重新生成」:补充说明 < 10 字时,**两个复制按钮 disabled** 且字段下有错误提示;≥10 字后可复制。
- [ ] 「精准修补」/「局部优化」补充说明可留空即可复制。
- [ ] 复制 Prompt:内容含任务模式/文档/修改契约/批注定位/强制语句。
- [ ] 复制 JSON:`schema_version:1`、mode、root ids 与 Composer 一致。
- [ ] (可选)禁用剪贴板权限 → 出现只读 fallback textarea。
- [ ] Composer 关闭只丢临时状态,不改批注;关闭后焦点回到触发按钮。
- [ ] zh/en/ja 切换:Composer 所有文案切换,无 key 泄漏、无硬编码中文。
- [ ] restructure 主按钮文案为「复制规划任务」。

## 3. v0.6.2 本地 artifact 版本对账(关键 bug 修复点)

- [ ] 打开 `report.html` 加批注 → 关闭/刷新 → 批注仍在。
- [ ] 插件内改 body → 刷新(磁盘未变)→ 编辑快照恢复;toolbar/高亮/undo 仍工作。
- [ ] **外部编辑器只改 `head` CSS 或元素 class** → 点「重新读取文件」→ 页面显示**外部新视觉**,**不**恢复旧 body 快照(核心修复)。
- [ ] 外部编辑器改正文 → reload → 能锚定的评论 `open`,找不到的 `stale`(置底分区,不静默丢)。
- [ ] 有未导出的插件内编辑时点「重新读取文件」→ **先弹确认**;取消则不 reload。
- [ ] 新文件路径 `report-v2.html` 默认视为**新文档**(不自动继承批注)。
- [ ] (测 `artifact-version-test.html`)打开 title 仍为 PASS。

## 4. v0.7 Codex Local Bridge(macOS,需 codex)

> 自动化只覆盖到 fake app-server;真实 Codex + Native Messaging 必须手测。

- [ ] **未装 host**:点「交给 Codex」→ 显示安装指引(bridge.notInstalled);复制 Prompt/JSON 仍正常。
- [ ] host 已装但 codex 未登录/不兼容:显示准确状态(bridge.checkCodex / CODEX_INCOMPATIBLE),未建 run/session。
- [ ] `report.html` 加一条精准批注 → 新建 bridge task → 生成 candidate;
      - [ ] **原文件字节哈希 run 后不变**(用 `shasum -a 256` 前后对比);
      - [ ] candidate 在 `<源目录>/.htmlgenius-candidates/<run-id>/result.html`;
      - [ ] Chrome 自动打开 candidate;
      - [ ] 批注变为 open/stale。
- [ ] 再加一条批注,选「继续」→ 使用**同一 thread_id**、新 turn_id;**无任何外部历史 thread** 出现。
- [ ] host 开始前/运行中修改 source → **结果不打开**,source 仍是你的新版本,run 显示冲突(sourceChanged)。
- [ ] 让任务不写 result(如极端 brief)→ 显示失败,**不导航**。
- [ ] `restructure` 模式:**不存在**「交给 Codex」按钮,只能「复制规划任务」。
- [ ] 运行期 Composer 锁定(字段 + copy/bridge 均 disabled),状态「Codex 正在生成…」。
- [ ] 关闭 Side Panel → run 继续;重开 → 已完成/失败 run 状态可恢复;**不展示模型对话内容**。
- [ ] `cd bridge && node --test test/` → 67/67(回归)。

## 5. 跨切面 / 回归

- [ ] 深色 / 浅色主题切换:Composer、Bridge 区、artifact reload 确认窗都跟随。
- [ ] 中/英/日三语:所有新 UI(contract.*/bridge.*/artifact.*)均切换,无遗漏。
- [ ] 批注创建/回复/编辑/删除语义未变(作者校验、回复链)。
- [ ] 远程网页:批注 + 临时编辑(刷新丢失)行为未变。
- [ ] 本地网页:编辑可另存为 HTML。
- [ ] 全程 console 无 error / 无未捕获 promise。

## 6. 完成判据

- 第 1-3 节全绿 → v0.6/v0.6.1/v0.6.2 可合并候选。
- 第 4 节全绿 → v0.7 可作为本地 Bridge 首发。
- 任一项失败:记现象 + 复现步骤,回到对应分支修;**不要**在未通过前合并 main 或 bump manifest。
