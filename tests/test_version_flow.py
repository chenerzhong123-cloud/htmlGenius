def test_version_flush_list_restore(server, page):
    page.goto(f"{server}/static/version-test.html")
    page.wait_for_function("window.__ready === true", timeout=8000)
    # flush 存版本(模拟有改动:设 dirty)
    page.evaluate("async () => { window.__vm.dirty = true; await window.__vm.flush(); }")
    n = page.evaluate("async () => (await window.__vm.list()).length")
    assert n >= 1
    # 改内容再 flush → 第 2 版
    page.evaluate("() => { const d = document.getElementById('t').contentDocument; d.body.querySelector('p').textContent = 'changed'; }")
    page.evaluate("async () => { window.__vm.dirty = true; await window.__vm.flush(); }")
    n2 = page.evaluate("async () => (await window.__vm.list()).length")
    assert n2 >= 2
    # 还原 v1
    page.evaluate("async () => { await window.__vm.restore(1); }")
    page.wait_for_timeout(300)
    body = page.evaluate("() => { try { return document.getElementById('t').contentDocument.body.textContent; } catch(e){ return ''; } }")
    assert "edit me" in body
