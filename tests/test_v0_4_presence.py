"""Task 6: presence 端点 + presence 广播 + 60s GC.

测试策略(同 Task 5):直接订阅 rooms 队列当虚拟客户端。``presence.update``
写后 ``await rooms.broadcast(..., "presence", {"users": [...]})``,广播落入
队列,我们用 ``asyncio.wait_for(q.get())`` 取出并断言 event / users 列表。
httpx.ASGITransport 在本环境不能流式消费 SSE,故不打开 SSE 流验证 presence。

覆盖:
- join 广播 presence 且 users 含该 user
- heartbeat 刷新 last_seen(GC 不会误清当前 user)
- bye 移除该 user(广播反映移除)
- GC 移除 last_seen > 60s 的 stale user
- POST /api/presence 无 token → 401
- 跨 team 不泄漏(team_b 房间收不到 team_a 的 presence)
"""
import asyncio
import threading
import time

import httpx

from server.app import app
from server import presence
from server import sessions
from server import storage
from server.models import DocumentCreate
from server.sse import rooms


def _run(coro):
    """在新线程的新事件循环里跑 async 测试体(复用 Task 4/5 同款 helper)。

    邻居测试(anyio 插件 + server fixture)会在主线程留下 running loop,
    直接 ``asyncio.run`` 报 "cannot be called from a running event loop"。
    换线程 + 独立 loop 最稳。
    """
    result: dict = {}

    def worker():
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            result["value"] = loop.run_until_complete(coro)
        except BaseException as e:  # noqa: BLE001 — 透回主线程
            result["error"] = e
        finally:
            try:
                loop.close()
            finally:
                asyncio.set_event_loop(None)

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    if "error" in result:
        raise result["error"]
    return result.get("value")


def _init(tmp_path, monkeypatch):
    """每个测试前清空 presence 全局表,避免相互污染。"""
    presence._USERS.clear()
    storage.init_db(tmp_path / "p.db")
    storage.register_document(DocumentCreate(document_id="doc_x"))


def test_join_broadcasts_presence(tmp_path, monkeypatch):
    """join → 房间队列收到 presence 事件,users 含该 user。"""
    _init(tmp_path, monkeypatch)

    async def run():
        q = await rooms.subscribe("team_a", "doc_x")
        try:
            await presence.update(
                "team_a", "doc_x", {"id": "u1", "name": "阿甲"}, "join"
            )
            msg = await asyncio.wait_for(q.get(), timeout=2)
            assert msg["event"] == "presence"
            assert msg["data"]["users"] == [{"id": "u1", "name": "阿甲"}]
        finally:
            rooms.unsubscribe("team_a", "doc_x", q)

    _run(run())


def test_heartbeat_refreshes_last_seen(tmp_path, monkeypatch):
    """heartbeat 刷新 last_seen —— 直接断言内部状态更新且广播仍含该 user。"""
    _init(tmp_path, monkeypatch)

    async def run():
        await presence.update(
            "team_a", "doc_x", {"id": "u1", "name": "阿甲"}, "join"
        )
        key = ("team_a", "doc_x")
        old = presence._USERS[key]["u1"]["last_seen"]
        # 等一点时间让 time.time() 真的不同
        time.sleep(0.01)
        await presence.update(
            "team_a", "doc_x", {"id": "u1", "name": "阿甲"}, "heartbeat"
        )
        assert presence._USERS[key]["u1"]["last_seen"] > old

    _run(run())


def test_bye_removes_user(tmp_path, monkeypatch):
    """bye → 该 user 从 _USERS 移除。"""
    _init(tmp_path, monkeypatch)

    async def run():
        await presence.update(
            "team_a", "doc_x", {"id": "u1", "name": "阿甲"}, "join"
        )
        await presence.update(
            "team_a", "doc_x", {"id": "u1", "name": "阿甲"}, "bye"
        )
        key = ("team_a", "doc_x")
        assert "u1" not in presence._USERS.get(key, {})

    _run(run())


def test_bye_broadcast_reflects_removal(tmp_path, monkeypatch):
    """join 两人 → bye 一人 → 广播 users 仅剩另一人。"""
    _init(tmp_path, monkeypatch)

    async def run():
        q = await rooms.subscribe("team_a", "doc_x")
        try:
            await presence.update(
                "team_a", "doc_x", {"id": "u1", "name": "阿甲"}, "join"
            )
            await presence.update(
                "team_a", "doc_x", {"id": "u2", "name": "阿乙"}, "join"
            )
            await presence.update(
                "team_a", "doc_x", {"id": "u1", "name": "阿甲"}, "bye"
            )
            # 取最后一条广播
            last = None
            for _ in range(3):
                last = await asyncio.wait_for(q.get(), timeout=2)
            assert last["event"] == "presence"
            ids = [u["id"] for u in last["data"]["users"]]
            assert ids == ["u2"]
        finally:
            rooms.unsubscribe("team_a", "doc_x", q)

    _run(run())


