import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sumSquares, squares } from "../stats.js";

test("squares", () => {
  assert.deepEqual(squares([1, -2, 3]), [1, 4, 9]);
  assert.deepEqual(squares([]), []);
});

test("sumSquares unchanged", () => {
  assert.equal(sumSquares([1, 2, 3]), 14);
  assert.equal(sumSquares([]), 0);
});

test("non-array throws", () => {
  assert.throws(() => sumSquares("abc"), TypeError);
  assert.throws(() => sumSquares(null), TypeError);
});

test("no more var", () => {
  assert.ok(!/\bvar\b/.test(readFileSync(new URL("../stats.js", import.meta.url), "utf8")));
});
