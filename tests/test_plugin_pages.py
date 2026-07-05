"""Playwright 加载器:遍历 extension/ 下约定的测试页,跳过缺失项。

每页契约:成功 document.title="PASS",失败 "FAIL: <msg>"。
"""
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = Path(__file__).resolve().parent.parent / "extension"


def test_plugin_pages():
    names = [
        "remote-store-test.html",
        "apply-delta-test.html",
        "buildprompt-test.html",
        "sync-test.html",
    ]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        for name in names:
            f = EXT / name
            if not f.exists():
                continue  # 后续 Task 才创建的测试页,缺失则跳过
            page.goto(f.as_uri())
            page.wait_for_function(
                "document.title.startsWith('PASS') || document.title.startsWith('FAIL')",
                timeout=5000,
            )
            title = page.title()
            assert title.startswith("PASS"), f"{name}: {title}"
        browser.close()
