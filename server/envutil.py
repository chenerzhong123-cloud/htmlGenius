"""共享环境判定。

`app` 与 `auth` 都需要「是否非生产环境」判定,但 ``app`` import ``auth``,
反向 import 会循环。把判定集中在本无依赖模块,两侧共用。
"""
from __future__ import annotations

import os

# HG_ENV∈{dev,development,test,testing,local} 视为非生产;
# 未设或其它值(production/prod/staging/…)一律按生产处理 —— 安全默认。
_DEV_ENVS = {"dev", "development", "test", "testing", "local"}


def is_dev_env() -> bool:
    return os.environ.get("HG_ENV", "").strip().lower() in _DEV_ENVS
