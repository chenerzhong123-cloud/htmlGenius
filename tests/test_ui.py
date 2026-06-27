import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _open(server, page, doc):
    page.goto(f"{server}/static/viewer.html?doc={doc}")
    page.wait_for_function("window.__frame !== undefined", timeout=10000)


def _select_first_text(page, length=8):
    """在 iframe 内选中第一段≥10字文本,触发 selectionchange。"""
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


def _annotate(page, comment="c"):
    """合并后的批注流程:mock iframe prompt → 选中 → 点 toolbar 的 Comment 按钮 → 批注入库"""
    page.evaluate(
        f"""() => {{ try {{ document.getElementById('doc-frame').contentWindow.prompt = () => {json.dumps(comment)}; }} catch(e) {{}} }}"""
    )
    _select_first_text(page)
    page.wait_for_timeout(200)
    page.evaluate(
        """() => {
            const b = document.getElementById('doc-frame').contentDocument.querySelector('#hg-toolbar button[data-act="comment"]');
            if (b) b.click();
        }"""
    )
    page.wait_for_timeout(700)


def test_toolbar_shows_on_selection(server, page):
    _open(server, page, "01_token")
    _select_first_text(page)
    page.wait_for_timeout(200)
    shown = page.evaluate(
        "() => document.getElementById('doc-frame').contentDocument.getElementById('hg-toolbar').classList.contains('show')"
    )
    assert shown


def test_sidebar_shows_annotation(server, page):
    _open(server, page, "01_token")
    _annotate(page)
    cards = page.locator("#sidebar-list .card").count()
    marks = page.evaluate(
        "() => document.getElementById('doc-frame').contentDocument.querySelectorAll('.ann-hl').length"
    )
    assert cards >= 1
    assert marks >= 1


def test_delete_via_sidebar(server, page):
    _open(server, page, "02_rag")
    page.wait_for_timeout(400)
    before = page.locator("#sidebar-list .card").count()
    _annotate(page)
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
        _annotate(page)
        quote = page.evaluate("() => document.querySelector('#sidebar-list .card .quote')?.textContent?.trim() || ''")
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
    _annotate(page, "请把这段改简洁")
    prompt = page.evaluate(
        """async () => {
            const r = await fetch('/api/annotations?document_id=01_token');
            const data = await r.json();
            return window.__buildPrompt(data.items);
        }"""
    )
    assert "HTML 编辑执行器" in prompt
    assert "定位:" in prompt
    assert "请把这段改简洁" in prompt


def test_overlay_does_not_mutate_dom(server, page):
    _open(server, page, "spec")
    before = page.evaluate("""() => {
        const doc = document.getElementById('doc-frame').contentDocument;
        const ol = doc.querySelector('.toc ol') || doc.querySelector('ol');
        return { liCount: ol ? ol.querySelectorAll('li').length : -1, markCount: doc.querySelectorAll('mark').length };
    }""")
    _annotate(page, "t")
    after = page.evaluate("""() => {
        const doc = document.getElementById('doc-frame').contentDocument;
        const ol = doc.querySelector('.toc ol') || doc.querySelector('ol');
        return { liCount: ol ? ol.querySelectorAll('li').length : -1, markCount: doc.querySelectorAll('mark').length, hlCount: doc.querySelectorAll('.ann-hl').length };
    }""")
    assert before["liCount"] == after["liCount"], f"TOC li 数变了:{before['liCount']}→{after['liCount']}"
    assert after["markCount"] == 0, "原文出现 <mark>(overlay 不应注入 mark)"
    assert after["hlCount"] >= 1


def test_card_transform_follows_scroll(server, page):
    _open(server, page, "01_token")
    _annotate(page)
    t1 = page.evaluate("() => { const c = document.querySelector('#sidebar-list .card'); return c ? c.style.transform : ''; }")
    page.evaluate("() => document.getElementById('doc-frame').contentWindow.scrollTo(0, 300)")
    page.wait_for_timeout(400)
    t2 = page.evaluate("() => { const c = document.querySelector('#sidebar-list .card'); return c ? c.style.transform : ''; }")
    assert t1 and t2 and t1 != t2, f"卡片 transform 应随滚动变化:{t1}→{t2}"