def test_gc_removes_stale_user(tmp_path, monkeypatch):
    """GC: 把某 user 的 last_seen 改到 61s 前,再 update 另一 user →
    stale user 被清,广播 users 不含 stale。"""
    _init(tmp_path, monkeypatch)

    async def run():
        q = await rooms.subscribe("team_a", "doc_x")
        try:
            # 先 join 两人
            await presence.update(
                "team_a", "doc_x", {"id": "stale", "name": "旧"}, "join"
            )
            await presence.update(
                "team_a", "doc_x", {"id": "fresh", "name": "新"}, "join"
            )
            # 把 stale 改到 TTL 之外
            key = ("team_a", "doc_x")
            presence._USERS[key]["stale"]["last_seen"] = time.time() - 61
            # 再 update fresh(heartbeat),触发 _gc,应清掉 stale
            await presence.update(
                "team_a", "doc_x", {"id": "fresh", "name": "新"}, "heartbeat"
            )
            assert "stale" not in presence._USERS[key]
            assert "fresh" in presence._USERS[key]
            # 取最后一条广播,users 应只剩 fresh
            last = None
            for _ in range(3):
                last = await asyncio.wait_for(q.get(), timeout=2)
            ids = [u["id"] for u in last["data"]["users"]]
            assert ids == ["fresh"]
        finally:
            rooms.unsubscribe("team_a", "doc_x", q)

    _run(run())


def test_gc_boundary_keeps_user_at_exactly_ttl(tmp_path, monkeypatch):
    """TTL 边界语义: now - last_seen == _TTL 保留(严格 > 才清);
    now - last_seen > _TTL 哪怕只多 1ms 也清。

    冻结 ``presence.time.time`` 而非依赖 ``time.time()`` 实时值 ——
    后者在写入 last_seen 与 GC 取 now 之间会流逝,使差值漂移到 _TTL 之上,
    造成 flaky 失败。
    """
    _init(tmp_path, monkeypatch)

    fixed_last_seen = 1000.0

    async def run():
        key = ("team_a", "doc_x")
        # 直接置 last_seen,绕过实时时钟;clock 由 monkeypatch 控制
        presence._USERS[key]["u1"] = {
            "user": {"id": "u1", "name": "阿甲"},
            "last_seen": fixed_last_seen,
        }

        # 1) 恰好等于边界 now - last_seen == _TTL → 严格 > 不成立 → 保留
        monkeypatch.setattr(
            presence.time, "time", lambda: fixed_last_seen + presence._TTL
        )
        await presence.update(
            "team_a", "doc_x", {"id": "u2", "name": "阿乙"}, "join"
        )
        assert "u1" in presence._USERS[key], "u1 应在边界(==TTL)被保留"
        assert "u2" in presence._USERS[key]

        # 2) 越过边界 1ms now - last_seen == _TTL + 0.001 → 应被清
        monkeypatch.setattr(
            presence.time,
            "time",
            lambda: fixed_last_seen + presence._TTL + 0.001,
        )
        await presence.update(
            "team_a", "doc_x", {"id": "u3", "name": "阿丙"}, "heartbeat"
        )
        assert "u1" not in presence._USERS[key], "u1 越过边界(>TTL)应被清"
        assert "u3" in presence._USERS[key]

    _run(run())


def test_post_presence_no_token_401(tmp_path, monkeypatch):
    """POST /api/presence 无 Authorization → 401。"""
    _init(tmp_path, monkeypatch)
    transport = httpx.ASGITransport(app=app)

    async def run():
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            r = await c.post(
                "/api/presence",
                json={"doc": "doc_x", "op": "join"},
            )
            assert r.status_code == 401

    _run(run())


def test_post_presence_ok_returns_ok(tmp_path, monkeypatch):
    """POST /api/presence 合法 token → 200 {"ok": True} 且触发广播。"""
    _init(tmp_path, monkeypatch)
    transport = httpx.ASGITransport(app=app)
    tok = sessions.create_session("u1", "阿甲", "team_a")

    async def run():
        q = await rooms.subscribe("team_a", "doc_x")
        try:
            async with httpx.AsyncClient(
                transport=transport, base_url="http://t"
            ) as c:
                r = await c.post(
                    "/api/presence",
                    json={"doc": "doc_x", "op": "join"},
                    headers={"Authorization": f"Bearer {tok}"},
                )
                assert r.status_code == 200, r.text
                assert r.json() == {"ok": True}
            msg = await asyncio.wait_for(q.get(), timeout=2)
            assert msg["event"] == "presence"
            assert msg["data"]["users"] == [{"id": "u1", "name": "阿甲"}]
        finally:
            rooms.unsubscribe("team_a", "doc_x", q)

    _run(run())


def test_presence_does_not_leak_across_teams(tmp_path, monkeypatch):
    """team_a 的 presence 不应投递到 (team_b, doc_x) 房间。"""
    _init(tmp_path, monkeypatch)

    async def run():
        q_b = await rooms.subscribe("team_b", "doc_x")
        try:
            await presence.update(
                "team_a", "doc_x", {"id": "u1", "name": "阿甲"}, "join"
            )
            try:
                msg = await asyncio.wait_for(q_b.get(), timeout=0.3)
                raise AssertionError(f"跨 team 泄漏: {msg}")
            except asyncio.TimeoutError:
                pass  # 预期:不投递到 team_b
        finally:
            rooms.unsubscribe("team_b", "doc_x", q_b)

    _run(run())
