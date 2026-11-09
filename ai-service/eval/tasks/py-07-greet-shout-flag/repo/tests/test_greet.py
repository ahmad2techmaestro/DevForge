from greet import main


def test_default():
    assert main([]) == "Hello, world!"
    assert main(["Ann"]) == "Hello, Ann!"
