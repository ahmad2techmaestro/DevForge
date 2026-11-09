from stack import Stack


def test_push_pop():
    s = Stack()
    s.push(1)
    assert s.pop() == 1
