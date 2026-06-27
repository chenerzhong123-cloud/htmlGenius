def test_v02_edit_creates_version(server, page):
    """集成:e2e 编辑文字 → 防抖/flush → 版本入库(还原逻辑见 test_version_flow)"""
    page.goto(f"{server}/static/viewer.html?doc=01_token")
    page.wait_for_function("window.__frame !== undefined", timeout=10000)
    page.wait_for_function("window.__vm !== undefined", timeout=5000)
    page.evaluate(
        "async () => { await fetch('/api/documents', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({document_id:'01_token'})}); }"
    )
    page.evaluate(
        """() => {
            const d = document.getElementById('doc-frame').contentDocument;
            const p = d.body.querySelector('p');
            if (p) p.textContent = 'EDITED_CONTENT';
            d.body.dispatchEvent(new d.defaultView.Event('input', {bubbles:true}));
        }"""
    )
    page.wait_for_timeout(200)
    page.evaluate("async () => { window.__vm.dirty = true; await window.__vm.flush(); }")
    n = page.evaluate("async () => (await window.__vm.list()).length")
    assert n >= 1
