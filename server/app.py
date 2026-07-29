import asyncio
import html
import json
import os
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import google, lark, sessions, storage, teams
from .auth import (
    Session,
    consume_state,
    consume_stream_ticket,
    issue_state,
    issue_stream_ticket,
    require_session,
    require_session_query,
    _STREAM_TICKET_TTL,
)
from .models import AnnotationBodyPatch, AnnotationCreate, DocumentCreate, VersionCreate
from .presence import update as presence_update
from .sse import rooms, TooManyConnections

BASE = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("HTMLEDITOR_DB", BASE / "annotations.db"))

# BE-3 / BE-7: 环境判定。HG_ENV∈{dev,development,test,testing,local} 视为非生产;
# 未设或其它值(production/prod/staging/…)一律按生产处理 —— 安全默认。
_DEV_LOGIN_ENVS = {"dev", "development", "test", "testing", "local"}


def _is_dev_env() -> bool:
    return os.environ.get("HG_ENV", "").strip().lower() in _DEV_LOGIN_ENVS


# BE-9: 显式 CORS origin 列表替代 allow_origins=["*"]。默认放:
#   - 扩展 origin(chrome-extension://<扩展ID>,ID 由 manifest key 的 SHA256 推导)
#   - 官网 https://www.deuce.monster
# HG_CORS_ORIGINS(env,逗号分隔)可整体覆盖/追加。注意:content-script 在宿主页面
# 发起的请求 Origin 是宿主页(如 https://open.feishu.cn)—— 若直接由 content-script
# 跨域调后端,需把宿主 origin 也加入 HG_CORS_ORIGINS;推荐经 background SW 中转
# (其 fetch 的 Origin 为扩展自身,已在默认列表内)。
def _cors_origins() -> list[str]:
    env = os.environ.get("HG_CORS_ORIGINS", "").strip()
    if env:
        return [o.strip() for o in env.split(",") if o.strip()]
    return [
        "chrome-extension://ppobilnafpchnmjjflgafohnbdjlbbac",
        "https://www.deuce.monster",
    ]


# BE-7: 生产(HG_ENV 非 dev)关闭 /docs /redoc /openapi.json,并改用不泄露内部代号的 title。
app = FastAPI(
    title="htmlGenius API",
    docs_url="/docs" if _is_dev_env() else None,
    redoc_url="/redoc" if _is_dev_env() else None,
    openapi_url="/openapi.json" if _is_dev_env() else None,
)
storage.init_db(DB_PATH)

# CORS:content-script 从任意页面(如 open.feishu.cn)跨域调后端,
# 需 CORS 头 + OPTIONS 预检。扩展后端标准做法(session_token 做鉴权,CORS 只控可达)。
# allow_credentials=False:鉴权走 Authorization 头(非 cookie),无需凭据式 CORS。
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def no_cache_static(request, call_next):
    """开发期:静态文档不缓存,确保改 HTML 后 reload 拿到最新版(重定位/stale 验证依赖此)。"""
    response = await call_next(request)
    if request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-store"
    return response


# R-2(v0.9.9):移除 /docs、/samples 匿名静态挂载 —— /docs 会泄露 docs/ 内的 client_secret 与审计报告,
# /samples 文件名内嵌 document_id(喂跨租户 IDOR)。仅保留 /static(正规静态资源)。确需对外提供时加鉴权后再挂。
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/")
def root():
    return {"status": "ok", "viewer": "/static/viewer.html?doc=01_token"}


