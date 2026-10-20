import test from "node:test";
import assert from "node:assert/strict";
import { observe, summarizeDrift } from "./drift.js";

function sequence(responses, options) {
  let state = null;
  return responses.map(response => {
    const result = observe(state, response, options);
    state = result.state;
    return result.changes;
  });
}

test("first response becomes the baseline without changes", () => {
  const result = observe(null, { id: 1 });
  assert.equal(result.baselineCaptured, true);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.state.baseline, { "$": ["object"], "$.id": ["number"] });
});

test("reports a new field once, then treats it as known", () => {
  const [, second, third] = sequence([{ id: 1 }, { id: 1, plan: { tier: "pro" } }, { id: 1, plan: { tier: "pro" } }]);
  assert.deepEqual(second, [{ type: "added", path: "$.plan", after: "object" }]);
  assert.deepEqual(third, []);
});

test("reports a type the field has never had, such as an unexpected null", () => {
  const [, second, third] = sequence([{ amount: 5 }, { amount: null }, { amount: 7 }]);
  assert.deepEqual(second, [{ type: "changed", path: "$.amount", before: "number", after: "null | number" }]);
  assert.deepEqual(third, [], "narrowing back to a known type is not drift");
});

test("a field must be missing for three checks in a row before it is removed", () => {
  const changes = sequence([{ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 }, { a: 1 }, { a: 1 }, { a: 1 }, { a: 1 }]);
  assert.deepEqual(changes.slice(1, 5), [[], [], [], []], "reappearing resets the count");
  assert.deepEqual(changes[5], [{ type: "removed", path: "$.b", before: "number" }]);
  assert.deepEqual(changes[6], [], "a removed field is forgotten after it is reported");
});

test("an empty array does not make its item fields look removed", () => {
  const responses = [{ items: [{ id: 1 }] }, { items: [] }, { items: [] }, { items: [] }, { items: [] }];
  assert.deepEqual(sequence(responses).flat(), []);
});

test("removing a whole object reports only the object", () => {
  const responses = [{ user: { name: "a", tags: ["x"] } }, {}, {}, {}];
  assert.deepEqual(sequence(responses)[3], [{ type: "removed", path: "$.user", before: "object" }]);
});

test("ignored paths never produce changes", () => {
  const changes = sequence([{ meta: { id: "1" } }, { meta: { id: 2, extra: true } }], { ignore: ["$.meta"] });
  assert.deepEqual(changes.flat(), []);
});

test("summarizes changes by kind", () => {
  assert.equal(summarizeDrift([
    { type: "removed" }, { type: "changed" }, { type: "changed" }, { type: "added" }
  ]), "1 removed · 2 new types · 1 added");
});
