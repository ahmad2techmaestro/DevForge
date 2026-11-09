from cart import calc_tot
from report import summary


def test_total():
    assert calc_tot([{"price": 2.0, "qty": 3}]) == 6.0
    assert summary([{"price": 1.5, "qty": 2}]) == "Total: 3.00"
