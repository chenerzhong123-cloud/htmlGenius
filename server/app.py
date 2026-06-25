import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from . import storage
from .models import AnnotationCreate, DocumentCreate, VersionCreate

BASE = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("HTMLEDITOR_DB", BASE / "annotations.db"))

app = FastAPI(title="htmleditor stage0")
storage.init_db(DB_PATH)

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
        return storage.add_version(document_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="document not found")


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
