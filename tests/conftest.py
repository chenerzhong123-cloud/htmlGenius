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
    # FIXME(v0.4 鉴权): viewer 生产代码从 localStorage.hg_token 读 token,经
    # annotate.js 的 authHeaders() 注入 Authorization: Bearer。这里走【真实路径】
    # —— 用 add_init_script 在每个页面导航前把 token 写进 localStorage,等价于
    # 用户在 viewer.html 的 token 入口点过「设置」。务必与 viewer.html / annotate.js
    # 的存储键 hg_token 保持同步;一旦该键改名,此处须同改。
    # add_init_script 接收的是【原始 JS 语句】(在每次导航的 document_start
    # 执行),不是函数表达式 —— 切勿包成 "() => {...}",那样只定义不调用。
    pg.add_init_script(
        "try { localStorage.setItem('hg_token', 't_test'); } catch (e) {}"
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
