import os
import pathlib
import socket
import subprocess
import sys
import time

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent


@pytest.fixture(scope="session")
def browser():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def page(browser, server):
    import httpx
    import json as _json

    pg = browser.new_page()
    # v0.5 鉴权:走 dev-login 旁路拿 session token,注入 localStorage.hg_session
    # (annotate.js 的 authHeaders 从 hg_session 读)。等价用户点「dev 登录」。
    # add_init_script 接收【原始 JS 语句】(每次导航 document_start 执行),
    # 不是函数表达式 —— 切勿包成 "() => {...}"。键名 hg_session 须与 annotate.js 同步。
    tok = httpx.post(
        f"{server}/auth/dev-login",
        json={"open_id": "ou_test", "name": "测试", "team": "team_test"},
    ).json()["token"]
    pg.add_init_script(
        f"try {{ localStorage.setItem('hg_session', {_json.dumps(tok)}); }} catch (e) {{}}"
    )
    yield pg
    pg.close()


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait(host, port, timeout=30):
    start = time.time()
    while time.time() - start < timeout:
        try:
            socket.create_connection((host, port)).close()
            return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"server not up at {host}:{port}")


@pytest.fixture(scope="session")
def server(tmp_path_factory):
    port = _free_port()
    db = tmp_path_factory.mktemp("db") / "test.db"
    env = dict(os.environ)
    env["HTMLEDITOR_DB"] = str(db)
    # v0.5 鉴权:dev-login 旁路(不依赖飞书),page fixture 用它造 session token。
    env["HG_AUTH_ALLOW_DEV"] = "1"
    env["HG_LARK_APP_ID"] = "cli_test"
    env["HG_LARK_APP_SECRET"] = "sec_test"
    env["HG_DEFAULT_TEAM"] = "team_test"
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.app:app",
         "--port", str(port), "--no-access-log"],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        _wait("127.0.0.1", port)
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
