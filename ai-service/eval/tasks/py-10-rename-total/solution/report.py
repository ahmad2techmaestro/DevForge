from cart import total_price


def summary(items):
    return f"Total: {total_price(items):.2f}"
