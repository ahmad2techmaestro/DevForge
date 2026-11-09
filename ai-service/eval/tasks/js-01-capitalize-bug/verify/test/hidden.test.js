import test from "node:test";
import assert from "node:assert/strict";
import { capitalize } from "../strings.js";

test("mixed case", () => {
  assert.equal(capitalize("hELLO wORLD"), "Hello World");
});

test("empty", () => {
  assert.equal(capitalize(""), "");
});

test("single letters", () => {
  assert.equal(capitalize("a b c"), "A B C");
});
