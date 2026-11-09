from inventory import Inventory


def test_add_count():
    inv = Inventory()
    inv.add("a", 2)
    assert inv.count("a") == 2
