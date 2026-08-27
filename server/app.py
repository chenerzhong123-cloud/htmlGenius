import asyncio
import html
import json
import os
import re
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import email_auth, google, lark, ratelimit, sessions, storage, teams
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


# P2-9: 全局安全响应头(不覆盖路由已设置的 CSP 等专属头)。HSTS 仅在 https(或反代
# X-Forwarded-Proto=https)时下发——按 spec,浏览器忽略明文 http 上的 HSTS,但避免
# 本地 http 调试时混入无意义头。
@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    # SAMEORIGIN 而非 DENY:viewer.html 需要同源 iframe(doc-frame)加载文档预览;
    # 第三方嵌入仍被拒(clickjacking 防护不变)。
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    if request.url.scheme == "https" or forwarded == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
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


class ProfileNameIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@app.get("/auth/lark/login")
def lark_login(redirect: str):
    """返回飞书授权 URL + 自签 state。扩展用 launchWebAuthFlow 打开它。"""
    try:
        state = issue_state()
    except RuntimeError:
        # P0-3 fail-closed:生产未配 HG_LARK_APP_SECRET → state 无法安全签发,拒绝而非回退弱密钥。
        raise HTTPException(status_code=503, detail="state secret not configured")
    return {"auth_url": lark.authorize_url(redirect, state), "state": state}


@app.post("/auth/lark/callback")
def lark_callback(payload: CallbackIn, request: Request):
    """code -> 飞书用户信息 -> 建 session。state 必须由 /auth/lark/login 签发。"""
    _require_rate(_auth_limiter, _client_ip(request))
    if not consume_state(payload.state):
        raise HTTPException(status_code=400, detail="bad state")
    try:
        info = lark.exchange_code(payload.code, payload.redirect_uri)
    except Exception as e:  # 飞书侧失败(网络/凭据/code 失效/user_info 路径)
        # BE-6:完整异常(含飞书响应)只 log 服务端;对客户端返通用 detail,不泄露上游细节。
        print(f"[lark_callback] exchange failed: {e!r}", flush=True)
        raise HTTPException(status_code=502, detail="upstream error")
    name = teams.upsert_user(info["open_id"], "", info["name"], "")
    token = sessions.create_session(info["open_id"], name, info["team_id"])
    storage.insert_audit_log(info["open_id"], info["team_id"], "login.lark")
    return {
        "token": token,
        "user": {"id": info["open_id"], "name": name},
        "team_id": info["team_id"],
    }


@app.get("/auth/me")
def auth_me(session: Session = Depends(require_session)):
    """扩展启动时校验 session 是否仍有效;顺带返回该用户全部团队(供侧栏团队下拉)。"""
    return {"id": session.open_id, "name": session.name, "team_id": session.team_id,
            "teams": teams.user_teams(session.open_id)}


@app.patch("/auth/me")
def update_profile_name(payload: ProfileNameIn, session: Session = Depends(require_session)):
    """更新当前用户的显示名称；名称属于账号，不属于某个团队。"""
    try:
        name = teams.update_user_name(session.open_id, payload.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    sessions.update_user_name(session.open_id, name)
    storage.insert_audit_log(session.open_id, session.team_id, "profile.rename")
    return {"id": session.open_id, "name": name}


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
def auth_google(payload: GoogleIn, request: Request):
    """Google 登录:验身份 → upsert 用户 →(可选:join 凭码 / create 新团队)→ 返回 teams。

    无 action 时是纯"身份 + 我的团队列表"查询(侧栏静默重登用它)。
    """
    _require_rate(_auth_limiter, _client_ip(request))
    try:
        info = google.verify(payload.id_token)
    except Exception as e:  # token 无效/aud 不符
        # BE-6:异常详情(JWKS 路径/PyJWT 内部状态)只 log;客户端只见通用提示。
        print(f"[auth_google] verify failed: {e!r}", flush=True)
        raise HTTPException(status_code=401, detail="authentication failed")
    name = teams.upsert_user(info["sub"], info["email"], info["name"], info["picture"])
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
        "name": name,
        "teams": teams.user_teams(info["sub"]),
    }


