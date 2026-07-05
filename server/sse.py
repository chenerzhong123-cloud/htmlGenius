"""SSE 房间管理器 + 单例 (v0.4 plugin-collab, Task 4).

每个 (team_id, doc_id) 是一个房间;每个房间维护一组 ``asyncio.Queue``。
广播把 ``{"event": str, "data": dict}`` 投递给该房间所有队列。
team 维度天然隔离 —— 不同 team 即使 doc_id 相同也不互通。

Task 5 会用 ``await rooms.broadcast(...)`` 在写后推送;Task 6 presence 复用此单例。
"""
import asyncio
from collections import defaultdict


class RoomManager:
    def __init__(self) -> None:
        self._queues: dict[tuple[str, str], set[asyncio.Queue]] = defaultdict(set)

    async def subscribe(self, team_id: str, doc_id: str) -> asyncio.Queue:
        """加入房间,返回该订阅专属的队列。"""
        q: asyncio.Queue = asyncio.Queue()
        self._queues[(team_id, doc_id)].add(q)
        return q

    def unsubscribe(self, team_id: str, doc_id: str, q: asyncio.Queue) -> None:
        """离开房间。discard 保证幂等(连接断开重复清理也安全)。"""
        key = (team_id, doc_id)
        # 注意:不能用 self._queues[key](defaultdict 会重新创建空 set),
        # 必须用 in 判存在;discard 后若 set 已空就删 key,防 _queues 无界增长。
        if key in self._queues:
            self._queues[key].discard(q)
            if not self._queues[key]:
                del self._queues[key]

    async def broadcast(self, team_id: str, doc_id: str, event: str, data: dict) -> None:
        """向房间内所有订阅者投递一条消息。list() 快照防迭代中变更。"""
        for q in list(self._queues.get((team_id, doc_id), ())):
            await q.put({"event": event, "data": data})


rooms = RoomManager()
