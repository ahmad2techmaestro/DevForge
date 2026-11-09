from slug import slugify


def test_runs():
    assert slugify("a   b---c") == "a-b-c"


def test_edges():
    assert slugify("  --Hi there--  ") == "hi-there"


def test_digits_and_empty():
    assert slugify("Python 3.12") == "python-3-12"
    assert slugify("!!!") == ""
