from dedupe import dedupe


def test_unhashable():
    assert dedupe([[1], [2], [1]]) == [[1], [2]]


def test_strings():
    assert dedupe(["b", "a", "b"]) == ["b", "a"]


def test_empty():
    assert dedupe([]) == []
