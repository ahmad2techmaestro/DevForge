import operator

OPERATIONS = {"add": operator.add, "sub": operator.sub, "mul": operator.mul, "div": operator.truediv}


def compute(op, a, b):
    try:
        fn = OPERATIONS[op]
    except KeyError:
        raise ValueError(f"unknown operation: {op}") from None
    return fn(a, b)
