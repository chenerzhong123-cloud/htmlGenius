from __future__ import annotations

import json
import secrets
import sqlite3
from datetime import datetime, timezone
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
                document_id TEXT PRIMARY KEY,
                title TEXT,
                current_version INTEGER
            );
            CREATE TABLE IF NOT EXISTS versions (
                document_id TEXT,
                version INTEGER,
                html_path TEXT,
                created_at TEXT,
                source TEXT,
                parent INTEGER,
                PRIMARY KEY (document_id, version)
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
    finally:
        c.close()


def register_document(payload: DocumentCreate) -> dict | None:
    c = _connect()
    try:
        c.execute(
            "INSERT OR IGNORE INTO documents(document_id, title, current_version) VALUES(?,?,0)",
            (payload.document_id, payload.title),
        )
    finally:
        c.close()
    return get_document(payload.document_id)


def add_version(document_id: str, payload: VersionCreate) -> dict:
    """单事务:读 current + 写 versions(含 html_content)+ 更新 documents。"""
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            row = c.execute(
                "SELECT current_version FROM documents WHERE document_id=?", (document_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"document not found: {document_id}")
            v = (row["current_version"] or 0) + 1
            c.execute(
                "INSERT INTO versions (document_id, version, html_path, created_at, source, parent, html_content) "
                "VALUES(?,?,?,?,?,?,?)",
                (document_id, v, payload.html_path, _now(), payload.source, payload.parent, payload.html_content),
            )
            c.execute(
                "UPDATE documents SET current_version=? WHERE document_id=?",
                (v, document_id),
            )
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()
    return {"document_id": document_id, "version": v}


def list_versions(document_id: str) -> list[dict]:
    c = _connect()
    try:
        rows = c.execute(
            "SELECT document_id, version, html_path, created_at, source, parent "
            "FROM versions WHERE document_id=? ORDER BY version",
            (document_id,),
        ).fetchall()
    finally:
        c.close()
    return [dict(r) for r in rows]


def get_version_html(document_id: str, version: int) -> str | None:
    c = _connect()
    try:
        r = c.execute(
            "SELECT html_content FROM versions WHERE document_id=? AND version=?",
            (document_id, version),
        ).fetchone()
    finally:
        c.close()
    return r["html_content"] if r else None


def _current_version(c: sqlite3.Connection, document_id: str) -> int | None:
    row = c.execute(
        "SELECT current_version FROM documents WHERE document_id=?", (document_id,)
    ).fetchone()
    return row["current_version"] if row else None


def enforce_window(document_id: str, keep: int = 20) -> list[int]:
    """保留最近 keep 个版本,删更早的;删前把挂在被删版本上的批注 version 更新到 current。"""
    c = _connect()
    deleted: list[int] = []
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            current = _current_version(c, document_id)
            if current is None:
                c.execute("ROLLBACK")
                return []
            rows = c.execute(
                "SELECT version FROM versions WHERE document_id=? ORDER BY version DESC",
                (document_id,),
            ).fetchall()
            for r in rows[keep:]:
                v = r["version"]
                if current is not None:
                    c.execute(
                        "UPDATE annotations SET version=? WHERE document_id=? AND version=?",
                        (current, document_id, v),
                    )
                c.execute(
                    "DELETE FROM versions WHERE document_id=? AND version=?",
                    (document_id, v),
                )
                deleted.append(v)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    finally:
        c.close()
    return deleted


def delete_version(document_id: str, version: int) -> bool:
    """删某版本;批注引用该版本则更新到 current。不允许删 current。"""
    c = _connect()
    try:
        c.execute("BEGIN IMMEDIATE")
        try:
            current = _current_version(c, document_id)
            if current == version:
                raise ValueError("cannot delete current version")
            if current is not None:
                c.execute(
                    "UPDATE annotations SET version=? WHERE document_id=? AND version=?",
                    (current, document_id, version),
                )
            cur = c.execute(
                "DELETE FROM versions WHERE document_id=? AND version=?",
                (document_id, version),
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


def delete_annotation(aid: str) -> bool:
    c = _connect()
    try:
        cur = c.execute("DELETE FROM annotations WHERE id=?", (aid,))
        deleted = cur.rowcount > 0
    finally:
        c.close()
    return deleted


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


def get_document(document_id: str) -> dict | None:
    c = _connect()
    try:
        d = c.execute(
            "SELECT * FROM documents WHERE document_id=?", (document_id,)
        ).fetchone()
        if d is None:
            return None
        vs = c.execute(
            "SELECT document_id, version, html_path, created_at, source, parent "
            "FROM versions WHERE document_id=? ORDER BY version",
            (document_id,),
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
