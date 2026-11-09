import warnings


def total_price(items):
    return sum(i["price"] * i["qty"] for i in items if i["qty"] > 0)


def calc_tot(items):
    warnings.warn("calc_tot is deprecated; use total_price", DeprecationWarning, stacklevel=2)
    return total_price(items)
