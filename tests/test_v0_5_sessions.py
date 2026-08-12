import time

from server import storage, sessions


def _init(tmp_path, monkeypatch):
    monkeypatch.setenv("HG_SESSION_TTL", "60")
    storage.init_db(tmp_path / "s.db")


def test_create_and_get(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    tok = sessions.create_session("ou_1", "alice", "team_a")
    assert isinstance(tok, str) and tok.startswith("sess_")
    s = sessions.get_session(tok)
    assert s == {"open_id": "ou_1", "name": "alice", "team_id": "team_a"}


def test_missing_returns_none(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    assert sessions.get_session("sess_nope") is None


def test_expired_returns_none(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    tok = sessions.create_session("ou_2", "bob", "team_a", ttl=1)
    time.sleep(1.2)
    assert sessions.get_session(tok) is None


def test_delete(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    tok = sessions.create_session("ou_3", "carol", "team_a")
    assert sessions.delete_session(tok) is True
    assert sessions.get_session(tok) is None
    assert sessions.delete_session(tok) is False


def test_prune(tmp_path, monkeypatch):
    _init(tmp_path, monkeypatch)
    sessions.create_session("ou_4", "dan", "team_a", ttl=1)
    time.sleep(1.2)
    assert sessions.prune_expired() == 1


def _exp_of(token):
    from server.storage import _connect
    c = _connect()
    try:
        return c.execute("SELECT expires_at FROM sessions WHERE token=?", (token,)).fetchone()["expires_at"]
    finally:
        c.close()


def test_touch_renews_when_near_expiry(tmp_path, monkeypatch):
    storage.init_db(tmp_path / "t.db")
    tok = sessions.create_session("ou", "n", "t", ttl=30)  # 30s 剩 < 86400 阈值 → 续
    before = _exp_of(tok)
    s = sessions.touch_session(tok)
    assert s == {"open_id": "ou", "name": "n", "team_id": "t"}
    assert _exp_of(tok) > before  # 续期:过期时间被推后


def test_touch_no_renew_when_far(tmp_path, monkeypatch):
    storage.init_db(tmp_path / "t2.db")
    tok = sessions.create_session("ou", "n", "t", ttl=100000)  # > 阈值,不续
    before = _exp_of(tok)
    sessions.touch_session(tok)
    assert _exp_of(tok) == before  # 离过期还远,不动


def test_touch_expired_returns_none(tmp_path, monkeypatch):
    storage.init_db(tmp_path / "t3.db")
    tok = sessions.create_session("ou", "n", "t", ttl=1)
    time.sleep(1.2)
    assert sessions.touch_session(tok) is None


def test_absolute_lifetime_invalidates_even_with_future_expiry(tmp_path, monkeypatch):
    """BE-11:超过绝对寿命(创建起算)→ 失效,即便 expires_at 在未来、touch 滑动续期也不绕过。"""
    from datetime import datetime, timedelta, timezone
    storage.init_db(tmp_path / "be11.db")
    monkeypatch.setattr(sessions, "_ABSOLUTE_TTL", 3600)  # 1h 绝对上限
    tok = sessions.create_session("u", "U", "t", ttl=604800)  # 7d 滑动有效期
    assert sessions.get_session(tok) is not None  # 刚创建,在绝对寿命内
    # 篡改 created_at 到 2h 前(超 1h 绝对上限),expires_at 留在未来
    c = storage._connect()
    old_created = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    future_exp = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
    c.execute("UPDATE sessions SET created_at=?, expires_at=? WHERE token=?", (old_created, future_exp, tok))
    c.close()
    assert sessions.get_session(tok) is None   # 绝对寿命到 → 失效(强制重登)
    assert sessions.touch_session(tok) is None  # touch 也不再续期
