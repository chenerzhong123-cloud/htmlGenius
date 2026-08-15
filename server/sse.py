"""SSE 房间管理器 + 单例 (v0.4 plugin-collab, Task 4).

每个 (team_id, doc_id) 是一个房间;每个房间维护一组 ``asyncio.Queue``。
广播把 ``{"event": str, "data": dict}`` 投递给该房间所有队列。
team 维度天然隔离 —— 不同 team 即使 doc_id 相同也不互通。

Task 5 会用 ``await rooms.broadcast(...)`` 在写后推送;Task 6 presence 复用此单例。

BE-4: 原实现每个 ``GET /api/stream`` 建一个无界 ``asyncio.Queue`` 且无任何并发
上限 —— 单个调用方即可开海量长连接耗尽 fd/内存。现加两道闸:
  - 单 team 并发订阅上限(默认 10,``HG_SSE_MAX_PER_TEAM``),超额 ``TooManyConnections``;
  - 全局绝对连接上限(默认 500,``HG_SSE_MAX_TOTAL``),超额同样拒绝。
/team_id 维度的限流因 SSE 端点身份只来自票据绑定的 team_id(open_id 不在该层可见)。
计数随 subscribe +1、unsubscribe -1,unsubscribe 使 team 计数归零即清键,防无界增长。
"""
import asyncio
import os
from collections import defaultdict


_MAX_TOTAL = int(os.environ.get("HG_SSE_MAX_TOTAL", "500"))
_MAX_PER_TEAM = int(os.environ.get("HG_SSE_MAX_PER_TEAM", "10"))


class TooManyConnections(Exception):
    """SSE 并发订阅超限(单 team 或全局)。端点层捕获后返 429。"""


def _today() -> str:
    """本地日期(YYYY-MM-DD)。SSE 统计按天分桶,供容量评估。"""
    import datetime as _dt

    return _dt.date.today().isoformat()


class RoomManager:
    def __init__(self) -> None:
        self._queues: dict[tuple[str, str], set[asyncio.Queue]] = defaultdict(set)
        # BE-4: 连接计数。_total 全局;_per_team 按 team_id。sum(_per_team) == _total。
        self._total = 0
        self._per_team: dict[str, int] = defaultdict(int)
        # 容量观测(2026-08-15):内存 O(1) 计数器,按天分桶,app 层定期落盘到 sse_stats 单表。
        # 连接事件计数是累计值(重启丢当日未落盘增量);峰值是当天观测到的最大并发。
        self._stats = {"date": _today(), "connects": 0, "disconnects": 0,
                       "peak_concurrent": 0, "peak_per_team": 0}

    @property
    def total(self) -> int:
        """当前全局 SSE 连接数。"""
        return self._total

    def count(self, team_id: str) -> int:
        """某 team 当前的 SSE 连接数。"""
        return self._per_team.get(team_id, 0)

    async def subscribe(self, team_id: str, doc_id: str) -> asyncio.Queue:
        """加入房间,返回该订阅专属的队列。

        超额(单 team > _MAX_PER_TEAM 或全局 > _MAX_TOTAL)抛 ``TooManyConnections``。
        检查与计数自增之间无 await,单事件循环内不会被打断,无 TOCTOU 竞态。
        """
        if self._total >= _MAX_TOTAL:
            raise TooManyConnections("stream capacity reached")
        if self._per_team[team_id] >= _MAX_PER_TEAM:
            raise TooManyConnections("too many streams for this team")
        q: asyncio.Queue = asyncio.Queue()
        self._queues[(team_id, doc_id)].add(q)
        self._total += 1
        self._per_team[team_id] += 1
        self._bump_stats()
        self._stats["connects"] += 1
        return q

    def unsubscribe(self, team_id: str, doc_id: str, q: asyncio.Queue) -> None:
        """离开房间。discard 保证幂等(连接断开重复清理也安全)。"""
        key = (team_id, doc_id)
        # 注意:不能用 self._queues[key](defaultdict 会重新创建空 set),
        # 必须用 in 判存在;discard 后若 set 已空就删 key,防 _queues 无界增长。
        removed = False
        if key in self._queues:
            before = len(self._queues[key])
            self._queues[key].discard(q)
            removed = before > len(self._queues[key])
            if not self._queues[key]:
                del self._queues[key]
        # BE-4: 计数随退订递减,归零即清键(防 _per_team 无界增长)。
        if removed:
            self._total = max(0, self._total - 1)
            if self._per_team.get(team_id, 0) > 1:
                self._per_team[team_id] -= 1
            else:
                self._per_team.pop(team_id, None)
            self._bump_stats()
            self._stats["disconnects"] += 1

    def _bump_stats(self) -> None:
        """跨天滚动新桶;并维护当天并发/单团队峰值(扩容决策的核心指标)。"""
        today = _today()
        if self._stats["date"] != today:
            self._stats = {"date": today, "connects": 0, "disconnects": 0,
                           "peak_concurrent": 0, "peak_per_team": 0}
        self._stats["peak_concurrent"] = max(self._stats["peak_concurrent"], self._total)
        if self._per_team:
            self._stats["peak_per_team"] = max(self._stats["peak_per_team"], max(self._per_team.values()))

    def stats_snapshot(self) -> dict:
        """当前统计桶的拷贝(含实时并发),供落盘与 diagnostics 上报。"""
        snap = dict(self._stats)
        snap["current_concurrent"] = self._total
        return snap

    async def broadcast(self, team_id: str, doc_id: str, event: str, data: dict) -> None:
        """向房间内所有订阅者投递一条消息。list() 快照防迭代中变更。"""
        for q in list(self._queues.get((team_id, doc_id), ())):
            await q.put({"event": event, "data": data})


rooms = RoomManager()
