"""Playwright 加载器:遍历 extension/ 下约定的测试页,跳过缺失项。

每页契约:成功 document.title="PASS",失败 "FAIL: <msg>"。

稳定性说明:
- chromium 启动在机器高负载下偶发失败 → ``_launch_with_retry`` 最多 3 次重试。
- 全套运行时,前置测试(anyio/httpx)可能残留 running asyncio loop,
  Playwright sync API 检测到 running loop 即拒绝启动(报 "It looks like you
  are using Playwright Sync API inside the asyncio loop")。把整段 sync
  Playwright 逻辑放进独立线程(线程内新建并关闭自己的 event loop)可彻底
  隔离,与运行顺序无关。同套模式见 ``test_v0_4_presence._run``。
"""
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = Path(__file__).resolve().parent.parent / "extension"

NAMES = [
    "remote-store-test.html",
    "apply-delta-test.html",
    "buildprompt-test.html",
    "sync-test.html",
    "version-test.html",
]


def _launch_with_retry(p, attempts=3, backoff=1.0):
    """重试启动 chromium:机器高负载下偶发启动失败,重试避免偶发红。

    末次仍失败则把异常透传(不吞错)。
    """
    last_exc = None
    for i in range(attempts):
        try:
            return p.chromium.launch()
        except Exception as e:  # noqa: BLE001 — 末次异常透传
            last_exc = e
            if i < attempts - 1:
                time.sleep(backoff)
    raise last_exc


def _run_in_isolated_loop():
    """在独立线程 + 独立事件循环里执行 Playwright sync 逻辑。

    返回 (failures, error):任一非空即测试失败;两者皆空表示全部通过。
    """

    result: dict = {}

    def worker():
        try:
            with sync_playwright() as p:
                browser = _launch_with_retry(p)
                try:
                    page = browser.new_page()
                    failures = []
                    for name in NAMES:
                        f = EXT / name
                        if not f.exists():
                            continue  # 后续 Task 才创建的测试页,缺失则跳过
                        page.goto(f.as_uri())
                        page.wait_for_function(
                            "document.title.startsWith('PASS') "
                            "|| document.title.startsWith('FAIL')",
                            timeout=5000,
                        )
                        title = page.title()
                        if not title.startswith("PASS"):
                            failures.append(f"{name}: {title}")
                    result["failures"] = failures
                finally:
                    browser.close()
        except BaseException as e:  # noqa: BLE001 — 透回主线程
            result["error"] = e

    t = threading.Thread(target=worker)
    t.start()
    t.join()
    return result.get("failures", []), result.get("error")


def test_plugin_pages():
    failures, err = _run_in_isolated_loop()
    if err is not None:
        raise err
    assert not failures, "; ".join(failures)
