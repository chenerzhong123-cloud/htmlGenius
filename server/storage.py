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
    c = sqlite3.connect(_DB)
    c.row_factory = sqlite3.Row
    return c


def init_db(path: Path) -> None:
    global _DB
    _DB = str(path)
    c = _connect()
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
    c.commit()
    c.close()


def register_document(payload: DocumentCreate) -> dict | None:
    c = _connect()
    try:
        c.execute(
            "INSERT OR IGNORE INTO documents(document_id, title, current_version) VALUES(?,?,0)",
            (payload.document_id, payload.title),
        )
        c.commit()
    finally:
        c.close()
    return get_document(payload.document_id)


def add_version(document_id: str, payload: VersionCreate) -> dict:
    c = _connect()
    try:
        row = c.execute(
            "SELECT current_version FROM documents WHERE document_id=?", (document_id,)
        ).fetchone()
        if row is None:
            raise KeyError(f"document not found: {document_id}")
        v = (row["current_version"] or 0) + 1
        c.execute(
            "INSERT INTO versions VALUES(?,?,?,?,?,?)",
            (document_id, v, payload.html_path, _now(), payload.source, payload.parent),
        )
        c.execute(
            "UPDATE documents SET current_version=? WHERE document_id=?",
            (v, document_id),
        )
        c.commit()
    finally:
        c.close()
    return {"document_id": document_id, "version": v}


def save_annotation(payload: AnnotationCreate) -> dict:
    aid = "ann_" + secrets.token_hex(8)
    now = _now()
    selector = payload.selector.model_dump()
    body = payload.body.model_dump()
    c = _connect()
    try:
        c.execute(
            """INSERT INTO annotations
               (id, document_id, version, created_at, updated_at, author, scope, status, selector, quote, body)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (
                aid, payload.document_id, payload.version, now, now,
                json.dumps({"id": "u_self", "name": "作者"}, ensure_ascii=False),
                "private", "open",
                json.dumps(selector, ensure_ascii=False),
                payload.quote,
                json.dumps(body, ensure_ascii=False),
            ),
        )
        c.commit()
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
        c.commit()
        deleted = cur.rowcount > 0
    finally:
        c.close()
    return deleted


def list_annotations(document_id: str) -> list[dict]:
    c = _connect()
    try:
        rows = c.execute(
            "SELECT * FROM annotations WHERE document_id=? ORDER BY created_at",
            (document_id,),
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
            "SELECT * FROM versions WHERE document_id=? ORDER BY version",
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
    }
