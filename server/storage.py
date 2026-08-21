from __future__ import annotations

import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .models import AnnotationCreate, DocumentCreate, VersionCreate

_DB: str = ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    # isolation_level=None: autocommit;多语句原子操作自行 BEGIN/COMMIT(v0.2 高频写需事务)
    c = sqlite3.connect(_DB, isolation_level=None)
    c.row_factory = sqlite3.Row
    return c


def init_db(path: Path) -> None:
    global _DB
    _DB = str(path)
    c = _connect()
    try:
        c.execute("PRAGMA journal_mode=WAL")  # v0.2: 并发写不锁死
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                team_id TEXT NOT NULL,
                document_id TEXT NOT NULL,
                title TEXT,
                current_version INTEGER,
                PRIMARY KEY (team_id, document_id)
            );
            CREATE TABLE IF NOT EXISTS versions (
                team_id TEXT NOT NULL,
                document_id TEXT NOT NULL,
                version INTEGER,
                html_path TEXT,
                created_at TEXT,
                source TEXT,
                parent INTEGER,
                PRIMARY KEY (team_id, document_id, version)
            );
            CREATE TABLE IF NOT EXISTS annotations (
                id TEXT PRIMARY KEY,
                document_id TEXT,
                version INTEGER,
                created_at TEXT,
                updated_at TEXT,
                author TEXT,
                scope TEXT,
                status TEXT,
                selector TEXT,
                quote TEXT,
                body TEXT
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                open_id TEXT,
                name TEXT,
                team_id TEXT,
                created_at TEXT,
                expires_at TEXT
            );
            CREATE TABLE IF NOT EXISTS teams (
                team_id TEXT PRIMARY KEY,
                name TEXT,
                created_by TEXT,
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL DEFAULT 'google',
                subject TEXT,
                email TEXT,
                name TEXT,
                picture TEXT,
                password_hash TEXT,
                email_verified INTEGER NOT NULL DEFAULT 1,
                first_seen TEXT,
                last_seen TEXT
            );
            CREATE TABLE IF NOT EXISTS memberships (
                user_id TEXT,
                team_id TEXT,
                joined_at TEXT,
                role TEXT NOT NULL DEFAULT 'member',
                PRIMARY KEY (user_id, team_id)
            );
            CREATE TABLE IF NOT EXISTS invites (
                code TEXT PRIMARY KEY,
                team_id TEXT,
                created_by TEXT,
                created_at TEXT,
                max_uses INTEGER,
                used_count INTEGER DEFAULT 0,
                expires_at TEXT
            );
            CREATE TABLE IF NOT EXISTS email_verifications (
                email TEXT PRIMARY KEY,
                code_hash TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                name TEXT,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS diagnostics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                mode TEXT,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sse_stats (
                date TEXT PRIMARY KEY,
                connects INTEGER NOT NULL DEFAULT 0,
                disconnects INTEGER NOT NULL DEFAULT 0,
                peak_concurrent INTEGER NOT NULL DEFAULT 0,
                peak_per_team INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analytics_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                name TEXT NOT NULL,
                params_json TEXT NOT NULL,
                client_ts TEXT,
                created_at TEXT NOT NULL,
                UNIQUE(client_id, seq)
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                actor TEXT,
                team_id TEXT,
                action TEXT NOT NULL,
                detail TEXT
            );
            """
        )
        # v0.2 迁移:versions 加 html_content 列(若旧库缺)
        cols = {row["name"] for row in c.execute("PRAGMA table_info(versions)")}
        if "html_content" not in cols:
            c.execute("ALTER TABLE versions ADD COLUMN html_content TEXT")
        # v0.4 迁移:annotations 加 team_id/parent_id 列(若旧库缺)
        cols_ann = {row["name"] for row in c.execute("PRAGMA table_info(annotations)")}
        if "team_id" not in cols_ann:
            c.execute("ALTER TABLE annotations ADD COLUMN team_id TEXT DEFAULT 'default'")
        if "parent_id" not in cols_ann:
            c.execute("ALTER TABLE annotations ADD COLUMN parent_id TEXT")
        # v0.9.x 迁移 (R-1):documents/versions 加 team_id、PK 改团队级复合键;memberships 加 role。
        # 仅当旧表存在(列集非空)且缺目标列时迁移,幂等;部分遗留库(只含部分表)也能安全跳过。
        cols_doc = {row["name"] for row in c.execute("PRAGMA table_info(documents)")}
        if cols_doc and "team_id" not in cols_doc:
            c.executescript(
                """
                ALTER TABLE documents RENAME TO _documents_old;
                CREATE TABLE documents (
                    team_id TEXT NOT NULL, document_id TEXT NOT NULL, title TEXT, current_version INTEGER,
                    PRIMARY KEY (team_id, document_id)
                );
                INSERT INTO documents(team_id, document_id, title, current_version)
                    SELECT 'default', document_id, title, current_version FROM _documents_old;
                DROP TABLE _documents_old;
                """
            )
        cols_ver = {row["name"] for row in c.execute("PRAGMA table_info(versions)")}
        if cols_ver and "team_id" not in cols_ver:
            c.executescript(
                """
                ALTER TABLE versions RENAME TO _versions_old;
                CREATE TABLE versions (
                    team_id TEXT NOT NULL, document_id TEXT NOT NULL, version INTEGER,
                    html_path TEXT, created_at TEXT, source TEXT, parent INTEGER, html_content TEXT,
                    PRIMARY KEY (team_id, document_id, version)
                );
                INSERT INTO versions(team_id, document_id, version, html_path, created_at, source, parent, html_content)
                    SELECT 'default', document_id, version, html_path, created_at, source, parent, html_content FROM _versions_old;
                DROP TABLE _versions_old;
                """
            )
        cols_mem = {row["name"] for row in c.execute("PRAGMA table_info(memberships)")}
        if cols_mem and "role" not in cols_mem:
            c.execute("ALTER TABLE memberships ADD COLUMN role TEXT NOT NULL DEFAULT 'member'")
            c.execute(
                "UPDATE memberships SET role='owner' WHERE (google_sub, team_id) IN "
                "(SELECT created_by_sub, team_id FROM teams WHERE created_by_sub IS NOT NULL)"
            )
        # 邮箱登录迁移:身份模型统一 google_sub->user_id、created_by_sub->created_by;
        # users 加 provider/subject/password_hash/email_verified。对老 Google 数据 user_id==google_sub,
        # 故纯改名+加列,零数据改写,幂等。sessions.open_id 列名保留(值即 user_id)。
        # 必须排在上面 v0.9.x membership 迁移之后(那条仍用 google_sub/created_by_sub 列名)。
        cu = {row["name"] for row in c.execute("PRAGMA table_info(users)")}
        if cu and "google_sub" in cu and "user_id" not in cu:
            c.execute("ALTER TABLE users RENAME COLUMN google_sub TO user_id")
            c.execute("ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'")
            c.execute("ALTER TABLE users ADD COLUMN subject TEXT")
            c.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
            c.execute("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1")
            c.execute("UPDATE users SET subject=user_id WHERE subject IS NULL")
        cm2 = {row["name"] for row in c.execute("PRAGMA table_info(memberships)")}
        if cm2 and "google_sub" in cm2 and "user_id" not in cm2:
            c.execute("ALTER TABLE memberships RENAME COLUMN google_sub TO user_id")
        ct2 = {row["name"] for row in c.execute("PRAGMA table_info(teams)")}
        if ct2 and "created_by_sub" in ct2 and "created_by" not in ct2:
            c.execute("ALTER TABLE teams RENAME COLUMN created_by_sub TO created_by")
        ci2 = {row["name"] for row in c.execute("PRAGMA table_info(invites)")}
        if ci2 and "created_by_sub" in ci2 and "created_by" not in ci2:
            c.execute("ALTER TABLE invites RENAME COLUMN created_by_sub TO created_by")
        # 用户可自行设置显示名称。保留来源名称用于首次登录/未自定义用户的资料刷新；
        # 一旦用户主动修改，后续 OAuth 登录不得覆盖它。
        cu2 = {row["name"] for row in c.execute("PRAGMA table_info(users)")}
        if cu2 and "name_custom" not in cu2:
            c.execute("ALTER TABLE users ADD COLUMN name_custom INTEGER NOT NULL DEFAULT 0")
    finally:
        c.close()


def register_document(team_id: str, payload: DocumentCreate) -> dict | None:
    c = _connect()
    try:
        c.execute(
            "INSERT OR IGNORE INTO documents(team_id, document_id, title, current_version) VALUES(?,?,?,0)",
            (team_id, payload.document_id, payload.title),
        )
    finally:
        c.close()
    return get_document(team_id, payload.document_id)


def add_version(team_id: str, document_id: str, payload: VersionCreate) -> dict:
    """单事务:读 current + 写 versions(含 html_content)+ 更新 documents。

    按 (team_id, document_id) 限定:文档不在本团队 → KeyError(端点层映射 404)。
    """
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            row = c.execute(
                "SELECT current_version FROM documents WHERE team_id=? AND document_id=?",
                (team_id, document_id),
            ).fetchone()
            if row is None:
                raise KeyError(f"document not found: {team_id}/{document_id}")
            v = (row["current_version"] or 0) + 1
            c.execute(
                "INSERT INTO versions (team_id, document_id, version, html_path, created_at, source, parent, html_content) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (team_id, document_id, v, payload.html_path, _now(), payload.source, payload.parent, payload.html_content),
            )
            c.execute(
                "UPDATE documents SET current_version=? WHERE team_id=? AND document_id=?",
                (v, team_id, document_id),
            )
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()
    return {"document_id": document_id, "version": v}


def list_versions(team_id: str, document_id: str) -> list[dict]:
    c = _connect()
    try:
        rows = c.execute(
            "SELECT team_id, document_id, version, html_path, created_at, source, parent "
            "FROM versions WHERE team_id=? AND document_id=? ORDER BY version",
            (team_id, document_id),
        ).fetchall()
    finally:
        c.close()
    return [dict(r) for r in rows]


def get_version_html(team_id: str, document_id: str, version: int) -> str | None:
    c = _connect()
    try:
        r = c.execute(
            "SELECT html_content FROM versions WHERE team_id=? AND document_id=? AND version=?",
            (team_id, document_id, version),
        ).fetchone()
    finally:
        c.close()
    return r["html_content"] if r else None


def _current_version(c: sqlite3.Connection, team_id: str, document_id: str) -> int | None:
    row = c.execute(
        "SELECT current_version FROM documents WHERE team_id=? AND document_id=?", (team_id, document_id)
    ).fetchone()
    return row["current_version"] if row else None


def enforce_window(team_id: str, document_id: str, keep: int = 20) -> list[int]:
    """保留最近 keep 个版本,删更早的;删前把挂在被删版本上的批注 version 更新到 current。

    按 (team_id, document_id) 限定:批注迁移也带 team_id,不波及其它团队同名 doc 的批注。
    """
    c = _connect()
    deleted: list[int] = []
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            current = _current_version(c, team_id, document_id)
            if current is None:
                c.execute("ROLLBACK")
                return []
            rows = c.execute(
                "SELECT version FROM versions WHERE team_id=? AND document_id=? ORDER BY version DESC",
                (team_id, document_id),
            ).fetchall()
            for r in rows[keep:]:
                v = r["version"]
                if current is not None:
                    c.execute(
                        "UPDATE annotations SET version=? WHERE team_id=? AND document_id=? AND version=?",
                        (current, team_id, document_id, v),
                    )
                c.execute(
                    "DELETE FROM versions WHERE team_id=? AND document_id=? AND version=?",
                    (team_id, document_id, v),
                )
                deleted.append(v)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()
    return deleted


def delete_version(team_id: str, document_id: str, version: int) -> bool:
    """删某版本;批注引用该版本则更新到 current。不允许删 current。

    按 (team_id, document_id) 限定:跨团队同名 doc 不受影响。
    """
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            current = _current_version(c, team_id, document_id)
            if current == version:
                raise ValueError("cannot delete current version")
            if current is not None:
                c.execute(
                    "UPDATE annotations SET version=? WHERE team_id=? AND document_id=? AND version=?",
                    (current, team_id, document_id, version),
                )
            cur = c.execute(
                "DELETE FROM versions WHERE team_id=? AND document_id=? AND version=?",
                (team_id, document_id, version),
            )
            c.execute("COMMIT")
            return cur.rowcount > 0
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()


def save_annotation(payload: AnnotationCreate, team_id: str = "default") -> dict:
    aid = "ann_" + secrets.token_hex(8)
    now = _now()
    selector = payload.selector.model_dump()
    body = payload.body.model_dump()
    author = payload.author or {"id": "u_self", "name": "作者"}
    c = _connect()
    try:
        c.execute(
            """INSERT INTO annotations
               (id, document_id, version, created_at, updated_at, author, scope, status, selector, quote, body, team_id, parent_id)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                aid, payload.document_id, payload.version, now, now,
                json.dumps(author, ensure_ascii=False),
                "group", "open",
                json.dumps(selector, ensure_ascii=False),
                payload.quote,
                json.dumps(body, ensure_ascii=False),
                team_id, payload.parent_id,
            ),
        )
    finally:
        c.close()
    return get_annotation(aid)  # type: ignore[return-value]


