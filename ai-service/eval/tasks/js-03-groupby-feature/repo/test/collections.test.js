import test from "node:test";
import assert from "node:assert/strict";
import { first } from "../collections.js";

test("first", () => {
  assert.equal(first([7, 8]), 7);
});
