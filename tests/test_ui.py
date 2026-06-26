import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _open(server, page, doc):
    page.goto(f"{server}/static/viewer.html?doc={doc}")
    page.wait_for_function("window.__frame !== undefined", timeout=10000)


def _select_first_text(page, length=8):
    """在 iframe 内选中第一段≥10字文本,触发 selectionchange,返回选中文本。"""
    return page.evaluate(
        """
        (len) => {
            const doc = document.getElementById('doc-frame').contentDocument;
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
            let target = null, node;
            while ((node = walker.nextNode())) {
                if (node.data.trim().length >= 10) { target = node; break; }
            }
            const range = doc.createRange();
            range.setStart(target, 0);
            range.setEnd(target, len);
            const sel = doc.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            doc.dispatchEvent(new Event('selectionchange'));
            return range.toString();
        }
        """,
        length,
    )


def _click_float_button(page, btn_id):
    page.evaluate(
        """(id) => document.getElementById('doc-frame').contentDocument.getElementById(id).click()""",
        btn_id,
    )


def test_floating_button_appears_on_selection(server, page):
    _open(server, page, "01_token")
    _select_first_text(page)
    page.wait_for_timeout(200)
    shown = page.evaluate(
        "() => document.getElementById('doc-frame').contentDocument.getElementById('ann-float').classList.contains('show')"
    )
    assert shown


def test_sidebar_shows_annotation_after_submit(server, page):
    _open(server, page, "01_token")
    _select_first_text(page)
    page.wait_for_timeout(200)
    _click_float_button(page, "ann-btn")
    page.wait_for_timeout(100)
    _click_float_button(page, "ann-submit")
    page.wait_for_timeout(600)
    cards = page.locator("#sidebar-list .card").count()
    marks = page.evaluate(
        "() => document.getElementById('doc-frame').contentDocument.querySelectorAll('mark[data-ann]').length"
    )
    assert cards >= 1
    assert marks >= 1


def test_delete_via_sidebar(server, page):
    _open(server, page, "02_rag")
    page.wait_for_timeout(400)
    before = page.locator("#sidebar-list .card").count()
    _select_first_text(page)
    page.wait_for_timeout(200)
    _click_float_button(page, "ann-btn")
    _click_float_button(page, "ann-submit")
    page.wait_for_timeout(600)
    after_add = page.locator("#sidebar-list .card").count()
    assert after_add == before + 1

    page.locator("#sidebar-list .card .del").first.click()
    page.wait_for_timeout(600)
    after_del = page.locator("#sidebar-list .card").count()
    assert after_del == before


def test_archive_on_stale(server, page):
    sample = ROOT / "samples" / "03_fine-tuning.html"
    backup = sample.read_text(encoding="utf-8")
    try:
        _open(server, page, "03_fine-tuning")
        _select_first_text(page)
        page.wait_for_timeout(200)
        _click_float_button(page, "ann-btn")
        _click_float_button(page, "ann-submit")
        page.wait_for_timeout(600)
        quote = page.evaluate(
            "() => document.querySelector('#sidebar-list .card .quote')?.textContent?.trim() || ''"
        )
        assert quote, "未取到批注 quote"

        altered = backup.replace(quote, "占位改写文字ZZZQQ")
        assert altered != backup, "替换未生效"
        sample.write_text(altered)

        page.reload()
        page.wait_for_function("window.__frame !== undefined", timeout=10000)
        page.wait_for_timeout(800)
        assert page.locator("#sidebar-archive .card").count() >= 1
        assert page.locator("#sidebar-list .card").count() == 0
    finally:
        sample.write_text(backup, encoding="utf-8")


def test_export_prompt_format(server, page):
    _open(server, page, "01_token")
    _select_first_text(page)
    page.wait_for_timeout(200)
    _click_float_button(page, "ann-btn")
    page.evaluate(
        """() => document.getElementById('doc-frame').contentDocument.getElementById('ann-input').value = '请把这段改简洁'"""
    )
    _click_float_button(page, "ann-submit")
    page.wait_for_timeout(600)
    prompt = page.evaluate(
        """async () => {
            const r = await fetch('/api/annotations?document_id=01_token');
            const data = await r.json();
            return window.__buildPrompt(data.items);
        }"""
    )
    assert "请基于以下批注" in prompt
    assert "请把这段改简洁" in prompt
