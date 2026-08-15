from server import security


def test_hash_and_verify_password():
    h = security.hash_secret("correct horse")
    assert h != "correct horse" and "$" in h
    assert security.verify_secret("correct horse", h) is True
    assert security.verify_secret("wrong", h) is False


def test_hash_is_salted_unique():
    assert security.hash_secret("same") != security.hash_secret("same")


def test_verify_garbage_stored_returns_false():
    assert security.verify_secret("x", "not-a-valid-hash") is False
    assert security.verify_secret("x", "") is False


def test_gen_code_is_6_digits():
    for _ in range(20):
        c = security.gen_code()
        assert len(c) == 6 and c.isdigit()
