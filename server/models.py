from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

# BE-5: 字符串字段加 max_length 上限,防巨幅 payload 撑爆 DB / 内存 / 解析。
# 取值按现有用法定留足正常余量;标识符收紧、内容字段放宽。仅在 FastAPI 从
# 客户端 JSON 构造请求模型时生效(响应模型不被本仓代码构造,纯文档/类型用)。
_LEN_ID = 200  # document_id / annotation id / team_id 等标识符
_LEN_TITLE = 500  # 文档标题
_LEN_SOURCE = 64  # 版本来源短标签(ai-gen / edit …)
_LEN_PATH = 1024  # 文件路径
_LEN_QUOTE = 5000  # 划词原文 / TextQuoteSelector 的 exact / prefix / suffix
_LEN_COMMENT = 4000  # 批注评论
_LEN_INSTRUCTION = 8000  # AI 改写指令
_LEN_HTML = 5_000_000  # 整页 HTML(版本快照,留 5MB 上限)


class TextQuoteSelector(BaseModel):
    type: Literal["TextQuoteSelector"] = "TextQuoteSelector"
    exact: str = Field(max_length=_LEN_QUOTE)
    prefix: str = Field("", max_length=_LEN_QUOTE)
    suffix: str = Field("", max_length=_LEN_QUOTE)


class AnnotationBody(BaseModel):
    comment: str = Field("", max_length=_LEN_COMMENT)
    action: Literal["rewrite", "delete", "question", "none"] = "rewrite"
    instruction: str = Field("", max_length=_LEN_INSTRUCTION)


class AnnotationBodyPatch(BaseModel):
    """PATCH 部分更新用:字段全 Optional,仅校验出现的字段。

    配合 ``model_dump(exclude_unset=True)`` 取出客户端实际传入的字段,再与
    现有 body 合并 —— 避免把未传字段当默认值覆盖原值(保留部分更新语义)。
    各字段复用 AnnotationBody 的 max_length 约束,先校验再合并。
    """

    comment: Optional[str] = Field(None, max_length=_LEN_COMMENT)
    action: Optional[Literal["rewrite", "delete", "question", "none"]] = None
    instruction: Optional[str] = Field(None, max_length=_LEN_INSTRUCTION)


class AnnotationCreate(BaseModel):
    document_id: str = Field(max_length=_LEN_ID)
    version: int = 1
    selector: TextQuoteSelector
    quote: str = Field(max_length=_LEN_QUOTE)
    body: AnnotationBody = Field(default_factory=AnnotationBody)
    author: dict = Field(default_factory=lambda: {"id": "u_self", "name": "作者"})
    parent_id: Optional[str] = Field(None, max_length=_LEN_ID)


class Annotation(BaseModel):
    id: str = Field(max_length=_LEN_ID)
    document_id: str = Field(max_length=_LEN_ID)
    version: int
    created_at: datetime
    updated_at: datetime
    author: dict[str, str] = Field(default_factory=lambda: {"id": "u_self", "name": "作者"})
    scope: Literal["private", "group", "public"] = "group"
    status: Literal["open", "resolved", "stale"] = "open"
    selector: TextQuoteSelector
    quote: str = Field(max_length=_LEN_QUOTE)
    body: AnnotationBody
    team_id: str = Field("default", max_length=_LEN_ID)
    parent_id: Optional[str] = Field(None, max_length=_LEN_ID)


class VersionCreate(BaseModel):
    html_path: str = Field("", max_length=_LEN_PATH)
    html_content: str = Field("", max_length=_LEN_HTML)
    source: str = Field("ai-gen", max_length=_LEN_SOURCE)
    parent: Optional[int] = None


class DocumentCreate(BaseModel):
    document_id: str = Field(max_length=_LEN_ID)
    title: str = Field("", max_length=_LEN_TITLE)
