def _s(server, page):
    page.goto(f"{server}/static/sanitize-test.html")
    page.wait_for_function("window.__ready === true", timeout=5000)


def test_sanitize_strips_dangerous(server, page):
    _s(server, page)
    out = page.evaluate(
        "(h) => window.__sanitize(h)",
        "<p onclick='a()'>hi</p><script>alert(1)</script><b>ok</b><img src=x onerror='y()'>",
    )
    assert "<script>" not in out.lower() and "</script>" not in out.lower()
    assert "onclick" not in out
    assert "onerror" not in out
    assert "<b>ok</b>" in out
    assert "hi" in out


def test_sanitize_keeps_allowed(server, page):
    _s(server, page)
    out = page.evaluate("(h) => window.__sanitize(h)", '<p style="color:red">x</p><a href="http://a">l</a>')
    assert "color:red" in out.replace(" ", "") or "color:red" in out
    assert 'href="http://a"' in out


def test_sanitize_strips_javascript_href(server, page):
    _s(server, page)
    out = page.evaluate("(h) => window.__sanitize(h)", '<a href="javascript:alert(1)">x</a>')
    assert "javascript:alert" not in out
