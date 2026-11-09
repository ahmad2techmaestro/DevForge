import pytest
from roman import from_roman, to_roman


@pytest.mark.parametrize("n,s", [(1, "I"), (4, "IV"), (9, "IX"), (58, "LVIII"), (1994, "MCMXCIV"), (3999, "MMMCMXCIX")])
def test_to_roman(n, s):
    assert to_roman(n) == s
    assert from_roman(s) == n


def test_roundtrip():
    assert all(from_roman(to_roman(n)) == n for n in range(1, 4000))


@pytest.mark.parametrize("n", [0, -5, 4000])
def test_bad_int(n):
    with pytest.raises(ValueError):
        to_roman(n)


@pytest.mark.parametrize("s", ["IIII", "VX", "", "ABC", "IC"])
def test_bad_numeral(s):
    with pytest.raises(ValueError):
        from_roman(s)
