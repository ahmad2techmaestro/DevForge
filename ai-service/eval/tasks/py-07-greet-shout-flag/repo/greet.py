import sys


def greet(name):
    return f"Hello, {name}!"


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    return greet(argv[0] if argv else "world")


if __name__ == "__main__":
    print(main())
