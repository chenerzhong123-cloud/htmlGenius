"""协作在线状态(presence)+ 60s TTL GC (v0.4 plugin-collab, Task 6).

每个房间 ``(team_id, doc_id)`` 维护一个在线用户集合,每条记录是
``{user_id: {"user": {...}, "last_seen": ts}}``。

- ``join`` / ``heartbeat``: 写入/刷新该 user 的 last_seen 为当前时间。
- ``bye``: 移除该 user。
- 每次调用先 ``_gc`` 清理 last_seen 落后超过 ``_TTL`` 秒的 user(> TTL 才清,
  边界恰好等于 TTL 保留),然后向房间广播 ``presence`` 事件,payload 为当前
  在线用户列表。

team 维度天然隔离 —— ``rooms.broadcast`` 按 ``(team_id, doc_id)`` 投递,
不同 team 即使 doc_id 相同也不互通。
"""
import time
from collections import defaultdict

from .sse import rooms

_TTL = 60  # 秒

# (team_id, doc_id) -> { user_id: {"user": {...}, "last_seen": ts} }
_USERS: "dict[tuple[str, str], dict[str, dict]]" = defaultdict(dict)


def _gc(key: "tuple[str, str]") -> None:
    """清理 last_seen 落后超过 _TTL 秒的 user(now - last_seen > _TTL)。"""
    now = time.time()
    stale = [u for u, v in _USERS[key].items() if now - v["last_seen"] > _TTL]
    for uid in stale:
        _USERS[key].pop(uid, None)


async def update(team_id: str, doc: str, user: dict, op: str) -> None:
    """更新房间在线状态并广播 presence 事件。

    - op == "bye": 移除该 user;
    - 其他(join / heartbeat): 写入或刷新 last_seen。

    无论增删都广播一次,使客户端拿到最新的在线用户列表。
    """
    key = (team_id, doc)
    _gc(key)
    uid = user.get("id")
    if op == "bye":
        _USERS[key].pop(uid, None)
    else:  # join | heartbeat
        _USERS[key][uid] = {"user": user, "last_seen": time.time()}
    users = [v["user"] for v in _USERS[key].values()]
    await rooms.broadcast(team_id, doc, "presence", {"users": users})
