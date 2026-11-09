import re

_PAIRS = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]
_VALID = re.compile(r"^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$")


def to_roman(n):
    if not isinstance(n, int) or not 1 <= n <= 3999:
        raise ValueError("out of range")
    out = []
    for value, sym in _PAIRS:
        while n >= value:
            out.append(sym)
            n -= value
    return "".join(out)


def from_roman(s):
    if not s or not _VALID.match(s):
        raise ValueError("malformed numeral")
    total = 0
    for value, sym in _PAIRS:
        while s.startswith(sym):
            total += value
            s = s[len(sym):]
    return total
