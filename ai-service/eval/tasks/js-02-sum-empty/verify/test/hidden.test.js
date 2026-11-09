import test from "node:test";
import assert from "node:assert/strict";
import { sumNumbers } from "../math.js";

test("empty", () => {
  assert.equal(sumNumbers([]), 0);
});

test("ignores junk", () => {
  assert.equal(sumNumbers([1, "2", null, NaN, undefined, 4]), 5);
});

test("negatives and floats", () => {
  assert.equal(sumNumbers([-1, 0.5, 0.5]), 0);
});
