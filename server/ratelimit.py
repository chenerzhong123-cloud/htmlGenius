"""极简内存滑动窗口限流(单进程,systemd 单服务部署下够用;重启清零可接受)。"""
from __future__ import annotations

import time
from typing import Callable


class WindowLimiter:
    def __init__(self, max_calls: int, per_seconds: float, now: Callable[[], float] | None = None):
        self.max_calls = max_calls
        self.per = per_seconds
        self._now = now or time.monotonic
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str) -> bool:
        t = self._now()
        arr = [x for x in self._hits.get(key, []) if x > t - self.per]
        if len(arr) >= self.max_calls:
            self._hits[key] = arr
            return False
        arr.append(t)
        self._hits[key] = arr
        return True