def get_annotation(aid: str) -> dict | None:
    c = _connect()
    try:
        r = c.execute("SELECT * FROM annotations WHERE id=?", (aid,)).fetchone()
    finally:
        c.close()
    return _row_to_ann(r) if r else None


def delete_annotation(aid: str, team_id: str, actor_id: str) -> list[dict]:
    """作者校验 + 级联删子树。

    - 行不存在 → 返回 ``[]``。
    - ``row["team_id"] != team_id`` (跨团队) 或 ``author.id != actor_id`` (非作者) → ``PermissionError``。
    - 通过: BFS by ``parent_id`` 收集整棵子树,单事务 (BEGIN IMMEDIATE/COMMIT, 异常 ROLLBACK) 删除,
      返回 ``[{"id": ..., "document_id": ...}, ...]``。
    """
    c = _connect()
    try:
        row = c.execute(
            "SELECT team_id, author, document_id FROM annotations WHERE id=?", (aid,)
        ).fetchone()
        if row is None:
            return []
        if row["team_id"] != team_id:
            raise PermissionError("wrong team")
        if json.loads(row["author"]).get("id") != actor_id:
            raise PermissionError("not owner")
        doc_id = row["document_id"]
        # BFS 收集子树(by parent_id)
        to_delete: list[str] = [aid]
        queue: list[str] = [aid]
        while queue:
            cur = queue.pop()
            children = [
                r["id"]
                for r in c.execute(
                    "SELECT id FROM annotations WHERE parent_id=?", (cur,)
                ).fetchall()
            ]
            to_delete.extend(children)
            queue.extend(children)
        c.execute("BEGIN IMMEDIATE")
        try:
            for did in to_delete:
                c.execute("DELETE FROM annotations WHERE id=?", (did,))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        return [{"id": did, "document_id": doc_id} for did in to_delete]
    finally:
        c.close()


