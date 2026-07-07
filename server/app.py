import asyncio
import json
import os
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import lark, sessions, storage
from .auth import (
    Session,
    consume_state,
    issue_state,
    require_session,
    require_session_query,
)
from .models import AnnotationCreate, DocumentCreate, VersionCreate
from .presence import update as presence_update
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


# === 鉴权 (v0.5 lark-oauth) ===


class CallbackIn(BaseModel):
    code: str
    redirect_uri: str
    state: str


class DevLoginIn(BaseModel):
    open_id: str
    name: str
    team: Optional[str] = None


@app.get("/auth/lark/login")
def lark_login(redirect: str):
    """返回飞书授权 URL + 自签 state。扩展用 launchWebAuthFlow 打开它。"""
    state = issue_state()
    return {"auth_url": lark.authorize_url(redirect, state), "state": state}


@app.post("/auth/lark/callback")
def lark_callback(payload: CallbackIn):
    """code -> 飞书用户信息 -> 建 session。state 必须由 /auth/lark/login 签发。"""
    if not consume_state(payload.state):
        raise HTTPException(status_code=400, detail="bad state")
    try:
        info = lark.exchange_code(payload.code, payload.redirect_uri)
    except Exception as e:  # 飞书侧失败(网络/凭据/code 失效)
        raise HTTPException(status_code=502, detail=f"lark exchange failed: {e}")
    token = sessions.create_session(info["open_id"], info["name"], info["team_id"])
    return {
        "token": token,
        "user": {"id": info["open_id"], "name": info["name"]},
        "team_id": info["team_id"],
    }


@app.get("/auth/me")
def auth_me(session: Session = Depends(require_session)):
    """扩展启动时校验 session 是否仍有效。"""
    return {"id": session.open_id, "name": session.name, "team_id": session.team_id}


@app.post("/auth/logout")
def auth_logout(
    authorization: Optional[str] = Header(None),
    session: Session = Depends(require_session),
):
    """注销:require_session 已证 token 有效,这里删行立即失效。"""
    token = (authorization or "").removeprefix("Bearer ").strip()
    if token:
        sessions.delete_session(token)
    return {"ok": True}


@app.post("/auth/dev-login")
def dev_login(payload: DevLoginIn):
    """开发旁路:不依赖飞书直接建 session。仅当 HG_AUTH_ALLOW_DEV=1 挂载可用。

    测试与本地开发用它造任意 open_id/name/team 的 session。
    """
    if os.environ.get("HG_AUTH_ALLOW_DEV") != "1":
        raise HTTPException(status_code=404, detail="dev login disabled")
    team = payload.team or os.environ.get("HG_DEFAULT_TEAM", "default")
    token = sessions.create_session(payload.open_id, payload.name, team)
    return {
        "token": token,
        "user": {"id": payload.open_id, "name": payload.name},
        "team_id": team,
    }


# === 文档 / 版本 (无鉴权,本地工具) ===


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


# === 批注 (v0.5: author/team 全从 session 注入,删 X-User 头) ===


@app.post("/api/annotations")
async def create_annotation(
    payload: AnnotationCreate, session: Session = Depends(require_session)
):
    # author.id = 飞书 open_id(后端 session 注入,不可伪造);team_id = session.team_id
    payload.author = {"id": session.open_id, "name": session.name}
    ann = storage.save_annotation(payload, team_id=session.team_id)
    await rooms.broadcast(session.team_id, payload.document_id, "annotation:created", ann)
    return ann


@app.get("/api/annotations")
def list_annotations(document_id: str, session: Session = Depends(require_session)):
    return {"items": storage.list_annotations(document_id, session.team_id)}


@app.delete("/api/annotations/{aid}")
async def delete_annotation(aid: str, session: Session = Depends(require_session)):
    try:
        deleted = storage.delete_annotation(aid, session.team_id, session.open_id)
    except PermissionError:
        raise HTTPException(status_code=403, detail="not owner")
    for d in deleted:
        await rooms.broadcast(session.team_id, d["document_id"], "annotation:deleted", {"id": d["id"]})
    return {"ok": True, "deleted": [d["id"] for d in deleted]}


def _sse_chunk(event: str, data: dict) -> str:
    """SSE 单条消息:event 行 + JSON data 行 + 空行。"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class PresenceIn(BaseModel):
    """POST /api/presence 请求体。user 由服务端从 session 组装,客户端只传 doc + op。"""

    doc: str
    op: str = "join"


@app.post("/api/presence")
async def presence_post(payload: PresenceIn, session: Session = Depends(require_session)):
    """上报在线状态并广播 presence。返回 {"ok": True}。"""
    user = {"id": session.open_id, "name": session.name}
    await presence_update(session.team_id, payload.doc, user, payload.op)
    return {"ok": True}


@app.get("/api/stream")
async def stream(doc: str, session: Session = Depends(require_session_query)):
    """SSE 长连接:hello → 转发房间广播 → 15s keepalive 注释。

    session 由 require_session_query 从 ?token= 注入(永不来自请求体);
    doc 是路径外 query 参数。EventSource 不能设自定义头,故 token 走 query。
    """
    team_id = session.team_id

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
