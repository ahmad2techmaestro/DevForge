class EmptyStackError(Exception):
    pass


class Stack:
    def __init__(self):
        self._items = []

    def push(self, item):
        self._items.append(item)

    def pop(self):
        if not self._items:
            raise EmptyStackError("pop from empty stack")
        return self._items.pop()

    def peek(self):
        if not self._items:
            raise EmptyStackError("peek at empty stack")
        return self._items[-1]

    @property
    def size(self):
        return len(self._items)
