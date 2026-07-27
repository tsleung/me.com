import test from "node:test";
import assert from "node:assert/strict";

import { detectRepetitionLoop } from "../gemini.js";

// Observed in real play at level 5: Flash fell into a degeneration loop and
// emitted this until the output cap, burning the whole token budget.
const OBSERVED =
  "Chapter 4. Design and Implementation of the non-commercial configuration " +
  "of automated configuration management architecture ";

test("detects the degeneration loop seen in play", () => {
  const unit = detectRepetitionLoop("Some real answer text first. " + OBSERVED.repeat(10));
  assert.ok(unit, "expected a loop to be detected");
  assert.match(unit, /configuration management architecture/);
});

test("needs the repetition to be at the tail, not merely present", () => {
  // A doc that repeated a heading early but then moved on is not looping.
  const text = OBSERVED.repeat(6) + "x".repeat(2000) + " and then a real, varied conclusion.";
  assert.equal(detectRepetitionLoop(text), null);
});

test("does not fire on ordinary prose", () => {
  const prose =
    "The three-bar glyph is a tally numeral. The dots below count units of the " +
    "same magnitude. Send four bars to answer the successor question, because " +
    "the sequence shown increments by one each transmission.";
  assert.equal(detectRepetitionLoop(prose), null);
});

test("does not fire on legitimately repetitive JSON structure", () => {
  const ops = Array.from({ length: 8 }, (_, i) =>
    JSON.stringify({ op: "assert", kind: "glyph", subject: `g${i}`, statement: `shape ${i}` }),
  ).join(",");
  assert.equal(detectRepetitionLoop(`{"ops":[${ops}]}`), null);
});

test("catches a short unit once it repeats enough to matter", () => {
  assert.ok(detectRepetitionLoop("preamble " + "ab ".repeat(400)));
});

test("tolerates non-strings and empty input", () => {
  assert.equal(detectRepetitionLoop(undefined), null);
  assert.equal(detectRepetitionLoop(null), null);
  assert.equal(detectRepetitionLoop(""), null);
  assert.equal(detectRepetitionLoop(42), null);
});

test("a run just under the threshold is left alone", () => {
  // Four repeats is not yet a loop; five is. The bar was raised deliberately
  // after a real truncation bug produced short degenerate output — a long,
  // legitimate answer must never be mistaken for a loop.
  assert.equal(detectRepetitionLoop("lead-in text " + OBSERVED.repeat(4)), null);
  assert.ok(detectRepetitionLoop("lead-in text " + OBSERVED.repeat(5)));
});
