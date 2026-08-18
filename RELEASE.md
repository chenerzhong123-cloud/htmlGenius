# htmlGenius 发布规程(所有 Agent / 人类通用)

> 本文档是「合并/推送 main」的**唯一权威流程**。Claude Code 用户会被 `.claude/settings.json` 的 hook 自动强制;**其他 Agent 必须在执行本流程时手动运行校验脚本**——它就是 hook 背后的同一个判分器,工具无关:
>
> ```bash
> bash scripts/release-check.sh push
> ```
>
> 规则本身迭代 = 直接修改 `scripts/release-check.sh` 并提交(不走私聊/口头)。

## 0. 适用场景

把 feature 分支合并进 `main`、向 `origin/main` 推送、或进行一次发版。分支迭代期间的普通提交(不碰 main)**不适用**本规程,只需遵守:不递增版本号、不打 dist(详见 CLAUDE.md「Feature branch 迭代约定」)。

## 1. 合并前的准备

1. 确认分支工作全部提交、测试通过(`uv run pytest tests/ -q`,3 个 Playwright 遗留失败可接受;改了 bridge 则 `cd bridge && npm test`)。
2. 决定版本号:若本次合并**成为主版本**(发版),`extension/manifest.json` 递增**一个** patch 位;若只是收口不发版,版本号不动。

## 2. 文档同步(阻断项——不达标不许 push)

每次推 main 都要过这两条机器检查(hook 与脚本同源):

| 检查 | 要求 |
|---|---|
| `RELEASE_NOTES.md` | 顶部 40 行内必须有 `## v<manifest 版本>(` 条目,写**用户可见**变化 |
| `README.md` | 必须包含当前版本号;`## 最近更新` 段只保留最近 3 条(最新标「当前版本」),与 RELEASE_NOTES 一致 |

其他用户向文档按需:`DEVELOPMENT.md` / `LOCAL_BRIDGE.md`(架构、env、部署口径变化时)。commit message 用中文。

## 3. 自检并推送

```bash
bash scripts/release-check.sh push   # 阻断项失败会 exit 2 并说明原因;修复后重跑
git push origin main
```

紧急热修逃生门:`HG_SKIP_RELEASE_CHECK=1 bash scripts/release-check.sh push`(或在 Claude Code 里带该环境变量),**必须在提交信息里写明跳过原因**,事后补齐规范动作。

## 4. push 成功后的收尾清单(按序执行)

1. **删已合并分支**(约定:只留 main 一条长期线):
   ```bash
   for b in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
     [ "$b" != main ] && git merge-base --is-ancestor "$b" main && git branch -d "$b"
   done
   git push origin --delete <远端同名分支>   # 若远端存在
   ```
   ⚠️ 若分支曾挂在 worktree 上:删除前先把其中 **gitignored 的本地文档**(docs/、spec/plan 等)复制到主检出对应目录,worktree 用 `git worktree remove` 移除。
2. **部署后端**(仅当本次 push 含 `server/` 变更;脚本会提醒):
   ```bash
   COPYFILE_DISABLE=1 tar -cf - -C server <变更的 .py 文件> \
     | ssh aliyun 'tar -xf - -C /root/htmlGenius/server && systemctl restart htmlgenius'
   ```
   部署后**线上冒烟**至少一条新/变更端点(curl 预期状态码),并清理冒烟数据。
3. **发版打包**(仅当本次为主版本发版):`bash scripts/pack.sh`——**严禁手动 zip**(会漏删 manifest key 被商店拒收)。产物 `dist/htmlGenius-<版本>.zip`。

## 5. 仓库外人工项(机器查不到,发版时逐条向用户确认)

- [ ] Chrome Web Store 上传 zip + **数据用途声明**与隐私政策一致(当前应声明:PII/身份验证/个人通讯/位置(IP)/用户活动(Analytics)/网站内容)
- [ ] 隐私政策页(https://www.deuce.monster/htmlgenius/privacy.html)与数据行为一致;变更时改 `landing/demo-2026-07/privacy.html` 并 `scp` 到 `aliyun:/var/www/htmlgenius/`
- [ ] 生产部署是否需要用户审批(动线上服务器前确认授权)
- [ ] bridge 版本变化时:Trusted Publishing 发 npm 的完整顺序(见 CLAUDE.md「Bridge 版本升级」)

## 6. 故障与回退

- 文档/脚本本身出问题:改 `scripts/release-check.sh`,正常 commit/push 迭代。
- 已推送但漏了收尾动作:补做即可(分支清理/部署不晚于当天完成)。
- 发版后发现缺陷:走新分支修复,再次走本规程;hotfix 可用逃生门但须说明。
