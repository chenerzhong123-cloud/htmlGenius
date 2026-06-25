from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class TextQuoteSelector(BaseModel):
    type: Literal["TextQuoteSelector"] = "TextQuoteSelector"
    exact: str
    prefix: str = ""
    suffix: str = ""


class AnnotationBody(BaseModel):
    comment: str = ""
    action: Literal["rewrite", "delete", "question", "none"] = "rewrite"
    instruction: str = ""


class AnnotationCreate(BaseModel):
    document_id: str
    version: int = 1
    selector: TextQuoteSelector
    quote: str
    body: AnnotationBody = Field(default_factory=AnnotationBody)


class Annotation(BaseModel):
    id: str
    document_id: str
    version: int
    created_at: datetime
    updated_at: datetime
    author: dict[str, str] = Field(default_factory=lambda: {"id": "u_self", "name": "作者"})
    scope: Literal["private", "group", "public"] = "private"
    status: Literal["open", "resolved", "stale"] = "open"
    selector: TextQuoteSelector
    quote: str
    body: AnnotationBody


class VersionCreate(BaseModel):
    html_path: str
    source: str = "ai-gen"
    parent: Optional[int] = None


class DocumentCreate(BaseModel):
    document_id: str
    title: str = ""
