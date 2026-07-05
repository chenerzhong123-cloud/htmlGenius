# Flaky 测试稳定化报告

分支:`v0.4-plugin-collab`。仅改测试,无生产代码改动。

## Issue 1 — presence GC 边界测试 flaky

**文件**:`tests/test_v0_4_presence.py`,函数 `test_gc_boundary_keeps_user_at_exactly_ttl`。

**根因(与任务描述一致)**:`server/presence.py` 的 `_gc` 用严格 `>` 判定。原测试用
`time.time() - _TTL` 设 `last_seen`,但写入与 GC 取 `now` 之间有实时漂移,差值偶尔
越过 `_TTL` → 被清 → 间歇失败。

**修复**:冻结时钟。`monkeypatch.setattr(presence.time, "time", lambda: <固定值>)`
替换 presence 模块看到的时钟(不动全局 `time`),固定 `last_seen=1000.0`,分别在
clock = `1000.0 + _TTL`(等于边界 → 保留)与 `1000.0 + _TTL + 0.001`(越过边界 → 清除)
两次断言,把边界语义测试为严格 `>` 而非 `>=`。保留原名、原 setup/teardown。

**验证**:
```
$ for i in 1 2 3; do uv run pytest tests/test_v0_4_presence.py -q || break; done
.........   [100%]
.........   [100%]
.........   [100%]
```

## Issue 2 — `test_plugin_pages` 在全套运行下失败

**文件**:`tests/test_plugin_pages.py`。

**根因(与任务描述不完全一致 → 见下方说明)**:任务描述归因为 chromium 启动竞争,
但实测复现的真正失败是:

```
playwright._impl._errors.Error: It looks like you are using Playwright Sync API
inside the asyncio loop. Please use the Async API instead.
```

全套运行时,前置测试(anyio 插件 + httpx + session 级 server fixture)在主线程
残留 running event loop。Playwright sync API 检测到 running loop 即直接拒绝启动。
单独跑 `tests/test_plugin_pages.py` 永远过;只要排在会留下 running loop 的测试后面
就必挂。这是测试隔离问题,不是 chromium 启动竞争。

**修复**:把整段 sync Playwright 逻辑放进独立线程(线程内建/关自己的 event loop),
彻底隔离任何 ambient loop —— 与 `test_v0_4_presence._run` 同款模式。同时保留任务
要求的 chromium 启动重试(`_launch_with_retry`,最多 3 次,1s 退避,末次异常透传)
作为高负载下的防御。

**验证**:
```
$ uv run pytest tests/test_plugin_pages.py -v
tests/test_plugin_pages.py .   [100%]   1 passed
$ uv run pytest -v            # 全套 3 次,每次 69 passed
```

## 全套稳定性

`uv run pytest -v` 连跑 3 次,均 `69 passed`,无 flake、无新失败。

## 改动清单

- `tests/test_v0_4_presence.py`:重写 `test_gc_boundary_keeps_user_at_exactly_ttl`,
  冻结 `presence.time.time`,边界两侧确定性断言。
- `tests/test_plugin_pages.py`:新增 `_launch_with_retry`(启动重试)与
  `_run_in_isolated_loop`(独立线程 + 独立事件循环执行 Playwright),测试函数改为
  调用后者并聚合断言。页面遍历、跳过缺失、title 契约不变。

## 顾虑

- 真正的失败模式与任务描述的「chromium 启动竞争」不符,而是 running-loop 隔离问题。
  修复更彻底(线程隔离 + 启动重试双保险),但请知会描述偏差。
- session 级 `browser`/`server` fixture(见 `tests/conftest.py`)在跨文件浏览器测试中
  仍可能在未来新增 test 时引入类似 loop 残留;当前 `test_plugin_pages` 已绕开,无需
  动 conftest。
