import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles

from . import storage
from .models import AnnotationCreate, DocumentCreate, VersionCreate

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
def create_annotation(payload: AnnotationCreate):
    return storage.save_annotation(payload)


@app.get("/api/annotations")
def list_annotations(document_id: str):
    return {"items": storage.list_annotations(document_id)}


@app.delete("/api/annotations/{aid}")
def delete_annotation(aid: str):
    deleted = storage.delete_annotation(aid)
    if not deleted:
        raise HTTPException(status_code=404, detail="annotation not found")
    return {"ok": True}
