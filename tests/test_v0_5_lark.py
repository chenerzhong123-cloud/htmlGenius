from server import lark


def _env(monkeypatch):
    monkeypatch.setenv("HG_LARK_APP_ID", "cli_xxx")
    monkeypatch.setenv("HG_LARK_APP_SECRET", "sec_xxx")
    monkeypatch.setenv("HG_DEFAULT_TEAM", "team_default")
    lark.reset_cache()


def test_authorize_url(monkeypatch):
    _env(monkeypatch)
    u = lark.authorize_url("https://ext.chromiumapp.org/", "st123")
    assert u.startswith("https://open.feishu.cn/open-apis/authen/v1/authorize?")
    assert "app_id=cli_xxx" in u
    assert "state=st123" in u
    assert "redirect_uri=https" in u


class _FakeResp:
    def __init__(self, payload):
        self._p = payload
        self.status_code = 200

    def json(self):
        return self._p

    def raise_for_status(self):
        pass


def test_exchange_code(monkeypatch):
    _env(monkeypatch)

    def fake_post(url, **kw):
        if "app_access_token" in url:
            return _FakeResp({"code": 0, "app_access_token": "aat", "expire": 7200})
        return _FakeResp({"code": 0, "access_token": "uat", "open_id": "ou_9",
                          "name": "飞书用户", "tenant_key": "tk_1"})

    monkeypatch.setattr("server.lark.httpx.post", fake_post)
    info = lark.exchange_code("code_abc", "https://ext.chromiumapp.org/")
    assert info == {"open_id": "ou_9", "name": "飞书用户", "team_id": "tk_1"}


def test_exchange_code_default_team(monkeypatch):
    _env(monkeypatch)

    def fake_post(url, **kw):
        if "app_access_token" in url:
            return _FakeResp({"code": 0, "app_access_token": "aat", "expire": 7200})
        return _FakeResp({"code": 0, "access_token": "uat", "open_id": "ou_9", "name": "u"})

    monkeypatch.setattr("server.lark.httpx.post", fake_post)
    info = lark.exchange_code("code_abc", "https://ext.chromiumapp.org/")
    assert info["team_id"] == "team_default"


def test_app_access_token_cached(monkeypatch):
    _env(monkeypatch)
    calls = {"n": 0}

    def fake_post(url, **kw):
        if "app_access_token" in url:
            calls["n"] += 1
            return _FakeResp({"code": 0, "app_access_token": "aat", "expire": 7200})
        return _FakeResp({"code": 0, "access_token": "uat", "open_id": "ou_x", "name": "x"})

    monkeypatch.setattr("server.lark.httpx.post", fake_post)
    lark.exchange_code("c1", "https://x/")
    lark.exchange_code("c2", "https://x/")
    assert calls["n"] == 1  # app_access_token 只取一次(缓存)