@app.post("/auth/google/session")
def auth_google_session(payload: GoogleSessionIn, request: Request):
    """选一个 team → 校验 membership → 发协同用 session token(复用 sessions)。"""
    _require_rate(_auth_limiter, _client_ip(request))
    try:
        info = google.verify(payload.id_token)
    except Exception as e:
        # BE-6:不向未鉴权调用者泄露 verify 失败细节;完整 {e!r} 只进服务端日志。
        print(f"[auth_google_session] verify failed: {e!r}", flush=True)
        raise HTTPException(status_code=401, detail="authentication failed")
    if not teams.is_member(info["sub"], payload.team_id):
        raise HTTPException(status_code=403, detail="not a member of this team")
    storage.insert_audit_log(info["sub"], payload.team_id, "login.google")
    name = teams.upsert_user(info["sub"], info["email"], info["name"], info["picture"])
    token = sessions.create_session(info["sub"], name, payload.team_id)
    return {
        "token": token,
        "user": {"id": info["sub"], "name": name},
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
def email_register(payload: EmailRegisterIn, request: Request):
    """注册:校验 → 生成验证码 → 发邮件(未配 HG_SMTP_HOST 走日志模式)。"""
    _require_rate(_auth_limiter, _client_ip(request))
    try:
        email_auth.start_registration(payload.email, payload.password, payload.name)
    except email_auth.EmailAuthError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)
    return {"verify_required": True}


@app.post("/auth/email/verify")
def email_verify(payload: EmailVerifyIn, request: Request):
    """校验验证码 → 建用户 → team 归属(邀请码加入 / 新建 / 默认)→ 发 session。"""
    _require_rate(_auth_limiter, _client_ip(request))
    try:
        result = email_auth.verify(payload.email, payload.code, payload.invite_code, payload.team_name)
        storage.insert_audit_log(payload.email, result.get("team_id", ""), "login.email")
        return result
    except email_auth.EmailAuthError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@app.post("/auth/email/login")
def email_login(payload: EmailLoginIn, request: Request):
    """邮箱+密码登录。失败不区分"邮箱不存在 / 密码错误"。"""
    _require_rate(_auth_limiter, _client_ip(request))
    # P0-2:密码爆破专用窗口(8 次/5min/IP+email),比通用 auth 限流更严。
    _require_rate(_login_limiter, f"{_client_ip(request)}|{payload.email.lower()}")
    try:
        result = email_auth.login(payload.email, payload.password)
        storage.insert_audit_log(payload.email, result.get("team_id", ""), "login.email")
        return result
    except email_auth.EmailAuthError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@app.post("/auth/email/resend")
def email_resend(payload: EmailResendIn, request: Request):
    """重发验证码(受 60s 冷却限制)。"""
    _require_rate(_auth_limiter, _client_ip(request))
    try:
        email_auth.resend(payload.email)
    except email_auth.EmailAuthError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)
    return {"verify_required": True}


class EmailProbeIn(BaseModel):
    email: str = Field(max_length=200)


@app.post("/auth/email/probe")
def email_probe(payload: EmailProbeIn, request: Request):
    """探测邮箱是否已注册(登录/注册分支用;暴露账号是否存在,已知权衡)。"""
    _require_rate(_auth_limiter, _client_ip(request))
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
    storage.insert_audit_log(session.open_id, team_id, "team.add_member", u["user_id"])
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
    storage.insert_audit_log(session.open_id, team_id, "team.transfer_ownership", payload.sub)
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
    storage.insert_audit_log(session.open_id, team_id, "team.remove_member", sub)
    return {"ok": True}


@app.delete("/auth/teams/{team_id}")
def dissolve_team(team_id: str, session: Session = Depends(require_session)):
    """owner 解散团队(级联删团队全部数据);非 owner → 403。"""
    try:
        teams.dissolve_team(team_id, session.open_id)
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can dissolve")
    storage.insert_audit_log(session.open_id, team_id, "team.dissolve")
    return {"ok": True}


# === 诊断上报(A+B:用户一键报告 / opt-in 自动上报;不鉴权,用户主动触发)===


@app.post("/api/diagnostics")
def submit_diagnostics(payload: dict, request: Request):
    """接收诊断包。大小封顶(128KB)防滥用;不鉴权(用户主动上报/opt-in 自动)。
    payload 由扩展构造:app/chrome/os 版本、bridge 状态、provider、最近错误、Agent 流式(可能含页面内容)。
    """
    # P0-2:不鉴权端点必须有 IP 限流,否则可被无限刷库(写放大直接打到 SQLite)。
    _require_rate(_diag_limiter, _client_ip(request))
    raw = json.dumps(payload, ensure_ascii=False)
    if len(raw) > 128 * 1024:
        raise HTTPException(status_code=413, detail="diagnostics payload too large")
    mode = str((payload.get("mode") if isinstance(payload, dict) else "") or "manual")[:16]
    diag_id = storage.save_diagnostics(raw, mode)
    # 顺带返回 SSE 实时并发(客户端忽略也不影响),远程排查连接水位用。
    return {"ok": True, "id": diag_id, "sse": rooms.stats_snapshot()}


