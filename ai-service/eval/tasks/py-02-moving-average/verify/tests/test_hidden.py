import pytest
from stats import moving_average


def test_full_window():
    assert moving_average([1, 2, 3], 3) == [2.0]


def test_window_one():
    assert moving_average([4, 6], 1) == [4.0, 6.0]


@pytest.mark.parametrize("w", [0, -1, 5])
def test_invalid(w):
    with pytest.raises(ValueError):
        moving_average([1, 2, 3], w)
