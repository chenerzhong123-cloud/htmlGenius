# @htmlgenius/bridge

HTML Genius 的**本地连接组件**——一个 Chrome 原生消息宿主（Native Messaging Host），把 [HTML Genius](https://www.deuce.monster/htmlgenius/) 扩展整理好的「修改契约」交给你**本机已登录**的 AI Agent（Claude Code / Codex / GitHub Copilot），产出一份**可回退的候选 HTML**。

- **只写候选，绝不覆盖你的源文件**；候选以 `原名V1.1.html` 这样带版本号的独立文件发布。
- **只用你的本机登录态**：不存任何凭证、不读取你的历史会话、不输出路径 / token。
- 开源、可审计：源码见 [GitHub 仓库](https://github.com/chenerzhong123-cloud/htmlGenius/tree/main/bridge)。

## 这是什么

它是扩展与本机 Agent 之间的桥。HTML Genius 侧边栏里的「发送给 Codex / Claude Code / GitHub Copilot」按钮，背后就是它在你的电脑上调用各 Agent 的**官方**程序完成编辑任务。

## 安装（通常无需手动执行）

推荐直接在 HTML Genius 扩展里操作：未连接时，打开 Side Panel 发送按钮旁的 **⌄ 下拉**或契约页的 **Connection Center**，按提示复制那条已填好扩展 ID 的命令运行即可。

等价的手动命令：

```bash
# 只读体检（不写任何文件）
npx --yes @htmlgenius/bridge@0.9.1 doctor --json --extension-id <你的扩展ID>

# 安装（幂等；写入用户级受管目录 + Chrome 原生宿主注册）
npx --yes @htmlgenius/bridge@0.9.1 setup --json --scope user --extension-id <你的扩展ID>

# 卸载（只删本组件自己的文件，不动任何 Agent）
npx --yes @htmlgenius/bridge@0.9.1 uninstall --json --scope user
```

扩展 ID 在 `chrome://extensions` → HTML Genius 卡片上（一串 32 位字母）。

## 要求

- **macOS**（暂不支持 Windows / Linux）
- **Node.js** `^20.19.0 || >=22.12.0`
- 至少一个本机已登录的 Agent：
  - **Codex**：安装 Codex / ChatGPT 桌面应用并登录（推荐，常驻热服务最快）
  - **Claude Code**：安装后运行 `claude auth login`
  - **GitHub Copilot**：本机已登录 Copilot（CLI 可选，缺失时用 SDK 自带运行时）

## 安全边界

- 受控 CLI：`doctor / setup / repair / uninstall / version`；`--json` 时 stdout 有且仅有一个 JSON，绝不含绝对路径。
- `setup` 幂等、版本化受管目录（`~/.htmlgenius/bridge/versions/<v>/`）；仅 `--scope user`，拒绝 root。
- 注册文件的 `allowed_origins` 只含你给定的扩展 ID；ID 不匹配拒绝覆盖。
- Copilot 运行在受限模式（仅文件读写 + 逐路径校验，禁 shell / 网络 / 子任务）；每次发送一个新会话，绝不续发你已有的会话。

更多用法与排错见官网 [Agent 说明](https://www.deuce.monster/htmlgenius/agents.html) 与仓库 [`docs/LOCAL_BRIDGE.md`](https://github.com/chenerzhong123-cloud/htmlGenius/blob/main/docs/LOCAL_BRIDGE.md)。
