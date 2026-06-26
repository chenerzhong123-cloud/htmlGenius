import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _annotate_first_text(server, page, doc):
    """在 iframe 内选中第一段≥10字文本,describe 后存为批注,返回 quote。"""
    page.goto(f"{server}/static/viewer.html?doc={doc}")
    page.wait_for_function("window.__frame !== undefined", timeout=10000)
    return page.evaluate(
        """
        async (docId) => {
            const doc = document.getElementById('doc-frame').contentDocument;
            const root = doc.body;
            const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let target = null;
            let node;
            while ((node = walker.nextNode())) {
                if (node.data.trim().length >= 10) { target = node; break; }
            }
            const range = doc.createRange();
            range.setStart(target, 0);
            range.setEnd(target, 10);
            const sel = window.__describe(range, root);
            const r = await fetch('/api/annotations', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({document_id: docId, selector: sel, quote: sel.exact,
                    body: {comment:'t', action:'rewrite', instruction:''}})
            });
            await r.json();
            return sel.exact;
        }
        """,
        doc,
    )


def test_relocate_survives_when_text_kept(server, page):
    quote = _annotate_first_text(server, page, "01_token")
    assert quote  # 存到了

    # reload:文字未变,批注应重定位成功 → iframe 内出现 mark[data-ann]
    page.reload()
    page.wait_for_function("window.__frame !== undefined", timeout=10000)
    count = page.evaluate(
        "() => document.getElementById('doc-frame').contentDocument.querySelectorAll('mark[data-ann]').length"
    )
    assert count >= 1


def test_relocate_goes_stale_when_text_removed(server, page):
    sample = ROOT / "samples" / "02_rag.html"
    backup = sample.read_text(encoding="utf-8")
    try:
        quote = _annotate_first_text(server, page, "02_rag")
        # 模拟 AI 重写:把被批注的文字从 sample 文件里删掉
        altered = backup.replace(quote, "已被改写的占位文字XYZPDQ")
        assert altered != backup, "替换未生效,测试无法继续"
        sample.write_text(altered, encoding="utf-8")

        page.reload()
        page.wait_for_function("window.__frame !== undefined", timeout=10000)
        result = page.evaluate(
            """
            () => {
                const doc = document.getElementById('doc-frame').contentDocument;
                return {
                    marks: doc.querySelectorAll('mark[data-ann]').length,
                    status: document.getElementById('status').textContent
                };
            }
            """
        )
        assert result["marks"] == 0
        assert "已归档 1" in result["status"]
    finally:
        sample.write_text(backup, encoding="utf-8")  # 恢复样本
