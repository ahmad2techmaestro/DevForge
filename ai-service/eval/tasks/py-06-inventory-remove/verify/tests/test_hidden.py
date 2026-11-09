import pytest
from inventory import Inventory


def test_remove():
    inv = Inventory()
    inv.add("a", 5)
    inv.remove("a", 2)
    assert inv.count("a") == 3


def test_remove_too_many_keeps_stock():
    inv = Inventory()
    inv.add("a", 1)
    with pytest.raises(ValueError):
        inv.remove("a", 2)
    assert inv.count("a") == 1


def test_unknown_sku():
    with pytest.raises(ValueError):
        Inventory().remove("zzz", 1)


def test_skus_sorted_and_empty_removed():
    inv = Inventory()
    inv.add("b", 1)
    inv.add("a", 2)
    assert inv.skus() == ["a", "b"]
    inv.remove("b", 1)
    assert inv.skus() == ["a"]
