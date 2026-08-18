# Agent 协作须知(所有 AI Agent 通用)

本仓库有多个 Agent(Claude Code / Codex / Z code 等)与人类协作。无论你是什么工具,在本仓库工作时遵守:

## 必读文件

1. **`CLAUDE.md`** —— 项目全部工程约定(技术栈、分支迭代、bridge 发版、文档同步规范的详细版)
2. **`RELEASE.md`** —— **合并/推送 main 的唯一权威流程**;发布相关动作以它为准

## 三条硬规则(违反即返工)

1. **推 main 前跑 `bash scripts/release-check.sh push`**,exit 2 必须修复(通常是文档没同步)。Claude Code 用户会被 hook 自动拦截,其他 Agent 自觉手动执行同一脚本。
2. **合并到 main 后按 `RELEASE.md` §4 收尾**:删已合并分支(先搬 worktree 里的 gitignored 文档)、server/ 有变更则部署阿里云、发版用 `scripts/pack.sh` 打包(**严禁手动 zip**)。
3. **commit message 用中文**;feature 分支上不递增版本号、不打 dist。

## 边界

- `docs/` 是 gitignored 的本地工作文档(spec/计划/审计),不要提交;worktree 删除前先搬出来。
- 生产服务器(阿里云)操作前确认授权;数据库变更先备份。
- 用户向文档(README/RELEASE_NOTES/DEVELOPMENT/官网隐私页)与代码同批提交,不允许"代码先行、文档后补"。
