"""Task 4: SSE RoomManager + /api/stream 端点测试."""
import asyncio
import os
import threading

import httpx

from server.app import app
from server import sessions
from server import storage
from server.models import DocumentCreate
from server.sse import rooms


def _run(coro):
    """在新线程的新事件循环里跑 async 测试体。

    本项目不依赖 pytest-asyncio,但套件里有邻居测试(anyio 插件 + server
    fixture)会在主线程留下 running loop,导致 ``asyncio.run`` 抛
    "cannot be called from a running event loop"。换线程 + 独立 loop 最稳,
    既不污染主线程循环,也不挂起。
    """
    result: dict = {}

    def worker():
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            result["value"] = loop.run_until_complete(coro)
        except BaseException as e:  # noqa: BLE001 — 把异常透回主线程
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
    storage.init_db(tmp_path / "sse.db")
    storage.register_document(DocumentCreate(document_id="doc_x"))
    return sessions.create_session("u1", "u1", "team_a")


def test_room_manager_broadcast_reaches_subscribers():
    """同 room 两个订阅都收到;不同 team 的房间隔离;unsubscribe 不泄漏。"""

    async def run():
        q1 = await rooms.subscribe("team_a", "doc_x")
        q2 = await rooms.subscribe("team_a", "doc_x")
        q_other = await rooms.subscribe("team_b", "doc_x")
        await rooms.broadcast("team_a", "doc_x", "annotation:created", {"id": "ann_1"})
        m1 = await asyncio.wait_for(q1.get(), timeout=1)
        m2 = await asyncio.wait_for(q2.get(), timeout=1)
        assert m1["event"] == "annotation:created" and m1["data"]["id"] == "ann_1"
        assert m2 == m1
        # 隔离:team_b 的队列不应收到
        try:
            await asyncio.wait_for(q_other.get(), timeout=0.2)
            assert False, "不应跨 team 收到"
        except asyncio.TimeoutError:
            pass
        rooms.unsubscribe("team_a", "doc_x", q1)
        rooms.unsubscribe("team_a", "doc_x", q2)
        rooms.unsubscribe("team_b", "doc_x", q_other)
        # unsubscribe 后 broadcast 不再送达已退订队列
        await rooms.broadcast("team_a", "doc_x", "noop", {})
        try:
            await asyncio.wait_for(q1.get(), timeout=0.2)
            assert False, "已退订不应收到"
        except asyncio.TimeoutError:
            pass

    _run(run())


def test_stream_requires_token(tmp_path, monkeypatch):
    """无 token -> 401。"""
    _init(tmp_path, monkeypatch)
    transport = httpx.ASGITransport(app=app)

    async def run():
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            r = await c.get("/api/stream", params={"doc": "doc_x"})  # 无 token
            assert r.status_code == 401

    _run(run())


def test_stream_emits_hello(tmp_path, monkeypatch):
    """有 token -> 200 text/event-stream,首个 chunk 含 hello;wire 格式正确。

    直接驱动 ASGI app 收集 response.start + 首个 http.response.body chunk,
    0.5s 后断开。不用 httpx.ASGITransport 的 stream():本环境下它不向
    StreamingResponse 推送增量 body(已实测确认),用裸 ASGI 才能稳定拿到首块。
    """
    tok = _init(tmp_path, monkeypatch)

    async def run():
        scope = {
            "type": "http", "method": "GET", "path": "/api/stream",
            "raw_path": b"/api/stream",
            "query_string": ("doc=doc_x&token=" + tok).encode(),
            "headers": [], "server": ("t", 80), "client": ("c", 1),
            "root_path": "", "scheme": "http", "http_version": "1.1",
        }
        captured: dict = {}
        body_chunks: list[bytes] = []

        async def receive():
            # 喂两次:第一次 more_body=True 满足 BaseHTTPMiddleware 读取,
            # 第二次结束;之后若再被读则返回 disconnect 触发生成器收尾。
            if not receive._sent:
                receive._sent = True
                return {"type": "http.request", "body": b"", "more_body": False}
            return {"type": "http.disconnect"}

        receive._sent = False

        async def send(msg):
            if msg["type"] == "http.response.start":
                captured["status"] = msg["status"]
                captured["headers"] = {
                    k.decode(): v.decode() for k, v in msg["headers"]
                }
            elif msg["type"] == "http.response.body":
                body = msg.get("body", b"")
                if body:
                    body_chunks.append(body)

        task = asyncio.create_task(app(scope, receive, send))
        # 让服务器有机会把 hello chunk 推出来,再断开。
        await asyncio.sleep(0.5)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert captured.get("status") == 200, f"status: {captured}"
        assert captured["headers"].get("content-type", "").startswith(
            "text/event-stream"
        ), f"content-type: {captured['headers']}"
        body = b"".join(body_chunks).decode("utf-8", "replace")
        assert "event: hello" in body, f"body: {body!r}"
        assert '"room": "team_a:doc_x"' in body, f"body: {body!r}"

    _run(run())
