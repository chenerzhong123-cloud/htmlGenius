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


def test_undo_restores_previous(server, page):
    page.goto(f"{server}/static/editor-test.html")
    page.wait_for_function("window.__ready === true", timeout=5000)
    # 先 push 当前(含 hello),再改成 changed
    page.evaluate("() => { window.__pushUndo(); window.__doc.body.innerHTML = '<p>changed</p>'; }")
    ok = page.evaluate("() => window.__undo()")
    assert ok is True
    body = page.evaluate("() => window.__doc.body.innerHTML")
    assert "hello" in body  # 还原到 pushUndo 时的状态


def test_undo_empty_returns_false(server, page):
    page.goto(f"{server}/static/editor-test.html")
    page.wait_for_function("window.__ready === true", timeout=5000)
    assert page.evaluate("() => window.__undo()") is False