def update_annotation(aid: str, team_id: str, actor_id: str, body_patch: dict) -> dict | None:
    """作者校验 + 合并 body 更新(保留 id / selector / parent_id / author)。

    - 行不存在 → 返回 ``None``。
    - ``team_id`` 不符(跨团队)或 ``author.id != actor_id``(非作者) → ``PermissionError``。
    - 通过: 现有 body dict 合并 body_patch,写回 body + 更新 updated_at,返回最新行。
    """
    c = _connect()
    try:
        row = c.execute(
            "SELECT team_id, author, body FROM annotations WHERE id=?", (aid,)
        ).fetchone()
        if row is None:
            return None
        if row["team_id"] != team_id:
            raise PermissionError("wrong team")
        if json.loads(row["author"]).get("id") != actor_id:
            raise PermissionError("not owner")
        merged = {**json.loads(row["body"]), **(body_patch or {})}
        c.execute(
            "UPDATE annotations SET body=?, updated_at=? WHERE id=?",
            (json.dumps(merged, ensure_ascii=False), _now(), aid),
        )
    finally:
        c.close()
    return get_annotation(aid)  # type: ignore[return-value]


def list_annotations(document_id: str, team_id: str = "default") -> list[dict]:
    c = _connect()
    try:
        rows = c.execute(
            "SELECT * FROM annotations WHERE document_id=? AND team_id=? ORDER BY created_at",
            (document_id, team_id),
        ).fetchall()
    finally:
        c.close()
    return [_row_to_ann(r) for r in rows]