@app.get("/join")
def join_page(code: str):
    """加入链接落地页。扩展的 content-script 检测 ?code → 自动塞进侧边栏。"""
    # BE-1:code 是无校验的 query 参数,必须 HTML 转义后再插入,否则反射型 XSS。
    safe_code = html.escape(code, quote=True)
    return HTMLResponse(
        f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>加入团队 · htmlGenius</title></head>
<body style="font-family:sans-serif;padding:40px;line-height:1.6">
<h3>加入 htmlGenius 团队</h3>
<p>邀请码:<code style="font-size:1.2em">{safe_code}</code></p>
<p>已自动填入扩展侧边栏 → 点「Google 登录」→「加入」即可。</p>
<p style="color:#888;font-size:13px">若没弹出,打开 htmlGenius 侧边栏,在「加入团队」粘贴上面的码。</p>
</body></html>""",
        media_type="text/html; charset=utf-8",
    )


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
    except Exception as e:  # 飞书侧失败(网络/凭据/code 失效/user_info 路径)
        # BE-6:完整异常(含飞书响应)只 log 服务端;对客户端返通用 detail,不泄露上游细节。
        print(f"[lark_callback] exchange failed: {e!r}", flush=True)
        raise HTTPException(status_code=502, detail="upstream error")
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


# BE-3:dev-login 是测试/本地旁路,绝不允许在生产可用。双重门:
#   ① HG_AUTH_ALLOW_DEV=1(显式开)  且  ② HG_ENV 属明确的非生产环境。
# HG_ENV 未设/为 production/prod/staging 等 → 一律禁用(安全默认)。即便生产误设
# HG_AUTH_ALLOW_DEV=1,只要 HG_ENV 不是开发值(_is_dev_env 复用 BE-7 同款判定),后门仍打不开。
def _dev_login_enabled() -> bool:
    if os.environ.get("HG_AUTH_ALLOW_DEV") != "1":
        return False
    return _is_dev_env()


@app.post("/auth/dev-login")
def dev_login(payload: DevLoginIn):
    """开发旁路:不依赖飞书直接建 session。仅开发/测试环境(HG_AUTH_ALLOW_DEV=1 且
    HG_ENV∈dev/test/…)可用。生产无论如何都不应开启。

    测试与本地开发用它造任意 open_id/name/team 的 session。
    """
    if not _dev_login_enabled():
        raise HTTPException(status_code=404, detail="dev login disabled")
    team = payload.team or os.environ.get("HG_DEFAULT_TEAM", "default")
    token = sessions.create_session(payload.open_id, payload.name, team)
    return {
        "token": token,
        "user": {"id": payload.open_id, "name": payload.name},
        "team_id": team,
    }


# === Google 身份 + 邀请码 (档3) ===


class GoogleIn(BaseModel):
    id_token: str
    action: Optional[str] = None  # "join" | "create"
    code: Optional[str] = None
    team_name: Optional[str] = None


class GoogleSessionIn(BaseModel):
    id_token: str
    team_id: str


@app.post("/auth/google")
def auth_google(payload: GoogleIn):
    """Google 登录:验身份 → upsert 用户 →(可选:join 凭码 / create 新团队)→ 返回 teams。

    无 action 时是纯"身份 + 我的团队列表"查询(侧栏静默重登用它)。
    """
    try:
        info = google.verify(payload.id_token)
    except Exception as e:  # token 无效/aud 不符
        # BE-6:异常详情(JWKS 路径/PyJWT 内部状态)只 log;客户端只见通用提示。
        print(f"[auth_google] verify failed: {e!r}", flush=True)
        raise HTTPException(status_code=401, detail="authentication failed")
    teams.upsert_user(info["sub"], info["email"], info["name"], info["picture"])
    if payload.action == "join":
        if not payload.code:
            raise HTTPException(status_code=400, detail="code required for join")
        if not teams.redeem_invite(payload.code, info["sub"]):
            raise HTTPException(status_code=400, detail="invalid or expired code")
    elif payload.action == "create":
        teams.create_team(payload.team_name or "", info["sub"])
    return {
        "sub": info["sub"],
        "email": info["email"],
        "name": info["name"],
        "teams": teams.user_teams(info["sub"]),
    }


@app.post("/auth/google/session")
def auth_google_session(payload: GoogleSessionIn):
    """选一个 team → 校验 membership → 发协同用 session token(复用 sessions)。"""
    try:
        info = google.verify(payload.id_token)
    except Exception as e:
        # BE-6:不向未鉴权调用者泄露 verify 失败细节;完整 {e!r} 只进服务端日志。
        print(f"[auth_google_session] verify failed: {e!r}", flush=True)
        raise HTTPException(status_code=401, detail="authentication failed")
    if not teams.is_member(info["sub"], payload.team_id):
        raise HTTPException(status_code=403, detail="not a member of this team")
    token = sessions.create_session(info["sub"], info["name"], payload.team_id)
    return {
        "token": token,
        "user": {"id": info["sub"], "name": info["name"]},
        "team_id": payload.team_id,
    }


@app.post("/auth/invites")
def create_invite(session: Session = Depends(require_session)):
    """当前 session 的 team 生成邀请码(任意成员可生)。"""
    code = teams.create_invite(session.team_id, session.open_id)
    return {"code": code, "team_id": session.team_id, "join_url": f"/htmlgenius/join?code={code}"}


# === 文档 / 版本 (BE-2:全部需 session 鉴权;HTML 响应加严格 CSP 防存储型 XSS) ===
# 旧版无鉴权且把用户 HTML 以 text/html 直吐 → 匿名植入 <script> + 诱使打开 = 存储型
# XSS → 账户接管,DELETE 也匿名可删。现:写/读/删全要 Bearer session;HTML 响应加
# default-src 'none' CSP(浏览器仍解析 DOM 供预览,但不执行脚本/不加载子资源)。


@app.post("/api/documents")
def create_document(payload: DocumentCreate, session: Session = Depends(require_session)):
    return storage.register_document(payload)


@app.post("/api/documents/{document_id}/versions")
def add_version(document_id: str, payload: VersionCreate, session: Session = Depends(require_session)):
    try:
        result = storage.add_version(document_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="document not found")
    storage.enforce_window(document_id, keep=20)  # v0.2:滚动窗口
    return result


@app.get("/api/documents/{document_id}/versions")
def list_versions(document_id: str, session: Session = Depends(require_session)):
    return {"items": storage.list_versions(document_id)}


@app.get("/api/documents/{document_id}/versions/{version}")
def get_version_html(document_id: str, version: int, session: Session = Depends(require_session)):
    doc_html = storage.get_version_html(document_id, version)
    if doc_html is None:
        raise HTTPException(status_code=404, detail="version not found")
    # 存储的 HTML 来自用户/协作者,以 text/html 渲染即存储型 XSS。加严格 CSP:
    # 浏览器仍解析 DOM(viewer 预览可用)但不执行脚本/不加载任何子资源 → 彻底失效。
    return Response(
        content=doc_html,
        media_type="text/html",
        headers={
            # R-9:default-src 不回退 base-uri/form-action/frame-ancestors;补齐以防
            # <base href>/<form action>/meta refresh 跳转钓鱼 与 第三方 iframe 嵌入(clickjacking)。
            "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.delete("/api/documents/{document_id}/versions/{version}")
def delete_version(document_id: str, version: int, session: Session = Depends(require_session)):
    try:
        deleted = storage.delete_version(document_id, version)
    except ValueError:
        raise HTTPException(status_code=400, detail="cannot delete current version")
    if not deleted:
        raise HTTPException(status_code=404, detail="version not found")
    return {"ok": True}


@app.get("/api/documents/{document_id}")
def get_document(document_id: str, session: Session = Depends(require_session)):
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
    print(f"[ann] CREATE team={session.team_id} doc={payload.document_id} id={ann['id']} author={session.open_id}", flush=True)
    await rooms.broadcast(session.team_id, payload.document_id, "annotation:created", ann)
    return ann


@app.get("/api/annotations")
def list_annotations(document_id: str, session: Session = Depends(require_session)):
    items = storage.list_annotations(document_id, session.team_id)
    print(f"[ann] LIST team={session.team_id} doc={document_id} -> {len(items)}", flush=True)
    return {"items": items}


@app.delete("/api/annotations/{aid}")
async def delete_annotation(aid: str, session: Session = Depends(require_session)):
    try:
        deleted = storage.delete_annotation(aid, session.team_id, session.open_id)
    except PermissionError:
        raise HTTPException(status_code=403, detail="not owner")
    for d in deleted:
        await rooms.broadcast(session.team_id, d["document_id"], "annotation:deleted", {"id": d["id"]})
    return {"ok": True, "deleted": [d["id"] for d in deleted]}


class AnnotationUpdate(BaseModel):
    """PATCH /api/annotations/:id 请求体。

    body 按 ``AnnotationBodyPatch`` 校验(各字段 max_length + 类型,任意 dict 不再放行),
    再用 ``exclude_unset=True`` 取出客户端实际传入的字段(保留部分更新语义,默认值不
    覆盖原值),交 storage 与现有 body 合并。
    """

    body: AnnotationBodyPatch


@app.patch("/api/annotations/{aid}")
async def update_annotation(
    aid: str, payload: AnnotationUpdate, session: Session = Depends(require_session)
):
    # 作者校验由 storage 做(跨团队/非作者 → PermissionError → 403);仅作者可改自己留下的评论。
    patch = payload.body.model_dump(exclude_unset=True)  # BE-5:只合并实际传入的字段
    try:
        ann = storage.update_annotation(aid, session.team_id, session.open_id, patch)
    except PermissionError:
        raise HTTPException(status_code=403, detail="not owner")
    if ann is None:
        raise HTTPException(status_code=404, detail="annotation not found")
    print(f"[ann] UPDATE team={session.team_id} doc={ann['document_id']} id={aid} author={session.open_id}", flush=True)
    await rooms.broadcast(session.team_id, ann["document_id"], "annotation:updated", ann)
    return ann


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


@app.post("/api/stream/ticket")
def stream_ticket(session: Session = Depends(require_session)):
    """SUP-2:发短时效流票据(绑定 session.team_id),供 SSE 连接使用。

    EventSource 不能设自定义头 → 旧方案把长期 session token 拼进 ?token= 落日志即泄漏。
    改由本端点(需 Bearer 鉴权)换一张短时效票据,SSE 用 ?ticket= 连接,token 不再进 URL。
    """
    return {"ticket": issue_stream_ticket(session.team_id), "ttl": _STREAM_TICKET_TTL}


@app.get("/api/stream")
async def stream(doc: str = "", ticket: Optional[str] = Query(None)):
    """SSE 长连接:hello → 转发房间广播 → 15s keepalive 注释。

    SUP-2/R-11(v0.9.9):仅接受 ``?ticket=``(POST /api/stream/ticket 换取的短时效票据)。
    长期 session token 不再进 URL(旧 ``?token=`` 回退已下线,避免落访问日志/反代日志)。
    team_id 一律来自服务端验证过的票据签名,绝不信任客户端传入。
    doc 设为可选默认空:无凭据时仍能优先返回 401(而非缺参 422),与既有测试/行为一致。
    """
    team_id = consume_stream_ticket(ticket) if ticket else None
    if team_id is None:
        raise HTTPException(status_code=401, detail="invalid stream credential")

    # BE-4: 订阅前先过并发配额(单 team / 全局),超额 429。subscribe 在返回流之前完成
    # 检查与计数(检查与自增之间无 await,单事件循环内无竞态),确保超额连接不占资源;
    # 退订在 gen() 的 finally 保证计数随连接断开回落。
    try:
        q = await rooms.subscribe(team_id, doc)
    except TooManyConnections as e:
        raise HTTPException(status_code=429, detail=str(e))

    async def gen():
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
