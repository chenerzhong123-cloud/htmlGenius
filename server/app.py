import asyncio
import json
import os
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import storage
from .auth import require_team, require_team_query
from .models import AnnotationCreate, DocumentCreate, VersionCreate
from .sse import rooms

BASE = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("HTMLEDITOR_DB", BASE / "annotations.db"))

app = FastAPI(title="htmlGenius · stage0")
storage.init_db(DB_PATH)


@app.middleware("http")
async def no_cache_static(request, call_next):
    """开发期:静态文档不缓存,确保改 HTML 后 reload 拿到最新版(重定位/stale 验证依赖此)。"""
    response = await call_next(request)
    if request.url.path.startswith(("/samples", "/docs", "/static")):
        response.headers["Cache-Control"] = "no-store"
    return response


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
app.mount("/samples", StaticFiles(directory=BASE / "samples"), name="samples")
app.mount("/docs", StaticFiles(directory=BASE / "docs"), name="docs")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/")
def root():
    return {"status": "ok", "viewer": "/static/viewer.html?doc=01_token"}


@app.post("/api/documents")
def create_document(payload: DocumentCreate):
    return storage.register_document(payload)


@app.post("/api/documents/{document_id}/versions")
def add_version(document_id: str, payload: VersionCreate):
    try:
        result = storage.add_version(document_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="document not found")
    storage.enforce_window(document_id, keep=20)  # v0.2:滚动窗口
    return result


@app.get("/api/documents/{document_id}/versions")
def list_versions(document_id: str):
    return {"items": storage.list_versions(document_id)}


@app.get("/api/documents/{document_id}/versions/{version}")
def get_version_html(document_id: str, version: int):
    html = storage.get_version_html(document_id, version)
    if html is None:
        raise HTTPException(status_code=404, detail="version not found")
    return Response(content=html, media_type="text/html")


@app.delete("/api/documents/{document_id}/versions/{version}")
def delete_version(document_id: str, version: int):
    try:
        deleted = storage.delete_version(document_id, version)
    except ValueError:
        raise HTTPException(status_code=400, detail="cannot delete current version")
    if not deleted:
        raise HTTPException(status_code=404, detail="version not found")
    return {"ok": True}


@app.get("/api/documents/{document_id}")
def get_document(document_id: str):
    doc = storage.get_document(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="document not found")
    return doc


@app.post("/api/annotations")
def create_annotation(
    payload: AnnotationCreate,
    team_id: str = Depends(require_team),
    x_user_id: str = Header("u_self", alias="X-User-Id"),
    x_user_name: str = Header("作者", alias="X-User-Name"),
):
    # team_id 永远来自 token (server-injected); author 永远来自 header,不被请求体覆盖
    payload.author = {"id": x_user_id, "name": x_user_name}
    return storage.save_annotation(payload, team_id=team_id)


@app.get("/api/annotations")
def list_annotations(document_id: str, team_id: str = Depends(require_team)):
    return {"items": storage.list_annotations(document_id, team_id)}


@app.delete("/api/annotations/{aid}")
def delete_annotation(
    aid: str,
    team_id: str = Depends(require_team),
    x_user_id: str = Header("u_self", alias="X-User-Id"),
):
    try:
        deleted = storage.delete_annotation(aid, team_id, x_user_id)  # list[dict]
    except PermissionError:
        raise HTTPException(status_code=403, detail="not owner")
    return {"ok": True, "deleted": [d["id"] for d in deleted]}


def _sse_chunk(event: str, data: dict) -> str:
    """SSE 单条消息:event 行 + JSON data 行 + 空行。"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/stream")
async def stream(doc: str, team_id: str = Depends(require_team_query)):
    """SSE 长连接:hello → 转发房间广播 → 15s keepalive 注释。

    team_id 由 require_team_query 从 ?token= 注入(永不来自请求体);
    doc 是路径外 query 参数。EventSource 不能设自定义头,故 token 走 query。
    """
    async def gen():
        q = await rooms.subscribe(team_id, doc)
        try:
            yield _sse_chunk("hello", {"room": f"{team_id}:{doc}"})
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield _sse_chunk(msg["event"], msg["data"])
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # keepalive 注释行
        finally:
            rooms.unsubscribe(team_id, doc, q)

    return StreamingResponse(gen(), media_type="text/event-stream")
