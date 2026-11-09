import pytest
from stack import EmptyStackError, Stack


def test_pop_empty():
    with pytest.raises(EmptyStackError):
        Stack().pop()


def test_peek_empty():
    with pytest.raises(EmptyStackError):
        Stack().peek()


def test_size():
    s = Stack()
    assert s.size == 0
    s.push("a")
    s.push("b")
    assert s.size == 2
    s.pop()
    assert s.size == 1
