import test from "node:test";
import assert from "node:assert/strict";
import { capitalize } from "../strings.js";

test("capitalizes words", () => {
  assert.equal(capitalize("hello world"), "Hello World");
});