def get_document(team_id: str, document_id: str) -> dict | None:
    c = _connect()
    try:
        d = c.execute(
            "SELECT * FROM documents WHERE team_id=? AND document_id=?", (team_id, document_id)
        ).fetchone()
        if d is None:
            return None
        vs = c.execute(
            "SELECT team_id, document_id, version, html_path, created_at, source, parent "
            "FROM versions WHERE team_id=? AND document_id=? ORDER BY version",
            (team_id, document_id),
        ).fetchall()
    finally:
        c.close()
    return {
        "document_id": d["document_id"],
        "title": d["title"],
        "current_version": d["current_version"],
        "versions": [dict(v) for v in vs],
    }


def _row_to_ann(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "document_id": r["document_id"],
        "version": r["version"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
        "author": json.loads(r["author"]),
        "scope": r["scope"],
        "status": r["status"],
        "selector": json.loads(r["selector"]),
        "quote": r["quote"],
        "body": json.loads(r["body"]),
        "team_id": r["team_id"],
        "parent_id": r["parent_id"],
    }


# === 诊断上报(A+B:用户一键报告 / opt-in 自动上报)===
def insert_audit_log(actor: str, team_id: str, action: str, detail: str = "") -> None:
    """P2-10: 安全审计日志 —— 登录成功与团队治理动作(加人/转让/移除/解散)落库,
    出事后可溯源。只增不删,不做查询端点(运维直接读 SQLite)。写失败不抛(不因审计拖垮业务)。"""
    try:
        c = _connect()
        try:
            c.execute(
                "INSERT INTO audit_log(created_at, actor, team_id, action, detail) VALUES (?,?,?,?,?)",
                (_now(), str(actor or "")[:200], str(team_id or "")[:200],
                 str(action)[:64], str(detail)[:500]),
            )
        finally:
            c.close()
    except Exception as e:
        print(f"[audit] write failed: {e!r}", flush=True)


def save_diagnostics(payload_json: str, mode: str = "manual") -> int:
    """存一条诊断包(原始 JSON 字符串)。大小由端点封顶,此处只落库。返回 id。"""
    c = _connect()
    try:
        cur = c.execute(
            "INSERT INTO diagnostics(created_at, mode, payload) VALUES (?,?,?)",
            (_now(), str(mode)[:16], payload_json),
        )
        return int(cur.lastrowid)
    finally:
        c.close()


def save_events(client_id: str, events: list) -> int:
    """漏斗事件落库。UNIQUE(client_id, seq) + INSERT OR IGNORE:超时重发幂等。"""
    c = _connect()
    try:
        n = 0
        for e in events:
            cur = c.execute(
                "INSERT OR IGNORE INTO analytics_events(client_id, seq, name, params_json, client_ts, created_at) "
                "VALUES(?,?,?,?,?,?)",
                (client_id[:64], int(e["seq"]), str(e["name"])[:64],
                 json.dumps(e.get("params") or {}, ensure_ascii=False),
                 str(e.get("ts") or "")[:40], _now()),
            )
            n += cur.rowcount
        c.commit()
        return n
    finally:
        c.close()


def prune_analytics(keep_days: int = 90) -> int:
    """删除事件时间早于 keep_days 天的行(表大小保护)。
    事件时间取 client_ts(客户端时钟,断网补发不污染时段),缺失回落 created_at。"""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=keep_days)).isoformat()
    c = _connect()
    try:
        cur = c.execute(
            "DELETE FROM analytics_events WHERE COALESCE(NULLIF(client_ts, ''), created_at) < ?",
            (cutoff,),
        )
        c.commit()
        return cur.rowcount
    finally:
        c.close()


