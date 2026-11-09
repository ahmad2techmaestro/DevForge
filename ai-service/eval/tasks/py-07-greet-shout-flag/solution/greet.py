import sys


def greet(name):
    return f"Hello, {name}!"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    shout = "--shout" in argv
    if shout:
        argv.remove("--shout")
    times = 1
    if "--times" in argv:
        i = argv.index("--times")
        try:
            times = int(argv[i + 1])
        except (IndexError, ValueError):
            raise ValueError("--times needs an integer") from None
        if times < 1:
            raise ValueError("--times must be positive")
        del argv[i:i + 2]
    text = " ".join([greet(argv[0] if argv else "world")] * times)
    return text.upper() if shout else text


if __name__ == "__main__":
    print(main())
