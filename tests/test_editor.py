def test_editor_init_contenteditable_locks_style(server, page):
    page.goto(f"{server}/static/editor-test.html")
    page.wait_for_function("window.__ready === true", timeout=5000)
    info = page.evaluate("() => window.__check()")
    assert info["bodyEditable"] == "true"
    assert info["styleEditable"] == "false"


def test_editor_emit_dom_changed(server, page):
    page.goto(f"{server}/static/editor-test.html")
    page.wait_for_function("window.__ready === true", timeout=5000)
    page.evaluate(
        "() => { const d = window.__doc; d.body.appendChild(d.createElement('p')); "
        "d.body.dispatchEvent(new d.defaultView.Event('input', {bubbles:true})); }"
    )
    page.wait_for_function("window.__domChanged === true", timeout=3000)
