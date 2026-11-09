from pathlib import Path

import pytest
from cart import calc_tot, total_price
from report import summary

ITEMS = [{"price": 2.0, "qty": 3}, {"price": 5.0, "qty": 0}, {"price": 1.0, "qty": -2}]


def test_total_price_skips_nonpositive():
    assert total_price(ITEMS) == 6.0


def test_alias_warns():
    with pytest.warns(DeprecationWarning):
        assert calc_tot(ITEMS) == 6.0


def test_callers_updated():
    assert summary(ITEMS) == "Total: 6.00"
    src = Path(__file__).resolve().parents[1].joinpath("report.py").read_text()
    assert "calc_tot" not in src
