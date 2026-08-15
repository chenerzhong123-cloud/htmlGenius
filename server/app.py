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
from pydantic import BaseModel, Field

from . import email_auth, google, lark, sessions, storage, teams
from .envutil import is_dev_env
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

# BE-3 / BE-7: 环境判定统一在 envutil.is_dev_env(app/auth 共用,避免循环 import)。


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
    docs_url="/docs" if is_dev_env() else None,
    redoc_url="/redoc" if is_dev_env() else None,
    openapi_url="/openapi.json" if is_dev_env() else None,
)
storage.init_db(DB_PATH)
# R-3:生产环境若未配流密钥,显式告警(SSE 票据将 fail-closed 拒签 → POST /api/stream/ticket 503)。
if not is_dev_env() and not (
    os.environ.get("HG_STREAM_SECRET") or os.environ.get("HG_LARK_APP_SECRET")
):
    print(
        "[startup] WARN HG_STREAM_SECRET 未配置:生产 SSE 票据将 fail-closed(POST /api/stream/ticket → 503)",
        flush=True,
    )

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


@app.on_event("startup")
async def _sse_stats_flusher():
    """SSE 用量统计(容量评估):内存计数器每 5 分钟落盘一次到 sse_stats(每天一行)。

    写放大极小(288 次/天);进程重启只丢未落盘的当日增量,峰值跨重启保留(取 MAX)。
    """
    import contextlib

    async def _flush_loop():
        while True:
            await asyncio.sleep(300)
            with contextlib.suppress(Exception):  # 统计失败不影响业务
                st = rooms.stats_snapshot()
                storage.upsert_sse_stats(st["date"], st["connects"], st["disconnects"],
                                         st["peak_concurrent"], st["peak_per_team"])

    asyncio.create_task(_flush_loop())


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
    """扩展启动时校验 session 是否仍有效;顺带返回该用户全部团队(供侧栏团队下拉)。"""
    return {"id": session.open_id, "name": session.name, "team_id": session.team_id,
            "teams": teams.user_teams(session.open_id)}


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
    return is_dev_env()


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
        try:
            teams.create_team(payload.team_name or "", info["sub"])
        except teams.TeamLimitExceeded as e:
            raise HTTPException(status_code=409, detail=str(e))
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


# === 邮箱 + 密码登录(带邮箱验证码;与 Google/飞书 并存的第三个 provider)===


class EmailRegisterIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(min_length=8, max_length=256)
    name: Optional[str] = Field(None, max_length=100)


class EmailVerifyIn(BaseModel):
    email: str = Field(max_length=200)
    code: str = Field(min_length=6, max_length=6)
    invite_code: Optional[str] = Field(None, max_length=64)
    team_name: Optional[str] = Field(None, max_length=100)


class EmailLoginIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(min_length=1, max_length=256)


class EmailResendIn(BaseModel):
    email: str = Field(max_length=200)


@app.post("/auth/email/register")
def email_register(payload: EmailRegisterIn):
    """注册:校验 → 生成验证码 → 发邮件(未配 HG_SMTP_HOST 走日志模式)。"""
    try:
        email_auth.start_registration(payload.email, payload.password, payload.name)
    except email_auth.EmailAuthError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)
    return {"verify_required": True}


@app.post("/auth/email/verify")
def email_verify(payload: EmailVerifyIn):
    """校验验证码 → 建用户 → team 归属(邀请码加入 / 新建 / 默认)→ 发 session。"""
    try:
        return email_auth.verify(payload.email, payload.code, payload.invite_code, payload.team_name)
    except email_auth.EmailAuthError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@app.post("/auth/email/login")
def email_login(payload: EmailLoginIn):
    """邮箱+密码登录。失败不区分"邮箱不存在 / 密码错误"。"""
    try:
        return email_auth.login(payload.email, payload.password)
    except email_auth.EmailAuthError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@app.post("/auth/email/resend")
def email_resend(payload: EmailResendIn):
    """重发验证码(受 60s 冷却限制)。"""
    try:
        email_auth.resend(payload.email)
    except email_auth.EmailAuthError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)
    return {"verify_required": True}


class EmailProbeIn(BaseModel):
    email: str = Field(max_length=200)


@app.post("/auth/email/probe")
def email_probe(payload: EmailProbeIn):
    """探测邮箱是否已注册(登录/注册分支用;暴露账号是否存在,已知权衡)。"""
    try:
        return email_auth.probe(payload.email)
    except email_auth.EmailAuthError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


class SwitchTeamIn(BaseModel):
    team_id: str


