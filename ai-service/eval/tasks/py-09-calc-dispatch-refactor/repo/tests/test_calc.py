from calc import compute


def test_ops():
    assert compute("add", 1, 2) == 3
    assert compute("div", 6, 3) == 2
