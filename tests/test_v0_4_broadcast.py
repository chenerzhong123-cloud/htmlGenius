"""Task 5: 写后广播 annotation:created / annotation:deleted.

测试策略说明(brief 原方案是 httpx 流式订阅 + 端点 POST,但本环境下
httpx.ASGITransport 不向 StreamingResponse 推送增量 body —— 已在 Task 4 实测
确认流式订阅会挂起)。此处改为 **直接订阅 rooms 队列当虚拟客户端**:
端点写后调用 ``await rooms.broadcast(...)``,广播会落入队列,我们用
``asyncio.wait_for(q.get())`` 取出并断言 event/data。这精确证明了端点以
正确的 (team, doc, event, payload) 调用广播,而 SSE 线缆的真实投递留给
T8(插件)与 T14(手测)。

v0.5: 鉴权改 session token。author 来自 session.open_id。
"""
import asyncio
import threading

import httpx

from server.app import app
from server import sessions, storage
from server.models import AnnotationCreate, DocumentCreate, TextQuoteSelector
from server.sse import rooms


def _run(coro):
    """在新线程的新事件循环里跑 async 测试体(复用 Task 4 的同款 helper)。

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
    """建库 + 返回 team_a / open_id=u1 的鉴权头。"""
    storage.init_db(tmp_path / "b.db")
    storage.register_document(DocumentCreate(document_id="doc_x"))
    return {"Authorization": "Bearer " + sessions.create_session("u1", "u1name", "team_a")}


def test_post_triggers_created_broadcast(tmp_path, monkeypatch):
    """POST /api/annotations 后,doc_x 房间队列收到 annotation:created(完整批注)。"""
    H = _init(tmp_path, monkeypatch)
    transport = httpx.ASGITransport(app=app)

    async def run():
        q = await rooms.subscribe("team_a", "doc_x")
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
                r = await c.post(
                    "/api/annotations",
                    json={
                        "document_id": "doc_x",
                        "selector": {"type": "TextQuoteSelector", "exact": "hi"},
                        "quote": "hi",
                    },
                    headers=H,
                )
                assert r.status_code == 200, r.text
                ann = r.json()
            msg = await asyncio.wait_for(q.get(), timeout=2)
            assert msg["event"] == "annotation:created"
            assert msg["data"]["id"] == ann["id"]
            assert msg["data"]["document_id"] == "doc_x"
            assert msg["data"]["quote"] == "hi"
            assert msg["data"]["author"]["id"] == "u1"
        finally:
            rooms.unsubscribe("team_a", "doc_x", q)

    _run(run())


def test_post_does_not_leak_to_other_team(tmp_path, monkeypatch):
    """team_a 的 POST 不应投递到 (team_b, doc_x) 房间。"""
    H = _init(tmp_path, monkeypatch)
    transport = httpx.ASGITransport(app=app)

    async def run():
        q_b = await rooms.subscribe("team_b", "doc_x")
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
                await c.post(
                    "/api/annotations",
                    json={
                        "document_id": "doc_x",
                        "selector": {"type": "TextQuoteSelector", "exact": "hi"},
                        "quote": "hi",
                    },
                    headers=H,
                )
            try:
                msg = await asyncio.wait_for(q_b.get(), timeout=0.3)
                raise AssertionError(f"跨 team 泄漏: {msg}")
            except asyncio.TimeoutError:
                pass  # 预期:不投递到 team_b
        finally:
            rooms.unsubscribe("team_b", "doc_x", q_b)

    _run(run())


def test_post_does_not_leak_to_other_doc(tmp_path, monkeypatch):
    """同一 team 下 doc_x 的广播不应投递到 (team_a, doc_other) 房间。"""
    H = _init(tmp_path, monkeypatch)
    storage.register_document(DocumentCreate(document_id="doc_other"))
    transport = httpx.ASGITransport(app=app)

    async def run():
        q_other = await rooms.subscribe("team_a", "doc_other")
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
                await c.post(
                    "/api/annotations",
                    json={
                        "document_id": "doc_x",
                        "selector": {"type": "TextQuoteSelector", "exact": "hi"},
                        "quote": "hi",
                    },
                    headers=H,
                )
            try:
                msg = await asyncio.wait_for(q_other.get(), timeout=0.3)
                raise AssertionError(f"跨 doc 泄漏: {msg}")
            except asyncio.TimeoutError:
                pass
        finally:
            rooms.unsubscribe("team_a", "doc_other", q_other)

    _run(run())


def test_delete_triggers_deleted_broadcast(tmp_path, monkeypatch):
    """DELETE 单条 → 队列收到 annotation:deleted, payload 含被删 id。"""
    H = _init(tmp_path, monkeypatch)
    a = storage.save_annotation(
        AnnotationCreate(
            document_id="doc_x",
            selector=TextQuoteSelector(exact="hi"),
            quote="hi",
            author={"id": "u1", "name": "阿甲"},
        ),
        team_id="team_a",
    )
    transport = httpx.ASGITransport(app=app)

    async def run():
        q = await rooms.subscribe("team_a", "doc_x")
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
                r = await c.delete(f"/api/annotations/{a['id']}", headers=H)
                assert r.status_code == 200, r.text
                assert r.json()["deleted"] == [a["id"]]
            msg = await asyncio.wait_for(q.get(), timeout=2)
            assert msg["event"] == "annotation:deleted"
            assert msg["data"] == {"id": a["id"]}
        finally:
            rooms.unsubscribe("team_a", "doc_x", q)

    _run(run())


def test_delete_cascade_broadcasts_each_id(tmp_path, monkeypatch):
    """级联删除整棵子树 → 每个被删 id 触发一条 annotation:deleted(多条事件)。"""
    H = _init(tmp_path, monkeypatch)
    parent = storage.save_annotation(
        AnnotationCreate(
            document_id="doc_x",
            selector=TextQuoteSelector(exact="p"),
            quote="p",
            author={"id": "u1", "name": "阿甲"},
        ),
        team_id="team_a",
    )
    child = storage.save_annotation(
        AnnotationCreate(
            document_id="doc_x",
            selector=TextQuoteSelector(exact="c"),
            quote="c",
            author={"id": "u2", "name": "阿乙"},
            parent_id=parent["id"],
        ),
        team_id="team_a",
    )
    grand = storage.save_annotation(
        AnnotationCreate(
            document_id="doc_x",
            selector=TextQuoteSelector(exact="g"),
            quote="g",
            author={"id": "u3", "name": "阿丙"},
            parent_id=child["id"],
        ),
        team_id="team_a",
    )
    transport = httpx.ASGITransport(app=app)

    async def run():
        q = await rooms.subscribe("team_a", "doc_x")
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
                r = await c.delete(f"/api/annotations/{parent['id']}", headers=H)
                assert r.status_code == 200, r.text
                assert set(r.json()["deleted"]) == {parent["id"], child["id"], grand["id"]}
            seen: set[str] = set()
            for _ in range(3):
                msg = await asyncio.wait_for(q.get(), timeout=2)
                assert msg["event"] == "annotation:deleted"
                assert set(msg["data"].keys()) == {"id"}
                seen.add(msg["data"]["id"])
            assert seen == {parent["id"], child["id"], grand["id"]}
        finally:
            rooms.unsubscribe("team_a", "doc_x", q)

    _run(run())


def test_delete_non_owner_still_403_and_no_broadcast(tmp_path, monkeypatch):
    """非作者 DELETE → 403 且不产生广播。"""
    _init(tmp_path, monkeypatch)
    a = storage.save_annotation(
        AnnotationCreate(
            document_id="doc_x",
            selector=TextQuoteSelector(exact="hi"),
            quote="hi",
            author={"id": "u1", "name": "阿甲"},
        ),
        team_id="team_a",
    )
    transport = httpx.ASGITransport(app=app)
    h_u2 = {"Authorization": "Bearer " + sessions.create_session("u2", "u2", "team_a")}

    async def run():
        q = await rooms.subscribe("team_a", "doc_x")
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
                r = await c.delete(f"/api/annotations/{a['id']}", headers=h_u2)
                assert r.status_code == 403
            try:
                msg = await asyncio.wait_for(q.get(), timeout=0.3)
                raise AssertionError(f"403 时不应广播: {msg}")
            except asyncio.TimeoutError:
                pass
            assert storage.get_annotation(a["id"]) is not None  # 未删
        finally:
            rooms.unsubscribe("team_a", "doc_x", q)

    _run(run())
