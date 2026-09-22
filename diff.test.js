import test from "node:test";
import assert from "node:assert/strict";
import { compareJson, summarize } from "./diff.js";

test("reports added, removed and changed nested fields", () => {
  const changes = compareJson(
    { settings: { old: true, shared: 1 }, items: ["a", "b"] },
    { settings: { shared: 2, new: false }, items: ["a", "c", "d"] }
  );
  assert.deepEqual(summarize(changes), { added: 2, removed: 1, changed: 2 });
  assert.deepEqual(changes.map(({ type, path }) => [type, path]), [
    ["changed", "$.items[1]"],
    ["added", "$.items[2]"],
    ["added", "$.settings.new"],
    ["removed", "$.settings.old"],
    ["changed", "$.settings.shared"]
  ]);
});

test("distinguishes a missing field from a null value", () => {
  assert.deepEqual(compareJson({}, { value: null }), [
    { type: "added", path: "$.value", after: null }
  ]);
});

test("reports container type changes and identical values", () => {
  assert.deepEqual(compareJson({ value: [] }, { value: {} }), [
    { type: "changed", path: "$.value", before: [], after: {} }
  ]);
  assert.deepEqual(compareJson({ a: [1, { b: true }] }, { a: [1, { b: true }] }), []);
});
