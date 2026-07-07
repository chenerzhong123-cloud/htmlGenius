import pytest

from server import lark


def _env(monkeypatch):
    monkeypatch.setenv("HG_LARK_APP_ID", "cli_xxx")
    monkeypatch.setenv("HG_LARK_APP_SECRET", "sec_xxx")
    monkeypatch.setenv("HG_DEFAULT_TEAM", "team_default")


def test_authorize_url(monkeypatch):
    _env(monkeypatch)
    u = lark.authorize_url("https://ext.chromiumapp.org/", "st123")
    assert u.startswith("https://accounts.feishu.cn/open-apis/authen/v1/authorize?")
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


def _patch(monkeypatch, token_payload, userinfo_payload):
    """V2:伪造 token(POST)与 user_info(GET)两个调用。"""
    monkeypatch.setattr("server.lark.httpx.post", lambda url, **kw: _FakeResp(token_payload))
    monkeypatch.setattr("server.lark.httpx.get", lambda url, **kw: _FakeResp(userinfo_payload))


def test_exchange_code(monkeypatch):
    _env(monkeypatch)
    _patch(monkeypatch,
           {"code": 0, "access_token": "uat", "expires_in": 7200, "token_type": "Bearer"},
           {"code": 0, "open_id": "ou_9", "name": "飞书用户", "tenant_key": "tk_1"})
    info = lark.exchange_code("code_abc", "https://ext.chromiumapp.org/")
    assert info == {"open_id": "ou_9", "name": "飞书用户", "team_id": "tk_1"}


def test_exchange_code_default_team(monkeypatch):
    _env(monkeypatch)
    _patch(monkeypatch,
           {"code": 0, "access_token": "uat", "expires_in": 7200, "token_type": "Bearer"},
           {"code": 0, "open_id": "ou_9", "name": "u"})  # 无 tenant_key
    info = lark.exchange_code("code_abc", "https://ext.chromiumapp.org/")
    assert info["team_id"] == "team_default"


def test_exchange_code_token_failure_raises(monkeypatch):
    _env(monkeypatch)
    _patch(monkeypatch, {"code": 20003, "error": "invalid_grant"}, {})  # code 失效
    with pytest.raises(RuntimeError):
        lark.exchange_code("bad", "https://ext.chromiumapp.org/")


def test_userinfo_data_envelope(monkeypatch):
    """user_info 响应若带 data 包裹,也能正确解析。"""
    _env(monkeypatch)
    _patch(monkeypatch,
           {"code": 0, "access_token": "uat", "token_type": "Bearer"},
           {"code": 0, "data": {"open_id": "ou_x", "name": "甲", "tenant_key": "tk_2"}})
    info = lark.exchange_code("c", "https://ext.chromiumapp.org/")
    assert info == {"open_id": "ou_x", "name": "甲", "team_id": "tk_2"}