@app.post("/auth/switch-team")
def switch_team(payload: SwitchTeamIn, session: Session = Depends(require_session)):
    """已登录用户切换当前活跃团队(须是该团队成员)→ 发该团队的新 session。
    用现有 session 证明身份,无需重新跑 Google OAuth(下拉切换更轻)。"""
    if not teams.is_member(session.open_id, payload.team_id):
        raise HTTPException(status_code=403, detail="not a member of this team")
    team_name = ""
    for tm in teams.user_teams(session.open_id):
        if tm["team_id"] == payload.team_id:
            team_name = tm["name"]
            break
    token = sessions.create_session(session.open_id, session.name, payload.team_id)
    return {
        "token": token,
        "team_id": payload.team_id,
        "team_name": team_name,
        "user": {"id": session.open_id, "name": session.name},
    }


class TeamJoinIn(BaseModel):
    invite_code: str = Field(min_length=1, max_length=64)


class TeamCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class TeamRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@app.post("/auth/teams/join")
def team_join(payload: TeamJoinIn, session: Session = Depends(require_session)):
    """已登录用户凭邀请码加入工作区(Google/email 通用,幂等)。无效/过期 → 400。"""
    team_id = teams.join_team(payload.invite_code, session.open_id)
    if not team_id:
        raise HTTPException(status_code=400, detail="邀请码无效或已过期")
    teams_list = teams.user_teams(session.open_id)
    team_name = next((t["name"] for t in teams_list if t["team_id"] == team_id), "")
    token = sessions.create_session(session.open_id, session.name, team_id)
    return {"token": token, "team_id": team_id, "team_name": team_name,
            "user": {"id": session.open_id, "name": session.name}, "teams": teams_list}


@app.post("/auth/teams", status_code=201)
def team_create(payload: TeamCreateIn, session: Session = Depends(require_session)):
    """已登录用户新建工作区(Google/email 通用)。超 HG_MAX_TEAMS_PER_USER → 409。"""
    try:
        team_id = teams.create_team(payload.name, session.open_id)
    except teams.TeamLimitExceeded as e:
        raise HTTPException(status_code=409, detail=str(e))
    teams_list = teams.user_teams(session.open_id)
    token = sessions.create_session(session.open_id, session.name, team_id)
    return {"token": token, "team_id": team_id,
            "team_name": payload.name or "未命名团队",
            "user": {"id": session.open_id, "name": session.name}, "teams": teams_list}


@app.patch("/auth/teams/{team_id}")
def team_rename(team_id: str, payload: TeamRenameIn, session: Session = Depends(require_session)):
    """仅团队 owner 可修改名称；前端入口隐藏不作为权限控制。"""
    try:
        name = teams.rename_team(team_id, payload.name, session.open_id)
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can rename team")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except KeyError:
        raise HTTPException(status_code=404, detail="team not found")
    return {"team_id": team_id, "name": name}


@app.post("/auth/invites")
def create_invite(session: Session = Depends(require_session)):
    """当前 session 的 team 生成邀请码(任意成员可生)。"""
    code = teams.create_invite(session.team_id, session.open_id)
    return {"code": code, "team_id": session.team_id, "join_url": f"/htmlgenius/join?code={code}"}


# === 团队治理(owner 守卫;仅适用 Google 自建团队,Lark 团队无 membership 行) ===


@app.get("/auth/teams/{team_id}/members")
def list_team_members(team_id: str, session: Session = Depends(require_session)):
    """列团队成员(任意成员可查;非成员 → 403)。"""
    if teams.member_role(session.open_id, team_id) is None:
        raise HTTPException(status_code=403, detail="not a member")
    return {"items": teams.team_members(team_id)}


class MemberByEmailIn(BaseModel):
    email: str


class TransferOwnershipIn(BaseModel):
    sub: str = Field(min_length=1, max_length=200)


@app.post("/auth/teams/{team_id}/members/by-email")
def add_member_by_email(team_id: str, payload: MemberByEmailIn, session: Session = Depends(require_session)):
    """owner 按邮箱直接加人:查已注册用户(user_id) → add_membership(幂等)。
    比"分享邀请码"更强的动作(对方无需同意即入团),故限 owner。非 owner → 403;未注册 → 404。"""
    if teams.member_role(session.open_id, team_id) != "owner":
        raise HTTPException(status_code=403, detail="only owner can add members by email")
    email = (payload.email or "").strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="valid email required")
    u = teams.user_by_email(email)
    if not u:
        raise HTTPException(status_code=404, detail="用户尚未用该 Google 账号登录过本工具，请让对方先登录一次")
    if u["user_id"] == session.open_id:
        raise HTTPException(status_code=400, detail="不能添加自己")
    teams.add_membership(u["user_id"], team_id)  # INSERT OR IGNORE → 已是成员则幂等
    return {"ok": True, "sub": u["user_id"], "name": u["name"]}


