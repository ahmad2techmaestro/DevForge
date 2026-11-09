import calc
import pytest


def test_table_exists():
    assert set(calc.OPERATIONS) == {"add", "sub", "mul", "div"}
    assert all(callable(f) for f in calc.OPERATIONS.values())
    assert calc.OPERATIONS["sub"](5, 3) == 2


def test_behaviour_unchanged():
    assert calc.compute("mul", 3, 4) == 12
    assert calc.compute("sub", 3, 4) == -1
    with pytest.raises(ZeroDivisionError):
        calc.compute("div", 1, 0)


def test_unknown_op():
    with pytest.raises(ValueError):
        calc.compute("pow", 2, 3)


def test_extensible():
    calc.OPERATIONS["mod"] = lambda a, b: a % b
    try:
        assert calc.compute("mod", 7, 4) == 3
    finally:
        del calc.OPERATIONS["mod"]
