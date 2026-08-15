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


def _post_events(payload):
    return client.post("/api/events", json=payload)


def _reset_limiter():
    from server import app as app_mod
    app_mod._events_limiter._hits.clear()


def test_events_endpoint_happy_path(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch); _reset_limiter()
    r = _post_events({"client_id": "cid_abcdefgh", "events": [
        {"seq": 1, "name": "panel_open", "params": {}, "ts": "2026-08-15T00:00:00Z"},
        {"seq": 2, "name": "login_start", "params": {"method": "email"}, "ts": "2026-08-15T00:00:01Z"},
    ]})
    assert r.status_code == 200 and r.json()["acked_seq"] == 2 and r.json()["inserted"] == 2


def test_events_unknown_name_skipped_not_batch_rejected(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch); _reset_limiter()
    r = _post_events({"client_id": "cid_abcdefgh", "events": [
        {"seq": 1, "name": "panel_open", "params": {}, "ts": ""},
        {"seq": 2, "name": "evil_free_text_event", "params": {}, "ts": ""},
        {"seq": 3, "name": "edit_start", "params": {"is_local": True}, "ts": ""},
    ]})
    j = r.json()
    assert r.status_code == 200 and j["rejected"] == [2] and j["acked_seq"] == 3 and j["inserted"] == 2


def test_events_param_value_enforcement(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch); _reset_limiter()
    r = _post_events({"client_id": "cid_abcdefgh", "events": [
        {"seq": 1, "name": "task_failed", "params": {
            "provider": "claude_code_cli",
            "code": "这是一段自由文本",          # 非法 code 值 → 剥离该参数
            "unknown_key": "x",                  # 未知键 → 剥离
        }, "ts": ""},
    ]})
    assert r.status_code == 200
    import sqlite3, json as _json
    db = sqlite3.connect(str(tmp_path / "e.db"))
    params = _json.loads(db.execute("SELECT params_json FROM analytics_events").fetchone()[0])
    db.close()
    assert params == {"provider": "claude_code_cli"}


def test_events_too_many_per_request_413(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch); _reset_limiter()
    evs = [{"seq": i, "name": "panel_open", "params": {}, "ts": ""} for i in range(51)]
    assert _post_events({"client_id": "cid_abcdefgh", "events": evs}).status_code == 413


def test_events_rate_limited_429(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch); _reset_limiter()
    body = {"client_id": "cid_abcdefgh", "events": [{"seq": 1, "name": "panel_open", "params": {}, "ts": ""}]}
    codes = [_post_events(body).status_code for _ in range(31)]
    assert codes[:30] == [200] * 30 and codes[30] == 429


def test_events_bad_client_id_422(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch); _reset_limiter()
    assert _post_events({"client_id": "x", "events": []}).status_code == 422
