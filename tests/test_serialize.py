def test_serialize_keeps_head_strips_injected(server, page):
    page.goto(f"{server}/static/serialize-test.html")
    page.wait_for_function("window.__ready === true", timeout=5000)
    page.wait_for_function(
        "() => { try { return document.getElementById('test-frame').contentDocument !== null; } catch(e){ return false; } }",
        timeout=5000,
    )
    out = page.evaluate("() => window.__serialize(document.getElementById('test-frame').contentDocument)")
    assert "<style>" in out
    assert "real-content" in out
    assert "injected-overlay" not in out