def list_diagnostics(limit: int = 50) -> list[dict]:
    """最近诊断记录(管理/排障查;只回 id/时间/mode,不含 payload 正文防误泄)。"""
    c = _connect()
    try:
        rows = c.execute(
            "SELECT id, created_at, mode FROM diagnostics ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    finally:
        c.close()
    return [{"id": r["id"], "created_at": r["created_at"], "mode": r["mode"]} for r in rows]


def get_diagnostics(diag_id: int) -> "dict | None":
    """取单条诊断正文(含 payload)。仅管理查。"""
    c = _connect()
    try:
        r = c.execute("SELECT id, created_at, mode, payload FROM diagnostics WHERE id=?", (int(diag_id),)).fetchone()
    finally:
        c.close()
    if not r:
        return None
    return {"id": r["id"], "created_at": r["created_at"], "mode": r["mode"], "payload": r["payload"]}


def upsert_sse_stats(date: str, connects: int, disconnects: int, peak_concurrent: int, peak_per_team: int) -> None:
    """SSE 用量日汇总(容量评估用)。内存累计绝对值整行覆盖,幂等;每天最多 ~288 次写(5min 粒度)。"""
    c = _connect()
    try:
        c.execute(
            "INSERT INTO sse_stats(date, connects, disconnects, peak_concurrent, peak_per_team, updated_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET "
            "connects=excluded.connects, disconnects=excluded.disconnects, "
            "peak_concurrent=MAX(sse_stats.peak_concurrent, excluded.peak_concurrent), "
            "peak_per_team=MAX(sse_stats.peak_per_team, excluded.peak_per_team), "
            "updated_at=excluded.updated_at",
            (date, connects, disconnects, peak_concurrent, peak_per_team, _now()),
        )
    finally:
        c.close()


def list_sse_stats(limit: int = 30) -> list[dict]:
    """最近 N 天的 SSE 用量(扩容决策数据源)。"""
    c = _connect()
    try:
        rows = c.execute(
            "SELECT * FROM sse_stats ORDER BY date DESC LIMIT ?", (int(limit),)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        c.close()
