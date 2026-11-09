import test from "node:test";
import assert from "node:assert/strict";
import { groupBy, countBy } from "../collections.js";

test("groupBy fn", () => {
  assert.deepEqual(groupBy([1, 2, 3, 4], (n) => (n % 2 ? "odd" : "even")), { odd: [1, 3], even: [2, 4] });
});

test("groupBy property", () => {
  const people = [{ t: "a", n: 1 }, { t: "b", n: 2 }, { t: "a", n: 3 }];
  assert.deepEqual(groupBy(people, "t"), { a: [people[0], people[2]], b: [people[1]] });
});

test("countBy", () => {
  assert.deepEqual(countBy(["x", "y", "x"], (s) => s), { x: 2, y: 1 });
  assert.deepEqual(countBy([], (s) => s), {});
});