@app.post("/auth/teams/{team_id}/transfer-ownership")
def transfer_team_ownership(team_id: str, payload: TransferOwnershipIn, session: Session = Depends(require_session)):
    """owner 将所有权转给当前成员；原 owner 自动降为 member。"""
    try:
        teams.transfer_ownership(team_id, payload.sub, session.open_id)
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can transfer ownership")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "team_id": team_id, "owner_sub": payload.sub}


@app.delete("/auth/teams/{team_id}/members/{sub}")
def remove_team_member(team_id: str, sub: str, session: Session = Depends(require_session)):
    """owner 移除成员;非 owner → 403;移除自己 → 400(改用解散)。"""
    try:
        teams.remove_member(team_id, sub, session.open_id)
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can remove members")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@app.delete("/auth/teams/{team_id}")
def dissolve_team(team_id: str, session: Session = Depends(require_session)):
    """owner 解散团队(级联删团队全部数据);非 owner → 403。"""
    try:
        teams.dissolve_team(team_id, session.open_id)
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can dissolve")
    return {"ok": True}


# === 诊断上报(A+B:用户一键报告 / opt-in 自动上报;不鉴权,用户主动触发)===


@app.post("/api/diagnostics")
def submit_diagnostics(payload: dict):
    """接收诊断包。大小封顶(128KB)防滥用;不鉴权(用户主动上报/opt-in 自动)。
    payload 由扩展构造:app/chrome/os 版本、bridge 状态、provider、最近错误、Agent 流式(可能含页面内容)。
    """
    raw = json.dumps(payload, ensure_ascii=False)
    if len(raw) > 128 * 1024:
        raise HTTPException(status_code=413, detail="diagnostics payload too large")
    mode = str((payload.get("mode") if isinstance(payload, dict) else "") or "manual")[:16]
    diag_id = storage.save_diagnostics(raw, mode)
    # 顺带返回 SSE 实时并发(客户端忽略也不影响),远程排查连接水位用。
    return {"ok": True, "id": diag_id, "sse": rooms.stats_snapshot()}


# === 文档 / 版本 (BE-2:全部需 session 鉴权;HTML 响应加严格 CSP 防存储型 XSS) ===
# 旧版无鉴权且把用户 HTML 以 text/html 直吐 → 匿名植入 <script> + 诱使打开 = 存储型
# XSS → 账户接管,DELETE 也匿名可删。现:写/读/删全要 Bearer session;HTML 响应加
# default-src 'none' CSP(浏览器仍解析 DOM 供预览,但不执行脚本/不加载子资源)。


@app.post("/api/documents")
def create_document(payload: DocumentCreate, session: Session = Depends(require_session)):
    return storage.register_document(session.team_id, payload)


@app.post("/api/documents/{document_id}/versions")
def add_version(document_id: str, payload: VersionCreate, session: Session = Depends(require_session)):
    try:
        result = storage.add_version(session.team_id, document_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="document not found")
    storage.enforce_window(session.team_id, document_id, keep=20)  # v0.2:滚动窗口
    return result


@app.get("/api/documents/{document_id}/versions")
def list_versions(document_id: str, session: Session = Depends(require_session)):
    # 文档不在本团队 → 404(与 get/add/delete/get_html 一致:不属于你的文档不可见)
    if storage.get_document(session.team_id, document_id) is None:
        raise HTTPException(status_code=404, detail="document not found")
    return {"items": storage.list_versions(session.team_id, document_id)}


@app.get("/api/documents/{document_id}/versions/{version}")
def get_version_html(document_id: str, version: int, session: Session = Depends(require_session)):
    doc_html = storage.get_version_html(session.team_id, document_id, version)
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
        deleted = storage.delete_version(session.team_id, document_id, version)
    except ValueError:
        raise HTTPException(status_code=400, detail="cannot delete current version")
    if not deleted:
        raise HTTPException(status_code=404, detail="version not found")
    return {"ok": True}


@app.get("/api/documents/{document_id}")
def get_document(document_id: str, session: Session = Depends(require_session)):
    doc = storage.get_document(session.team_id, document_id)
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
    try:
        ticket = issue_stream_ticket(session.team_id)
    except RuntimeError:
        # R-3 fail-closed:生产未配 HG_STREAM_SECRET → 拒签(503),不回退公开常量。
        raise HTTPException(status_code=503, detail="stream secret not configured")
    return {"ticket": ticket, "ttl": _STREAM_TICKET_TTL}


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