# === 匿名漏斗事件(埋点双写的后端路;GA 直发在扩展侧)===
# 无鉴权(未登录也要能报);三层防滥用:IP 限流 + 413(条数/体积) + 白名单(名与值都校验)。
_CODE_RE = re.compile(r"^[A-Z0-9_]{1,64}$")


def _v_enum(*allowed):
    def v(x):
        return x if isinstance(x, str) and x in allowed else None
    return v


def _v_code(x):
    return x if isinstance(x, str) and _CODE_RE.match(x) else None


def _v_bool(x):
    return x if isinstance(x, bool) else None


def _v_version(x):
    return x if isinstance(x, str) and re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){2}", x) else None


_PROVIDERS = ("claude_code_cli", "codex_app_server", "github_copilot")
_SCOPES = ("precise_patch", "local_optimize", "regenerate")
_METHODS = ("google", "email")
_LOGIN_STAGES = ("google_config", "oauth_flow", "oauth_token", "google_auth", "google_session",
                 "email_probe", "email_register", "email_resend", "email_verify", "email_login")
_LOGIN_CODES = ("GOOGLE_CONFIG_MISSING", "OAUTH_FLOW_FAILED", "OAUTH_TOKEN_MISSING", "INVALID_REQUEST",
                "UNAUTHORIZED", "CONFLICT", "INVALID_INPUT", "RATE_LIMITED", "HTTP_ERROR", "UNKNOWN")
EVENT_SPECS = {
    "panel_open": {"is_logged_in": _v_bool},
    "login_start": {"method": _v_enum(*_METHODS)},
    "login_success": {"method": _v_enum(*_METHODS)},
    "login_failed": {"method": _v_enum(*_METHODS), "stage": _v_enum(*_LOGIN_STAGES),
                     "code": _v_enum(*_LOGIN_CODES), "app_version": _v_version},
    "join_workspace": {},
    "create_workspace": {},
    "edit_start": {"is_local": _v_bool},
    "comment_create": {"is_local": _v_bool},
    "task_open": {"scope": _v_enum(*_SCOPES)},
    "task_send": {"provider": _v_enum(*_PROVIDERS), "scope": _v_enum(*_SCOPES)},
    "task_success": {"provider": _v_enum(*_PROVIDERS)},
    "task_failed": {"provider": _v_enum(*_PROVIDERS), "code": _v_code},
    # v2(协作/任务链路加深):方法枚举 google|stored —— google=静默 OAuth 重登,stored=/auth/me 已有会话恢复
    "reply_create": {"is_to_other": _v_bool},
    "others_comments_seen": {},
    "plan_request": {"provider": _v_enum(*_PROVIDERS), "scope": _v_enum(*_SCOPES)},
    "plan_confirm": {"provider": _v_enum(*_PROVIDERS), "scope": _v_enum(*_SCOPES)},
    "task_accept": {"provider": _v_enum(*_PROVIDERS)},
    "workspace_switch": {},
    "session_restore": {"method": _v_enum("google", "stored")},
    "invite_copied": {},
    "edit_end": {"is_local": _v_bool},
}

_events_limiter = ratelimit.WindowLimiter(30, 60)
_last_prune_day = {"d": ""}

# P0-2: 认证/写入/诊断接口限流(单进程内存滑动窗口,与 _events_limiter 同款实现)。
#   _auth_limiter    20 次/min/IP  —— 所有 auth 端点(注册/验证/探测/OAuth callback)
#   _login_limiter    8 次/5min/IP+email —— 密码登录专用(防在线爆破;key 加 email 使
#                    分布式猜同一账号也被该账号维度卡住)
#   _diag_limiter    10 次/min/IP  —— /api/diagnostics(不鉴权但有 128KB 上限,需防刷库)
# 鉴权后的批注写操作按 user(而非 IP)限,避免公司出口 NAT 误伤。
_auth_limiter = ratelimit.WindowLimiter(20, 60)
_login_limiter = ratelimit.WindowLimiter(8, 300)
_diag_limiter = ratelimit.WindowLimiter(10, 60)
_ann_limiter = ratelimit.WindowLimiter(60, 60)


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _require_rate(limiter: ratelimit.WindowLimiter, key: str) -> None:
    # dev/test(HG_ENV 运行时判定)放宽,避免测试连打触发限流;生产按配额执行。
    if not is_dev_env() and not limiter.allow(key):
        raise HTTPException(status_code=429, detail="too many requests")


