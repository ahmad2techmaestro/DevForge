def chunk(items, size):
    return [items[i:i + size] for i in range(0, len(items) - len(items) % size, size)]
