import test from "node:test";
import assert from "node:assert/strict";
import { sumSquares } from "../stats.js";

test("sumSquares", () => {
  assert.equal(sumSquares([1, 2, 3]), 14);
});
