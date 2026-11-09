import pytest
from listutil import chunk


def test_smaller_than_size():
    assert chunk([1], 3) == [[1]]


def test_empty():
    assert chunk([], 3) == []


def test_exact():
    assert chunk([1, 2, 3, 4], 2) == [[1, 2], [3, 4]]


def test_bad_size():
    with pytest.raises(ValueError):
        chunk([1], 0)
