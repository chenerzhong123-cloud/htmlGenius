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
def page(browser):
    pg = browser.new_page()
    # v0.4: viewer 前端在 T7 之前不发 team token,老浏览器测试用
    # set_extra_http_headers 给所有请求注入 Authorization 头,使 viewer 的
    # fetch(/api/annotations) 通过鉴权。仅测试用,不进生产代码;T7 viewer
    # 接入 token 后可移除。
    pg.set_extra_http_headers({"Authorization": "Bearer t_test"})
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
    # v0.4 鉴权:测试用默认 team token (viewer 前端在 T7 之前还不发 token,
    # 故老浏览器测试用 patch-fetch fixture 注入,见 _auth_fetch 注释)
    env["HG_TEAMS"] = '{"t_test":"team_test"}'
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
