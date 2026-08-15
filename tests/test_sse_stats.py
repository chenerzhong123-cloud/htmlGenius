"""SSE 用量统计(容量评估)单元测试。

sse.py 的 RoomManager 在 subscribe/unsubscribe 时维护按天分桶的
connects/disconnects/peak_concurrent/peak_per_team;storage.upsert_sse_stats
按天整行覆盖(峰值取 MAX 保跨重启)。扩容决策依据 sse_stats 表。
"""
import asyncio
import threading

import pytest

from server import sse as sse_mod
from server.sse import RoomManager, TooManyConnections


def _run(coro):
    """在独立线程跑协程:Playwright 同步用例会在主线程留下运行中的事件循环,
    主线程 asyncio.run() 将抛 "cannot be called from a running event loop"(全量跑挂、单跑过的根因)。"""
    box = {}
    def _worker():
        try:
            box["v"] = asyncio.run(coro)
        except BaseException as e:  # noqa: BLE001 - 把异常带回主线程断言
            box["e"] = e
    t = threading.Thread(target=_worker)
    t.start()
    t.join()
    if "e" in box:
        raise box["e"]
    return box.get("v")


def test_stats_counters_and_peaks():
    rm = RoomManager()
    q1 = _run(rm.subscribe("t1", "d1"))
    q2 = _run(rm.subscribe("t1", "d2"))
    st = rm.stats_snapshot()
    assert st["current_concurrent"] == 2
    assert st["connects"] == 2
    assert st["peak_concurrent"] == 2
    assert st["peak_per_team"] == 2

    rm.unsubscribe("t1", "d1", q1)
    st = rm.stats_snapshot()
    assert st["disconnects"] == 1
    assert st["current_concurrent"] == 1
    # 峰值不随断开回落
    assert st["peak_concurrent"] == 2
    assert st["peak_per_team"] == 2
    rm.unsubscribe("t1", "d2", q2)


def test_stats_daily_rollover(monkeypatch):
    rm = RoomManager()
    q = _run(rm.subscribe("t1", "d1"))
    rm.unsubscribe("t1", "d1", q)
    assert rm.stats_snapshot()["connects"] == 1
    # 跨天:计数清零换新桶,峰值独立
    monkeypatch.setattr(sse_mod, "_today", lambda: "2000-01-02")
    q2 = _run(rm.subscribe("t1", "d1"))
    st = rm.stats_snapshot()
    assert st["date"] == "2000-01-02"
    assert st["connects"] == 1 and st["disconnects"] == 0
    rm.unsubscribe("t1", "d1", q2)


def test_per_team_limit_still_enforced():
    rm = RoomManager()
    rm._per_team["t1"] = sse_mod._MAX_PER_TEAM if hasattr(sse_mod, "_MAX_PER_TEAM") else 10
    with pytest.raises(TooManyConnections):
        _run(rm.subscribe("t1", "d"))


def test_storage_upsert_keeps_peak(tmp_path, monkeypatch):
    from server import storage

    storage.init_db(tmp_path / "t.db")
    storage.upsert_sse_stats("2000-01-01", 10, 8, 5, 3)
    # 重启后内存计数从零开始,但峰值不得被更小值覆盖
    storage.upsert_sse_stats("2000-01-01", 2, 1, 1, 1)
    rows = storage.list_sse_stats()
    assert len(rows) == 1
    assert rows[0]["connects"] == 2  # 累计值以后落盘为准
    assert rows[0]["peak_concurrent"] == 5  # 峰值保留
    assert rows[0]["peak_per_team"] == 3
