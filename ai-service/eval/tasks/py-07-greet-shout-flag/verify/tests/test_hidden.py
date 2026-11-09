import pytest
from greet import main


def test_shout():
    assert main(["--shout", "ann"]) == "HELLO, ANN!"


def test_times():
    assert main(["bob", "--times", "2"]) == "Hello, bob! Hello, bob!"


def test_both():
    assert main(["--times", "2", "--shout"]) == "HELLO, WORLD! HELLO, WORLD!"


@pytest.mark.parametrize("bad", ["0", "-1", "x"])
def test_bad_times(bad):
    with pytest.raises(ValueError):
        main(["--times", bad])
