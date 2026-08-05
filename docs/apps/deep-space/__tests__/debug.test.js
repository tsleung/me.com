import test from "node:test";
import assert from "node:assert/strict";

import { buildDebugReport, redact, debugFilename } from "../debug.js";

// Deliberately fabricated, and deliberately ASSEMBLED rather than written out.
//
// These tests need a string that matches `debug.js`'s KEY_PATTERN, or they
// cannot prove redaction works. But this file ships to a public repo, and a
// literal in Google's key shape is a literal a secret scanner will flag:
// the previous spelling of this constant opened a "publicly leaked secret"
// alert on me.com within 12 hours of deploy (github.com/tsleung/me.com,
// secret-scanning alert #1 — a false positive on this very fixture).
//
// Concatenating means no contiguous key-shaped run exists in the source while
// the runtime value still matches. Do not "tidy" this back into one string.
const KEY = "AIza" + "FAKEKEYFORTESTSONLY" + "0".repeat(20);

// The report is meant to be handed to someone else. Everything below is about
// making sure that is safe, and that it actually carries what a diagnosis needs.

test("an api key is never carried by name", () => {
  const out = redact({ apiKey: KEY, api_key: KEY, token: KEY, nested: { password: "hunter2" } });
  assert.equal(out.apiKey, "«REDACTED»");
  assert.equal(out.api_key, "«REDACTED»");
  assert.equal(out.token, "«REDACTED»");
  assert.equal(out.nested.password, "«REDACTED»");
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test("a key pasted into free text is caught too", () => {
  // Google echoes the key back in some error bodies; the by-name rule misses that.
  const out = redact({
    recentErrors: [{ message: `API key not valid: ${KEY}. Check it in Settings.` }],
  });
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.match(out.recentErrors[0].message, /«REDACTED-API-KEY»/);
  assert.match(out.recentErrors[0].message, /Check it in Settings/, "surrounding text must survive");
});

test("a key inside a url or a prompt is caught", () => {
  const out = redact([`https://example.test/v1?key=${KEY}`, `header: x-goog-api-key: ${KEY}`]);
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test("redaction does not mangle ordinary values", () => {
  const out = redact({
    n: 42,
    ok: true,
    nothing: null,
    list: ["1420405754", "1420405755"],
    statement: "The hydrogen line frequency is 1420405752 Hz.",
  });
  assert.equal(out.n, 42);
  assert.equal(out.ok, true);
  assert.equal(out.nothing, null);
  assert.deepEqual(out.list, ["1420405754", "1420405755"]);
  assert.equal(out.statement, "The hydrogen line frequency is 1420405752 Hz.");
});

test("undefined becomes null so the report is valid JSON throughout", () => {
  const out = redact({ a: undefined, b: [undefined] });
  assert.equal(out.a, null);
  assert.deepEqual(out.b, [null]);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)));
});

const sampleKb = new Map([
  [
    "num-1",
    {
      id: "num-1",
      kind: "concept",
      subject: "hydrogen line frequency",
      statement: "It is 1420405752 Hz.",
      confidence: "high",
      status: "active",
      supersedes: null,
      level: 3,
      evidence: ["abc"],
    },
  ],
]);

const sampleInput = {
  shot: { hash: "abc", level: 6, note: "the counter went up", markers: [], solved: false },
  entry: {
    readingCached: false,
    readHash: "burned-abc",
    reading: { promptText: "MAP PROMPT TEXT", transmissionContent: ["1420405754"] },
    answer: {
      promptText: "ANSWER PROMPT TEXT",
      rawText: '{"summary":"..."}',
      thoughts: "counting the values",
      summary: "a sequence",
      proposedReply: "1420405758",
      hypotheses: [],
      ops: [],
      usage: { totalTokenCount: 8259 },
    },
    pending: { accepted: [{ op: "assert" }], rejected: [{ reason: "duplicate" }], rewritten: [] },
    kbSent: { sent: 8, total: 8 },
    complaints: ["you told me which button to press"],
    feedbackUsed: ["you told me which button to press"],
  },
  kb: sampleKb,
  ops: [{ seq: 1 }, { seq: 2 }],
  skipped: [],
  contradictions: [{ kind: "concept", subject: "x", beliefs: [{ id: "a" }, { id: "b" }] }],
  settings: { apiKey: KEY, model: "gemini-3.5-flash", kbMax: 120, standingNotes: "be terse" },
  errors: [{ at: "t", message: "boom" }],
  promptVersion: 2,
  dbVersion: 2,
  stampedAt: "2026-07-26T20:00:00.000Z",
};

test("the report carries what a diagnosis actually needs", () => {
  const r = buildDebugReport(sampleInput);
  assert.equal(r.calls.map.prompt, "MAP PROMPT TEXT");
  assert.equal(r.calls.answer.prompt, "ANSWER PROMPT TEXT");
  assert.equal(r.calls.answer.rawText, '{"summary":"..."}');
  assert.equal(r.calls.answer.reasoning, "counting the values");
  assert.equal(r.calls.answer.parsed.proposedReply, "1420405758");
  assert.equal(r.knowledgeBase.beliefs.length, 1);
  assert.equal(r.knowledgeBase.beliefs[0].subject, "hydrogen line frequency");
  assert.equal(r.knowledgeBase.opLogLength, 2);
  assert.equal(r.knowledgeBase.contradictions[0].beliefIds.length, 2);
  assert.equal(r.validation.rejected[0].reason, "duplicate");
  assert.equal(r.settings.model, "gemini-3.5-flash");
  assert.equal(r.promptVersion, 2);
  assert.deepEqual(r.complaints, ["you told me which button to press"]);
});

test("the report never contains the key, only whether one was set", () => {
  const r = buildDebugReport(sampleInput);
  assert.equal(r.settings.hasApiKey, true);
  assert.equal(r.settings.apiKey, undefined);
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test("prompt text is not duplicated inside the parsed objects", () => {
  const r = buildDebugReport(sampleInput);
  // Would otherwise double the file for no benefit.
  assert.equal(r.calls.answer.parsed.promptText, null);
  assert.equal(r.calls.map.reading.promptText, null);
});

test("the picture is opt-in", () => {
  const without = buildDebugReport(sampleInput);
  assert.equal(without.screen.imageIncluded, false);
  assert.equal(without.screen.image, null);

  const withImage = buildDebugReport({ ...sampleInput, imageDataUrl: "data:image/png;base64,AAAA" });
  assert.equal(withImage.screen.imageIncluded, true);
  assert.match(withImage.screen.image, /^data:image\/png/);
});

test("survives an empty app — no screen, no answer, no knowledge base", () => {
  const r = buildDebugReport({});
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)));
  assert.equal(r.calls.answer.parsed, null);
  assert.equal(r.knowledgeBase.beliefs.length, 0);
  assert.equal(r.settings.hasApiKey, false);
});

test("filenames are stable, sortable and name the level", () => {
  assert.equal(
    debugFilename({ level: 6 }, "2026-07-26T20:00:00.000Z"),
    "deep-space-debug-level-6-2026-07-26T20-00-00.json",
  );
  assert.match(debugFilename({}, "2026-07-26T20:00:00.000Z"), /level-unknown/);
});
