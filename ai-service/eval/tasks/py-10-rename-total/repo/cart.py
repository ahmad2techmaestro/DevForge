def calc_tot(items):
    t = 0
    for i in items:
        t += i["price"] * i["qty"]
    return t
