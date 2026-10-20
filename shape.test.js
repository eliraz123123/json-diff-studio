import test from "node:test";
import assert from "node:assert/strict";
import { compileIgnore, diffShapes, inferShape, parentPath } from "./shape.js";

test("infers types per path and merges array items", () => {
  assert.deepEqual(inferShape({ id: 1, tags: ["a"], items: [{ price: 2 }, { price: null, note: "x" }] }), {
    "$": ["object"],
    "$.id": ["number"],
    "$.items": ["array"],
    "$.items[]": ["object"],
    "$.items[].note": ["string"],
    "$.items[].price": ["null", "number"],
    "$.tags": ["array"],
    "$.tags[]": ["string"]
  });
});

test("quotes keys that are not identifiers and finds their parents", () => {
  const shape = inferShape({ "content-type": { "a.b": 1 } });
  assert.deepEqual(Object.keys(shape), ["$", '$["content-type"]', '$["content-type"]["a.b"]']);
  assert.equal(parentPath('$["content-type"]["a.b"]'), '$["content-type"]');
  assert.equal(parentPath("$.items[].id"), "$.items[]");
  assert.equal(parentPath("$.items[]"), "$.items");
  assert.equal(parentPath("$"), null);
});

test("diffShapes reports a removed object once instead of every nested field", () => {
  const before = inferShape({ user: { name: "a", address: { city: "x" } }, total: 1 });
  const after = inferShape({ total: "1" });
  assert.deepEqual(diffShapes(before, after), [
    { type: "changed", path: "$.total", before: "number", after: "string" },
    { type: "removed", path: "$.user", before: "object" }
  ]);
});

test("ignore patterns cover descendants and support one-segment wildcards", () => {
  const ignored = compileIgnore(["$.meta", "$.rates.*"]);
  assert.equal(ignored("$.meta"), true);
  assert.equal(ignored("$.meta.requestId"), true);
  assert.equal(ignored("$.metadata"), false);
  assert.equal(ignored("$.rates.USD"), true);
  assert.equal(ignored("$.rates.USD.value"), true);
  assert.equal(ignored("$.rates"), false);
  assert.equal(compileIgnore(["$.byId.*.name"])('$.byId["8f3a-11"].name'), true, "wildcards match quoted keys");
});

test("a pathological ignore pattern is treated literally and matches instantly", () => {
  const started = Date.now();
  assert.equal(compileIgnore(["$." + "*".repeat(290) + "z"])("$." + "a".repeat(40)), false);
  assert.ok(Date.now() - started < 50);
});
