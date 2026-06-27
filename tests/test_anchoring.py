def _wait_ready(server, page):
    page.goto(f"{server}/static/anchoring/test.html")
    page.wait_for_function("window.__ready === true", timeout=5000)


def test_describe_anchor_roundtrip(server, page):
    _wait_ready(server, page)
    result = page.evaluate(
        """
        () => {
            const root = window.__root;
            const p1 = window.__p1;
            const range = document.createRange();
            range.setStart(p1, 0);
            range.setEnd(p1, 5);   // "苹果是一种"
            const sel = window.__describe(range, root);
            const back = window.__anchor(sel, root);
            const probe = document.createRange();
            probe.setStart(p1, 0); probe.setEnd(p1, 5);
            const equalStart = back.compareBoundaryPoints(Range.START_TO_START, probe) === 0;
            const equalEnd = back.compareBoundaryPoints(Range.END_TO_END, probe) === 0;
            return { exact: sel.exact, equalStart, equalEnd };
        }
        """
    )
    assert result["exact"] == "苹果是一种"
    assert result["equalStart"] and result["equalEnd"]


def test_anchor_returns_null_when_text_removed(server, page):
    _wait_ready(server, page)
    stale = page.evaluate(
        """
        () => {
            const sel = { type: "TextQuoteSelector", exact: "这段文字根本不存在于文档中XYZ", prefix: "", suffix: "" };
            return window.__anchor(sel, window.__root) === null;
        }
        """
    )
    assert stale is True


def test_anchor_multi_no_context_returns_null(server, page):
    """多处重复 + 无前后文消歧 → stale(避免静默漂移)"""
    _wait_ready(server, page)
    stale = page.evaluate(
        """
        () => {
            // p3 有 3 个「水果」;exact=水果、无前后文 → 消歧不足
            const sel = { type: "TextQuoteSelector", exact: "水果", prefix: "", suffix: "" };
            return window.__anchor(sel, window.__root) === null;
        }
        """
    )
    assert stale is True


def test_disambiguate_by_prefix_suffix(server, page):
    _wait_ready(server, page)
    result = page.evaluate(
        """
        () => {
            const root = window.__root;
            // 选中 p3 里第二个“水果”,靠 prefix(前一个“水果 ”)消歧
            const p3 = document.getElementById("p3").firstChild;
            // p3 文本: "重复词汇:水果 水果 水果。" —— 第二个“水果”起始索引
            const text = p3.data;
            const first = text.indexOf("水果");
            const second = text.indexOf("水果", first + 1);
            const range = document.createRange();
            range.setStart(p3, second);
            range.setEnd(p3, second + 2);
            const sel = window.__describe(range, root);
            const back = window.__anchor(sel, root);
            const probe = document.createRange();
            probe.setStart(p3, second); probe.setEnd(p3, second + 2);
            return { equalStart: back.compareBoundaryPoints(Range.START_TO_START, probe) === 0 };
        }
        """
    )
    assert result["equalStart"] is True
