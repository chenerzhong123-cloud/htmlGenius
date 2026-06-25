from server.models import AnnotationCreate, TextQuoteSelector, AnnotationBody


def test_selector_defaults():
    s = TextQuoteSelector(exact="最小单位")
    assert s.type == "TextQuoteSelector"
    assert s.prefix == "" and s.suffix == ""


def test_annotation_create_defaults_body():
    a = AnnotationCreate(
        document_id="doc_01_token",
        selector=TextQuoteSelector(exact="最小单位", prefix="在 NLP 中,", suffix="。"),
        quote="最小单位",
    )
    assert a.version == 1
    assert a.body.action == "rewrite"
    assert a.body.comment == ""