def _now_day() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).date().isoformat()


@app.post("/api/events")
def submit_events(request: Request, payload: dict):
    """接收匿名漏斗事件批次。非法事件名跳过(不整批拒,防毒丸卡客户端游标);
    未知参数键剥离;参数值做枚举/格式校验——隐私承诺(绝不带自由文本)在服务端闭环。"""
    if not _events_limiter.allow(request.client.host if request.client else "?"):
        raise HTTPException(status_code=429, detail="too many requests")
    raw = json.dumps(payload, ensure_ascii=False)
    if len(raw) > 32 * 1024:
        raise HTTPException(status_code=413, detail="events payload too large")
    client_id = str(payload.get("client_id") or "") if isinstance(payload, dict) else ""
    if len(client_id) < 8 or len(client_id) > 64:
        raise HTTPException(status_code=422, detail="client_id required")
    events = payload.get("events") if isinstance(payload.get("events"), list) else []
    if len(events) > 50:
        raise HTTPException(status_code=413, detail="too many events per request")
    accepted, rejected = [], []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        seq, name = ev.get("seq"), ev.get("name")
        if not isinstance(seq, int) or not isinstance(name, str) or name not in EVENT_SPECS:
            if isinstance(seq, int):
                rejected.append(seq)
            continue
        raw_params = ev.get("params") if isinstance(ev.get("params"), dict) else {}
        clean = {}
        for k, val in raw_params.items():
            k = str(k)[:64]
            validator = EVENT_SPECS[name].get(k)
            if validator is None:
                continue
            ok_val = validator(val)
            if ok_val is not None:
                clean[k] = ok_val if isinstance(ok_val, bool) else str(ok_val)[:128]
        accepted.append({"seq": seq, "name": name[:64], "params": clean,
                         "ts": str(ev.get("ts") or "")[:40]})
    inserted = storage.save_events(client_id, accepted)
    acked = max((e["seq"] for e in accepted), default=0)
    # 惰性清理:每日首次写入时清一次(无 cron 依赖)
    today = _now_day()
    if _last_prune_day["d"] != today:
        _last_prune_day["d"] = today
        storage.prune_analytics()
    return {"ok": True, "acked_seq": acked, "rejected": rejected, "inserted": inserted}


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


# P1-6: 批注文本字段的控制字符清洗(纵深防御)。渲染侧已 esc(),HTML 标签属正常文本
# 不动;只剥离 C0 控制符(\t\n\r 除外)与 DEL —— 防日志注入/终端转义/异常 Unicode 攻击面。
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _strip_ctrl(s):
    return _CTRL_RE.sub("", s) if isinstance(s, str) else s


def _sanitize_annotation(payload: AnnotationCreate) -> AnnotationCreate:
    payload.quote = _strip_ctrl(payload.quote)
    if payload.selector is not None:
        payload.selector.exact = _strip_ctrl(payload.selector.exact)
        payload.selector.prefix = _strip_ctrl(payload.selector.prefix)
        payload.selector.suffix = _strip_ctrl(payload.selector.suffix)
    if payload.body is not None:
        payload.body.comment = _strip_ctrl(payload.body.comment)
        payload.body.instruction = _strip_ctrl(payload.body.instruction)
    return payload


@app.post("/api/annotations")
async def create_annotation(
    payload: AnnotationCreate, session: Session = Depends(require_session)
):
    # author.id = 飞书 open_id(后端 session 注入,不可伪造);team_id = session.team_id
    _require_rate(_ann_limiter, session.open_id)
    _sanitize_annotation(payload)
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
    _require_rate(_ann_limiter, session.open_id)
    patch = payload.body.model_dump(exclude_unset=True)  # BE-5:只合并实际传入的字段
    for k in ("comment", "instruction"):  # P1-6:与 create 同款控制字符清洗
        if k in patch:
            patch[k] = _strip_ctrl(patch[k])
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
