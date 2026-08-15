import pytest
from fastapi.testclient import TestClient

from server import storage
from server.app import app

client = TestClient(app)


def _init(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_ENV", "test")
    monkeypatch.setenv("HG_LARK_APP_SECRET", "s")
    monkeypatch.setenv("HG_DEFAULT_TEAM", "team_d")
    storage.init_db(tmp_path / "e.db")


def _ev(seq, name="panel_open", params=None, ts="2026-08-15T00:00:00Z"):
    return {"seq": seq, "name": name, "params": params or {}, "ts": ts}


def test_save_events_and_idempotent_repost(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    n = storage.save_events("cid_abcdefgh", [_ev(1), _ev(2, "login_start", {"method": "google"})])
    assert n == 2
    # 同 client_id+seq 重发 → 幂等,不产生重复行
    n2 = storage.save_events("cid_abcdefgh", [_ev(1), _ev(2, "login_start", {"method": "google"})])
    assert n2 == 0
    import sqlite3
    db = sqlite3.connect(str(tmp_path / "e.db"))
    rows = db.execute("SELECT client_id, seq, name, params_json, client_ts FROM analytics_events ORDER BY seq").fetchall()
    db.close()
    assert len(rows) == 2
    assert rows[0] == ("cid_abcdefgh", 1, "panel_open", "{}", "2026-08-15T00:00:00Z")
    assert rows[1][2] == "login_start"


def test_window_limiter_basic_and_injected_clock():
    from server.ratelimit import WindowLimiter
    clock = {"t": 0.0}
    lim = WindowLimiter(3, 60, now=lambda: clock["t"])
    assert [lim.allow("ip1") for _ in range(3)] == [True, True, True]
    assert lim.allow("ip1") is False          # 窗口内第 4 次
    assert lim.allow("ip2") is True           # 不同 key 互不影响
    clock["t"] = 61.0                          # 窗口滑走
    assert lim.allow("ip1") is True


def test_prune_analytics_deletes_old_rows(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    storage.save_events("cid_abcdefgh", [_ev(1, ts="2020-01-01T00:00:00Z"), _ev(2)])
    assert storage.prune_analytics(keep_days=90) == 1
    import sqlite3
    db = sqlite3.connect(str(tmp_path / "e.db"))
    n = db.execute("SELECT COUNT(*) FROM analytics_events").fetchone()[0]
    db.close()
    assert n == 1
