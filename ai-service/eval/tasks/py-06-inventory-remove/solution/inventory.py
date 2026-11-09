class Inventory:
    def __init__(self):
        self._stock = {}

    def add(self, sku, qty):
        self._stock[sku] = self._stock.get(sku, 0) + qty

    def count(self, sku):
        return self._stock.get(sku, 0)

    def remove(self, sku, qty):
        have = self._stock.get(sku, 0)
        if have < qty:
            raise ValueError("insufficient stock")
        if have == qty:
            del self._stock[sku]
        else:
            self._stock[sku] = have - qty

    def skus(self):
        return sorted(k for k, v in self._stock.items() if v > 0)
