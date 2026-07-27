import test from "node:test";
import assert from "node:assert/strict";

import { extractJson } from "../gemini.js";

// extractJson is the ONLY parser on the server-side code-execution path:
// Gemini forbids responseSchema when tools:[{codeExecution:{}}] is set, so the
// answer comes back as prose-wrapped JSON and this function is what stands
// between the model and validateOps. It was untested. Every case below is a
// shape a model has plausibly emitted around a JSON answer.

test("parses a clean object", () => {
  assert.deepEqual(extractJson('{"summary":"ok","ops":[]}'), {
    summary: "ok",
    ops: [],
  });
});

test("strips a ```json fence", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test("strips a bare ``` fence", () => {
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
});

test("recovers the object from prose on either side", () => {
  assert.deepEqual(extractJson('Here is the answer:\n{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}\nHope that helps.'), { a: 1 });
});

test("recovers from a fenced block followed by commentary", () => {
  // The trailing-fence strip only fires at end-of-string, so this case falls
  // through to the brace scanner. That is the path that matters most: models
  // routinely add a sentence after the fence.
  assert.deepEqual(extractJson('```json\n{"a":1}\n```\n\nLet me know.'), {
    a: 1,
  });
});

test("brace counting is string-aware", () => {
  assert.deepEqual(extractJson('note {"s":"a } b","t":2} end'), {
    s: "a } b",
    t: 2,
  });
});

test("brace counting respects backslash escapes inside strings", () => {
  const raw = String.raw`x {"s":"he said \"} \"","t":3} y`;
  assert.deepEqual(extractJson(raw), { s: 'he said "} "', t: 3 });
});

test("handles nesting and returns the whole outer object", () => {
  assert.deepEqual(extractJson('noise {"a":{"b":[1,2]},"c":3} noise'), {
    a: { b: [1, 2] },
    c: 3,
  });
});

test("takes the first complete object when several are present", () => {
  assert.deepEqual(extractJson('{"a":1} and then {"b":2}'), { a: 1 });
});

test("returns null rather than throwing on junk", () => {
  assert.equal(extractJson('truncated {"a":1'), null);
  assert.equal(extractJson("no json here at all"), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson(undefined), null);
  assert.equal(extractJson("   "), null);
});

test("a bare JSON null is reported as nothing usable", () => {
  // answerLevel treats a falsy `json` as "not valid JSON" and says so, which
  // is the right outcome — pinned so a future "return the parsed value"
  // refactor cannot turn it into a silently empty answer.
  assert.equal(extractJson("null"), null);
});

test("a top-level array comes back as an array", () => {
  // Documented, not endorsed: normalizeAnswer accepts anything typeof
  // "object", so an array here yields a blank answer instead of an error.
  assert.deepEqual(extractJson('[{"summary":"x"}]'), [{ summary: "x" }]);
});
