def _open(server, page):
    page.goto(f"{server}/static/toolbar-test.html")
    page.wait_for_function("window.__ready === true", timeout=5000)


def test_toolbar_apply_color(server, page):
    _open(server, page)
    page.evaluate("() => window.__apply('color', '#ff0000')")
    c = page.evaluate("() => window.__styleOf()")
    assert "rgb(255" in c or "#ff0000" in c


def test_toolbar_apply_align(server, page):
    _open(server, page)
    page.evaluate("() => window.__apply('align-center')")
    a = page.evaluate("() => window.__alignOf()")
    assert a == "center"
