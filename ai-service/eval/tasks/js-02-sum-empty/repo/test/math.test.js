import test from "node:test";
import assert from "node:assert/strict";
import { sumNumbers } from "../math.js";

test("sums", () => {
  assert.equal(sumNumbers([1, 2, 3]), 6);
});
