import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BELIEF_KINDS,
  CONFIDENCES,
  normalizeStatement,
  validateOps,
  foldOps,
  foldOpsDetailed,
  remapOpIds,
  detectContradictions,
  findDuplicate,
  serializeKb,
  kbStats,
  nextBeliefId,
} from "../kb.js";

// --- helpers --------------------------------------------------------------

const assertOp = (over = {}) => ({
  op: "assert",
  kind: "numeral",
  subject: "three dots",
  statement: "means the value 3",
  confidence: "medium",
  evidence: ["hashA"],
  level: 4,
  ...over,
});

const ids = (kb) => [...kb.keys()];
const active = (kb) => [...kb.values()].filter((b) => b.status === "active");

// --- constants ------------------------------------------------------------

test("belief kinds and confidences are the agreed vocabulary", () => {
  assert.deepEqual(BELIEF_KINDS, [
    "numeral",
    "glyph",
    "operator",
    "grammar",
    "mechanic",
    "concept",
    "recipe",
  ]);
  assert.deepEqual(CONFIDENCES, ["low", "medium", "high"]);
});

// --- normalizeStatement ---------------------------------------------------

test("normalizeStatement: lowercases, collapses whitespace, strips punctuation", () => {
  assert.equal(
    normalizeStatement("  The   Glyph, MEANS:  three.  "),
    "the glyph means three",
  );
});

test("normalizeStatement: punctuation-only differences collapse together", () => {
  assert.equal(
    normalizeStatement("base-12, positional"),
    normalizeStatement("Base 12 positional!"),
  );
});

test("normalizeStatement: hyphen becomes a break, not a join", () => {
  assert.equal(normalizeStatement("base-12"), "base 12");
});

test("normalizeStatement: symbols survive so glyphs stay distinguishable", () => {
  assert.notEqual(normalizeStatement("◇"), normalizeStatement("○"));
  assert.equal(normalizeStatement("◇"), "◇");
});

test("normalizeStatement: symbol spacing is normalized", () => {
  assert.equal(normalizeStatement("1+1=2"), normalizeStatement("1 + 1 = 2"));
});

test("normalizeStatement: nullish and non-string input is empty/stringified", () => {
  assert.equal(normalizeStatement(null), "");
  assert.equal(normalizeStatement(undefined), "");
  assert.equal(normalizeStatement(""), "");
  assert.equal(normalizeStatement("   "), "");
  assert.equal(normalizeStatement(12), "12");
});

test("normalizeStatement: newlines and tabs are whitespace", () => {
  assert.equal(normalizeStatement("a\n\tb\r\nc"), "a b c");
});

// --- nextBeliefId ---------------------------------------------------------

test("nextBeliefId: deterministic, derived from kind + count", () => {
  const empty = new Map();
  assert.equal(nextBeliefId(empty, "numeral"), "num-1");
  assert.equal(nextBeliefId(empty, "numeral"), "num-1");
  const kb = foldOps([assertOp(), assertOp({ subject: "four dots" })]);
  assert.equal(nextBeliefId(kb, "numeral"), "num-3");
  assert.equal(nextBeliefId(kb, "glyph"), "gly-1");
});

test("nextBeliefId: a hole in the numbering is not reissued", () => {
  const kb = foldOps([assertOp({ id: "num-1" }), assertOp({ id: "num-7", subject: "four dots" })]);
  assert.equal(nextBeliefId(kb, "numeral"), "num-8");
});

test("nextBeliefId: an active-only view still clears the highest id it can see", () => {
  const kb = foldOps([
    assertOp(),
    assertOp({ subject: "four dots", statement: "means 4" }),
    { op: "retract", target: "num-1" },
  ]);
  const activeOnly = [...kb.values()].filter((b) => b.status === "active");
  assert.equal(nextBeliefId(activeOnly, "numeral"), "num-3");
});

test("nextBeliefId: unknown kind still yields a stable prefix", () => {
  const id = nextBeliefId(new Map(), "sigil");
  assert.equal(id, "sig-1");
  assert.equal(nextBeliefId(new Map(), "sigil"), id);
});

// --- foldOps: assert ------------------------------------------------------

test("foldOps: an assert becomes an active belief with provenance", () => {
  const kb = foldOps([assertOp()]);
  assert.equal(kb.size, 1);
  const b = kb.get("num-1");
  assert.equal(b.kind, "numeral");
  assert.equal(b.subject, "three dots");
  assert.equal(b.statement, "means the value 3");
  assert.equal(b.confidence, "medium");
  assert.equal(b.status, "active");
  assert.deepEqual(b.evidence, ["hashA"]);
  assert.equal(b.supersedes, null);
  assert.equal(b.level, 4);
  assert.equal(b.seq, 0);
});

test("foldOps: a model-supplied id is honoured", () => {
  const kb = foldOps([assertOp({ id: "b1" })]);
  assert.deepEqual(ids(kb), ["b1"]);
});

test("foldOps: colliding ids are suffixed, never overwritten", () => {
  const kb = foldOps([
    assertOp({ id: "b1" }),
    assertOp({ id: "b1", subject: "four dots", statement: "means 4" }),
  ]);
  assert.deepEqual(ids(kb), ["b1", "b1#2"]);
  assert.equal(kb.get("b1").subject, "three dots");
  assert.equal(kb.get("b1#2").subject, "four dots");
});

test("foldOps: a statement-less assert is inert", () => {
  assert.equal(foldOps([assertOp({ statement: "  " })]).size, 0);
});

test("foldOps: non-array and junk input folds to an empty KB", () => {
  assert.equal(foldOps(null).size, 0);
  assert.equal(foldOps(undefined).size, 0);
  assert.equal(foldOps([null, 7, "x", {}, { op: "nope" }]).size, 0);
});

// --- foldOps: revise ------------------------------------------------------

test("foldOps: revise retires the target and creates a superseding belief", () => {
  const kb = foldOps([
    assertOp(),
    {
      op: "revise",
      target: "num-1",
      statement: "means the value 4, not 3",
      confidence: "high",
      evidence: ["hashB"],
      level: 7,
      reason: "level 7 disproved it",
    },
  ]);
  const old = kb.get("num-1");
  assert.equal(old.status, "retracted");
  assert.equal(old.reason, "level 7 disproved it");

  const next = kb.get("num-1.2");
  assert.equal(next.status, "active");
  assert.equal(next.supersedes, "num-1");
  assert.equal(next.kind, "numeral", "kind is inherited from the target");
  assert.equal(next.subject, "three dots", "subject is inherited from the target");
  assert.equal(next.statement, "means the value 4, not 3");
  assert.equal(next.confidence, "high");
  assert.equal(next.level, 7);
  assert.deepEqual(next.evidence, ["hashA", "hashB"], "provenance accumulates");
  assert.equal(active(kb).length, 1);
});

test("foldOps: a revise chain stays flat and legible", () => {
  const kb = foldOps([
    assertOp(),
    { op: "revise", target: "num-1", statement: "means 4" },
    { op: "revise", target: "num-1.2", statement: "means 5" },
    { op: "revise", target: "num-1.3", statement: "means 6" },
  ]);
  assert.deepEqual(ids(kb), ["num-1", "num-1.2", "num-1.3", "num-1.4"]);
  const live = active(kb);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, "num-1.4");
  assert.equal(live[0].statement, "means 6");
  assert.equal(live[0].supersedes, "num-1.3");
});

test("foldOps: revise inherits confidence and level when the op omits them", () => {
  const kb = foldOps([assertOp(), { op: "revise", target: "num-1", statement: "means 4" }]);
  const next = kb.get("num-1.2");
  assert.equal(next.confidence, "medium");
  assert.equal(next.level, 4);
});

test("foldOps: revise against an unknown target changes nothing", () => {
  const kb = foldOps([assertOp(), { op: "revise", target: "ghost-9", statement: "x" }]);
  assert.equal(kb.size, 1);
  assert.equal(kb.get("num-1").status, "active");
});

test("foldOps: retiring the target does not reorder the KB", () => {
  const kb = foldOps([
    assertOp(),
    assertOp({ kind: "glyph", subject: "spiral", statement: "marks a question" }),
    { op: "revise", target: "num-1", statement: "means 4" },
  ]);
  assert.deepEqual(ids(kb), ["num-1", "gly-1", "num-1.2"]);
});

// --- foldOps: retract -----------------------------------------------------

test("foldOps: retract flips status without deleting history", () => {
  const kb = foldOps([
    assertOp(),
    { op: "retract", target: "num-1", reason: "misread the screen", level: 6 },
  ]);
  assert.equal(kb.size, 1);
  const b = kb.get("num-1");
  assert.equal(b.status, "retracted");
  assert.equal(b.reason, "misread the screen");
  assert.equal(b.statement, "means the value 3", "history is intact");
  assert.equal(active(kb).length, 0);
});

test("foldOps: retract against an unknown target changes nothing", () => {
  const kb = foldOps([assertOp(), { op: "retract", target: "ghost-9" }]);
  assert.equal(kb.get("num-1").status, "active");
});

// --- determinism / re-reduce ---------------------------------------------

const bigLog = [
  assertOp(),
  assertOp({ kind: "glyph", subject: "spiral", statement: "marks a question" }),
  assertOp({ kind: "operator", subject: "double bar", statement: "equality" }),
  { op: "revise", target: "num-1", statement: "means 4", evidence: ["hashC"], level: 9 },
  assertOp({ kind: "mechanic", subject: "left dial", statement: "cycles the digit" }),
  { op: "retract", target: "gly-1", reason: "it was a cursor artifact" },
  assertOp({ kind: "recipe", subject: "level 9 reply", statement: "send 4 then equality" }),
  { op: "revise", target: "num-1.2", statement: "means 4 in base 12" },
];

test("foldOps: same log in, identical KB out (re-reduce is a pure fold)", () => {
  const a = foldOps(bigLog);
  const b = foldOps(bigLog);
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test("foldOps: re-folding a structurally identical copy of the log matches", () => {
  const copy = JSON.parse(JSON.stringify(bigLog));
  assert.deepEqual([...foldOps(bigLog).entries()], [...foldOps(copy).entries()]);
});

test("foldOps: folding is prefix-stable — replaying is not order-sensitive noise", () => {
  const whole = foldOps(bigLog);
  const prefix = foldOps(bigLog.slice(0, 4));
  for (const [id, b] of prefix) {
    if (b.status === "active" && whole.has(id)) {
      assert.equal(whole.get(id).kind, b.kind);
      assert.equal(whole.get(id).seq, b.seq);
    }
  }
  assert.equal(whole.get("num-1").seq, 0);
});

test("foldOps: no id is ever reused across a full log", () => {
  const kb = foldOps(bigLog);
  assert.equal(new Set(ids(kb)).size, kb.size);
});

// --- foldOps: legality matches validateOps --------------------------------

test("foldOps: a revise cannot resurrect a belief the user withdrew", () => {
  const kb = foldOps([
    assertOp(),
    { op: "retract", target: "num-1", reason: "misread" },
    { op: "revise", target: "num-1", statement: "means 4" },
  ]);
  assert.equal(kb.size, 1, "no superseding belief is created");
  assert.equal(kb.get("num-1").status, "retracted");
  assert.equal(active(kb).length, 0);
});

test("foldOps: revising the same target twice does not fork the chain", () => {
  const kb = foldOps([
    assertOp(),
    { op: "revise", target: "num-1", statement: "means 4" },
    { op: "revise", target: "num-1", statement: "means 5" },
  ]);
  const live = active(kb);
  assert.equal(live.length, 1);
  assert.equal(live[0].statement, "means 4");
});

test("foldOps: retracting twice keeps the first reason", () => {
  const kb = foldOps([
    assertOp(),
    { op: "retract", target: "num-1", reason: "misread the screen" },
    { op: "retract", target: "num-1", reason: "" },
  ]);
  assert.equal(kb.get("num-1").reason, "misread the screen");
});

test("foldOps: the op verb is case-insensitive like every other field", () => {
  const kb = foldOps([assertOp({ op: "Assert" }), { op: "RETRACT", target: "num-1" }]);
  assert.equal(kb.get("num-1").status, "retracted");
});

test("foldOpsDetailed: an op that cannot be applied is reported, not just dropped", () => {
  const { kb, skipped } = foldOpsDetailed([
    assertOp(),
    { op: "revise", target: "ghost-9", statement: "x" },
    { op: "retract", target: "num-1" },
    { op: "retract", target: "num-1" },
    "junk",
  ]);
  assert.equal(kb.size, 1);
  assert.deepEqual(
    skipped.map((s) => [s.index, s.reason]),
    [
      [1, "unknown-target"],
      [3, "already-retracted"],
      [4, "malformed"],
    ],
  );
});

test("foldOpsDetailed: a clean log skips nothing", () => {
  assert.deepEqual(foldOpsDetailed(bigLog).skipped, []);
});

test("foldOps: a subject-less assert is not a contradiction with every other one", () => {
  const kb = foldOps([
    { op: "assert", statement: "the dial cycles" },
    { op: "assert", statement: "the dial is decorative" },
    { op: "assert", statement: "the dial is a clock" },
  ]);
  assert.equal(active(kb).length, 3);
  assert.deepEqual(detectContradictions(kb), []);
});

// --- remapOpIds: merging a foreign log ------------------------------------

test("remapOpIds: an imported log cannot reach a local belief", () => {
  const local = [assertOp({ subject: "three dots" }), { op: "revise", target: "num-1", statement: "means 4" }];
  const foreign = [
    assertOp({ subject: "spiral pair", statement: "means 9" }),
    { op: "retract", target: "num-1", reason: "cursor artifact" },
  ];
  const merged = foldOps([...local, ...remapOpIds(foreign, "imp1")]);
  const live = active(merged).map((b) => b.subject).sort();
  assert.deepEqual(live, ["three dots"], "the imported belief stays withdrawn");
  assert.equal(merged.get("num-1.2").status, "active", "the local chain is untouched");
});

test("remapOpIds: the imported log still folds as its author intended", () => {
  const foreign = [
    assertOp({ subject: "spiral", statement: "means 9" }),
    { op: "revise", target: "num-1", statement: "means 10" },
  ];
  const kb = foldOps(remapOpIds(foreign, "imp1"));
  const live = active(kb);
  assert.equal(live.length, 1);
  assert.equal(live[0].statement, "means 10");
  assert.equal(live[0].id, "imp1:num-1.2");
  assert.equal(live[0].supersedes, "imp1:num-1");
});

test("remapOpIds: two imports of the same log do not collide", () => {
  const foreign = [assertOp({ subject: "spiral", statement: "means 9" })];
  const kb = foldOps([...remapOpIds(foreign, "imp1"), ...remapOpIds(foreign, "imp2")]);
  assert.deepEqual(ids(kb), ["imp1:num-1", "imp2:num-1"]);
});

test("remapOpIds: junk and unknown verbs pass through untouched", () => {
  const ops = [null, "x", { op: "nope", target: "num-1" }];
  assert.deepEqual(remapOpIds(ops, "imp1"), ops);
});

// --- findDuplicate --------------------------------------------------------

test("findDuplicate: matches on kind + subject + normalized statement", () => {
  const kb = foldOps([assertOp()]);
  const hit = findDuplicate(kb, assertOp({ statement: "Means the value 3." }));
  assert.equal(hit && hit.id, "num-1");
});

test("findDuplicate: subject comparison is normalized too", () => {
  const kb = foldOps([assertOp()]);
  assert.ok(findDuplicate(kb, assertOp({ subject: "  Three Dots! " })));
});

test("findDuplicate: a different kind is not a duplicate", () => {
  const kb = foldOps([assertOp()]);
  assert.equal(findDuplicate(kb, assertOp({ kind: "glyph" })), null);
});

test("findDuplicate: retracted beliefs do not shadow new asserts", () => {
  const kb = foldOps([assertOp(), { op: "retract", target: "num-1" }]);
  assert.equal(findDuplicate(kb, assertOp()), null);
});

test("findDuplicate: an empty statement never matches", () => {
  const kb = foldOps([assertOp()]);
  assert.equal(findDuplicate(kb, assertOp({ statement: "" })), null);
  assert.equal(findDuplicate(kb, null), null);
});

// --- validateOps: asserts -------------------------------------------------

test("validateOps: a clean assert is accepted and normalized", () => {
  const r = validateOps([assertOp({ subject: "  three dots ", confidence: "HIGH" })], new Map());
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.accepted[0].subject, "three dots");
  assert.equal(r.accepted[0].confidence, "high");
});

test("validateOps: an unusable confidence degrades to low rather than failing", () => {
  const r = validateOps([assertOp({ confidence: "very sure" })], new Map());
  assert.equal(r.accepted[0].confidence, "low");
});

test("validateOps: malformed ops are rejected, never dropped", () => {
  const junk = [null, 7, {}, { op: "explode" }, { op: "assert" }];
  const r = validateOps(junk, new Map());
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.length, junk.length, "every input is accounted for");
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ["malformed", "malformed", "malformed", "unknown-op", "unknown-kind"],
  );
});

test("validateOps: an invented kind is rejected", () => {
  const r = validateOps([assertOp({ kind: "sigil" })], new Map());
  assert.equal(r.rejected[0].reason, "unknown-kind");
});

test("validateOps: missing subject and missing statement are distinct rejections", () => {
  const r = validateOps([assertOp({ subject: "" }), assertOp({ statement: "  " })], new Map());
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ["missing-subject", "missing-statement"],
  );
});

test("validateOps: a near-duplicate assert is rejected as 'duplicate'", () => {
  const kb = foldOps([assertOp()]);
  const r = validateOps([assertOp({ statement: "MEANS the value 3!!" })], kb);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, "duplicate");
  assert.equal(r.rejected[0].existing, "num-1");
});

test("validateOps: duplicates within one batch are caught too", () => {
  const r = validateOps([assertOp(), assertOp({ statement: "means the value 3" })], new Map());
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected[0].reason, "duplicate");
});

test("validateOps: re-running the same batch adds nothing the second time", () => {
  const batch = [assertOp(), assertOp({ kind: "glyph", subject: "spiral", statement: "question" })];
  const kb = foldOps(validateOps(batch, new Map()).accepted);
  const second = validateOps(batch, kb);
  assert.equal(second.accepted.length, 0, "KB does not grow linearly with re-assertion");
  assert.equal(second.rejected.length, 2);
});

// --- validateOps: revise / retract ----------------------------------------

test("validateOps: a revise pointed at a live belief is accepted", () => {
  const kb = foldOps([assertOp()]);
  const r = validateOps([{ op: "revise", target: "num-1", statement: "means 4" }], kb);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.rewritten.length, 0);
  assert.equal(r.accepted[0].confidence, "medium", "inherits the target's confidence");
});

test("validateOps: a hallucinated revise target is rejected AND rewritten as an assert", () => {
  const kb = foldOps([assertOp()]);
  const bad = {
    op: "revise",
    target: "num-77",
    statement: "the base is 12",
    confidence: "high",
    evidence: ["hashZ"],
    level: 9,
  };
  const r = validateOps([bad], kb);
  assert.equal(r.accepted.length, 0, "nothing is applied");
  assert.equal(r.rejected[0].reason, "unknown-target");
  assert.equal(r.rejected[0].op, bad, "the original op is preserved verbatim");
  assert.equal(r.rewritten.length, 1);
  assert.equal(r.rewritten[0].from, bad);
  assert.equal(r.rewritten[0].reason, "unknown-target");
  assert.equal(r.rewritten[0].to.op, "assert");
  assert.equal(r.rewritten[0].to.statement, "the base is 12");
  assert.equal(r.rewritten[0].to.subject, "num-77", "falls back to the target id");
  assert.equal(r.rewritten[0].to.kind, "concept");
  assert.equal(r.rewritten[0].to.confidence, "high");
  assert.equal(r.rewritten[0].to.id, undefined, "proposals carry no id");
});

test("validateOps: a rewrite borrows kind/subject from a retracted target", () => {
  const kb = foldOps([assertOp(), { op: "retract", target: "num-1" }]);
  const r = validateOps([{ op: "revise", target: "num-1", statement: "means 4" }], kb);
  assert.equal(r.rejected[0].reason, "target-retracted");
  assert.equal(r.rewritten.length, 1);
  assert.equal(r.rewritten[0].to.kind, "numeral");
  assert.equal(r.rewritten[0].to.subject, "three dots");
});

test("validateOps: a rewrite honours an explicit kind hint on the op", () => {
  const r = validateOps(
    [{ op: "revise", target: "gone-1", statement: "spiral is a question mark", kind: "glyph" }],
    new Map(),
  );
  assert.equal(r.rewritten[0].to.kind, "glyph");
});

test("validateOps: a revise with no statement is rejected without a rewrite", () => {
  const kb = foldOps([assertOp()]);
  const r = validateOps([{ op: "revise", target: "num-1" }], kb);
  assert.equal(r.rejected[0].reason, "missing-statement");
  assert.equal(r.rewritten.length, 0);
});

test("validateOps: a retract of an unknown target rewrites its reason into an assert", () => {
  const r = validateOps(
    [{ op: "retract", target: "ghost-3", reason: "the dial is decorative" }],
    new Map(),
  );
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0].reason, "unknown-target");
  assert.equal(r.rewritten.length, 1);
  assert.equal(r.rewritten[0].to.statement, "the dial is decorative");
});

test("validateOps: a bare retract of an unknown target is rejected with nothing to propose", () => {
  const r = validateOps([{ op: "retract", target: "ghost-3" }], new Map());
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, "unknown-target");
  assert.equal(r.rewritten.length, 0);
});

test("validateOps: retracting twice is reported, not applied twice", () => {
  const kb = foldOps([assertOp(), { op: "retract", target: "num-1" }]);
  const r = validateOps([{ op: "retract", target: "num-1" }], kb);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0].reason, "already-retracted");
});

test("validateOps: a missing target is its own rejection reason", () => {
  const r = validateOps([{ op: "revise", statement: "x" }, { op: "retract" }], new Map());
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ["missing-target", "missing-target"],
  );
});

test("validateOps: a batch may assert then revise what it just asserted", () => {
  const r = validateOps(
    [assertOp({ id: "num-1" }), { op: "revise", target: "num-1", statement: "means 4" }],
    new Map(),
  );
  assert.equal(r.accepted.length, 2);
  assert.equal(r.rejected.length, 0);
  const kb = foldOps(r.accepted);
  assert.equal(active(kb).length, 1);
  assert.equal(active(kb)[0].statement, "means 4");
});

test("validateOps: accepted ops fold cleanly and every input is accounted for", () => {
  const kb = foldOps([assertOp()]);
  const batch = [
    assertOp({ kind: "glyph", subject: "spiral", statement: "question" }),
    assertOp({ statement: "means the value 3" }),
    { op: "revise", target: "nope", statement: "base 12" },
    { op: "retract", target: "num-1", reason: "wrong" },
    "junk",
  ];
  const r = validateOps(batch, kb);
  assert.equal(r.accepted.length + r.rejected.length, batch.length);
  assert.doesNotThrow(() => foldOps([...r.accepted]));
});

test("validateOps: tolerates a bare op object and non-array input", () => {
  assert.equal(validateOps(assertOp(), new Map()).accepted.length, 1);
  assert.deepEqual(validateOps(null, new Map()), {
    accepted: [],
    rejected: [],
    rewritten: [],
  });
});

test("validateOps: a JSON string of ops is recovered, not discarded", () => {
  const r = validateOps(JSON.stringify([assertOp()]), new Map());
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 0);
});

test("validateOps: input that is neither ops nor parseable is rejected, never ignored", () => {
  for (const junk of ["not json", 7, true]) {
    const r = validateOps(junk, new Map());
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected.length, 1, `${junk} must be accounted for`);
    assert.equal(r.rejected[0].reason, "malformed");
  }
});

test("validateOps: a capitalized verb is understood, not rejected", () => {
  const r = validateOps([assertOp({ op: "Assert" })], new Map());
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].op, "assert");
});

test("validateOps: a revise may correct the subject, and the correction survives", () => {
  const kb = foldOps([assertOp()]);
  const r = validateOps(
    [{ op: "revise", target: "num-1", subject: "four dots", statement: "means 4" }],
    kb,
  );
  assert.equal(r.accepted[0].subject, "four dots");
  const next = foldOps([assertOp(), r.accepted[0]]);
  assert.equal(next.get("num-1.2").subject, "four dots");
});

test("validateOps: does not mutate the KB it is validating against", () => {
  const kb = foldOps([assertOp()]);
  const before = JSON.stringify([...kb.entries()]);
  validateOps(
    [assertOp({ kind: "glyph", subject: "x", statement: "y" }), { op: "retract", target: "num-1" }],
    kb,
  );
  assert.equal(JSON.stringify([...kb.entries()]), before);
});

// --- contradictions -------------------------------------------------------

test("detectContradictions: same kind + subject, differing statements", () => {
  const kb = foldOps([
    assertOp({ id: "a", statement: "means the value 3" }),
    assertOp({ id: "b", statement: "means the value 4" }),
  ]);
  const c = detectContradictions(kb);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "numeral");
  assert.equal(c[0].subject, "three dots");
  assert.deepEqual(
    c[0].beliefs.map((b) => b.id),
    ["a", "b"],
  );
});

test("detectContradictions: agreement is not a contradiction", () => {
  const kb = foldOps([
    assertOp({ id: "a", statement: "means the value 3" }),
    assertOp({ id: "b", statement: "Means the value 3!" }),
  ]);
  assert.equal(detectContradictions(kb).length, 0);
});

test("detectContradictions: a different subject is not a contradiction", () => {
  const kb = foldOps([
    assertOp({ id: "a" }),
    assertOp({ id: "b", subject: "four dots", statement: "means the value 4" }),
  ]);
  assert.equal(detectContradictions(kb).length, 0);
});

test("detectContradictions: revise resolves rather than accumulates", () => {
  const kb = foldOps([assertOp(), { op: "revise", target: "num-1", statement: "means 4" }]);
  assert.equal(detectContradictions(kb).length, 0);
});

test("detectContradictions: retracting one side clears the queue", () => {
  const kb = foldOps([
    assertOp({ id: "a", statement: "means the value 3" }),
    assertOp({ id: "b", statement: "means the value 4" }),
    { op: "retract", target: "b", reason: "adjudicated" },
  ]);
  assert.equal(detectContradictions(kb).length, 0);
});

test("detectContradictions: three-way disagreement yields every pair", () => {
  const kb = foldOps([
    assertOp({ id: "a", statement: "means 3" }),
    assertOp({ id: "b", statement: "means 4" }),
    assertOp({ id: "c", statement: "means 5" }),
  ]);
  const pairs = detectContradictions(kb).map((c) => c.beliefs.map((b) => b.id).join("/"));
  assert.deepEqual(pairs, ["a/b", "a/c", "b/c"]);
});

test("detectContradictions: deterministic across repeated calls", () => {
  const kb = foldOps([
    assertOp({ id: "a", statement: "means 3" }),
    assertOp({ id: "b", statement: "means 4" }),
  ]);
  assert.deepEqual(detectContradictions(kb), detectContradictions(kb));
});

// --- serializeKb ----------------------------------------------------------

test("serializeKb: empty KB is stated plainly (the run-without-KB path)", () => {
  assert.equal(serializeKb(new Map()), "(knowledge base is empty)");
  assert.equal(serializeKb(null), "(knowledge base is empty)");
});

test("serializeKb: one line per belief, with id and confidence for revise targeting", () => {
  const kb = foldOps([assertOp()]);
  const out = serializeKb(kb);
  assert.equal(out, "KB (1 active belief)\n# numeral\nnum-1 (medium) [L4] three dots: means the value 3");
});

test("serializeKb: retracted beliefs are excluded from the prompt", () => {
  const kb = foldOps([assertOp(), { op: "retract", target: "num-1" }]);
  assert.equal(serializeKb(kb), "(knowledge base is empty)");
});

test("serializeKb: revised beliefs show only the surviving statement", () => {
  const kb = foldOps([assertOp(), { op: "revise", target: "num-1", statement: "means 4" }]);
  const out = serializeKb(kb);
  assert.ok(out.includes("num-1.2"));
  assert.ok(!out.includes("means the value 3"));
});

test("serializeKb: grouped by kind in canonical order", () => {
  const kb = foldOps([
    assertOp({ kind: "recipe", subject: "l9", statement: "send 4" }),
    assertOp({ kind: "glyph", subject: "spiral", statement: "question" }),
    assertOp(),
  ]);
  const headers = serializeKb(kb)
    .split("\n")
    .filter((l) => l.startsWith("# "));
  assert.deepEqual(headers, ["# numeral", "# glyph", "# recipe"]);
});

test("serializeKb: includeLow=false drops low-confidence noise", () => {
  const kb = foldOps([
    assertOp({ confidence: "low" }),
    assertOp({ kind: "glyph", subject: "spiral", statement: "question", confidence: "high" }),
  ]);
  const out = serializeKb(kb, { includeLow: false });
  assert.ok(!out.includes("three dots"));
  assert.ok(out.includes("spiral"));
});

test("serializeKb: maxEntries keeps the highest-confidence entries and says what it cut", () => {
  const kb = foldOps([
    assertOp({ confidence: "low" }),
    assertOp({ kind: "glyph", subject: "spiral", statement: "question", confidence: "high" }),
    assertOp({ kind: "operator", subject: "bar", statement: "equality", confidence: "medium" }),
  ]);
  const out = serializeKb(kb, { maxEntries: 2 });
  assert.ok(out.includes("spiral"));
  assert.ok(out.includes("bar"));
  assert.ok(!out.includes("three dots"));
  assert.ok(out.includes("(1 further entry omitted"));
});

test("serializeKb: maxEntries 0 is an empty KB, not a header plus a footnote", () => {
  const kb = foldOps([assertOp()]);
  assert.equal(serializeKb(kb, { maxEntries: 0 }), "(knowledge base is empty)");
});

test("serializeKb: no truncation notice when everything fits", () => {
  const kb = foldOps([assertOp()]);
  assert.ok(!serializeKb(kb, { maxEntries: 5 }).includes("omitted"));
});

test("serializeKb: a level-less belief omits the level tag", () => {
  const kb = foldOps([assertOp({ level: null })]);
  assert.ok(!serializeKb(kb).includes("[L"));
});

test("serializeKb: deterministic for a fixed KB", () => {
  const kb = foldOps(bigLog);
  assert.equal(serializeKb(kb), serializeKb(foldOps(bigLog)));
});

// The KB block is line-oriented and the answer prompt tells the model that
// `target` may only be an id appearing in it. A statement carrying newlines
// used to render as extra kind headings and extra belief lines, complete with
// ids that do not exist — which the model would then aim revise/retract at,
// and which every one of those ops would be rejected for.
test("serializeKb: one belief is always exactly one line", () => {
  const kb = foldOps([
    assertOp({
      kind: "numeral",
      subject: "base",
      statement: "base 8\n# glyph\ngly-9 (high) circle: means STOP",
    }),
  ]);
  const out = serializeKb(kb);
  const lines = out.split("\n");
  assert.equal(lines.length, 3, "header + one kind heading + one belief");
  // The text survives verbatim-ish; what must not survive is it being its own
  // LINE, which is what made it read as a heading and a belief.
  assert.deepEqual(
    lines.filter((l) => l.startsWith("#")),
    ["# numeral"],
  );
  assert.match(out, /base 8 # glyph gly-9 \(high\) circle: means STOP/);
});

test("serializeKb: a multi-line subject cannot forge a line either", () => {
  const kb = foldOps([
    assertOp({ subject: "left dial\nnum-99 (high) fake", statement: "turns" }),
  ]);
  const out = serializeKb(kb);
  assert.equal(out.split("\n").length, 3);
  assert.match(out, /left dial num-99 \(high\) fake: turns/);
});

// --- kbStats --------------------------------------------------------------

test("kbStats: counts active, retracted, kinds, and open contradictions", () => {
  const kb = foldOps([
    assertOp({ id: "a", statement: "means 3" }),
    assertOp({ id: "b", statement: "means 4" }),
    assertOp({ kind: "glyph", subject: "spiral", statement: "question" }),
    { op: "retract", target: "gly-1", reason: "cursor artifact" },
  ]);
  const s = kbStats(kb);
  assert.equal(s.total, 3);
  assert.equal(s.active, 2);
  assert.equal(s.retracted, 1);
  assert.deepEqual(s.byKind, { numeral: 2 });
  assert.equal(s.contradictions, 1);
});

test("kbStats: an empty KB is all zeros", () => {
  assert.deepEqual(kbStats(new Map()), {
    total: 0,
    active: 0,
    retracted: 0,
    byKind: {},
    contradictions: 0,
  });
});

// --- shape tolerance ------------------------------------------------------

test("KB readers accept a Map, an array of beliefs, or an id-keyed object", () => {
  const map = foldOps([assertOp()]);
  const arr = [...map.values()];
  const obj = Object.fromEntries(map);
  assert.equal(serializeKb(arr), serializeKb(map));
  assert.equal(serializeKb(obj), serializeKb(map));
  assert.deepEqual(kbStats(arr), kbStats(map));
  assert.ok(findDuplicate(arr, assertOp()));
  assert.equal(validateOps([assertOp()], arr).rejected[0].reason, "duplicate");
});

test("KB readers keep fold order through an object round trip, integer-like ids and all", () => {
  const map = foldOps([
    assertOp({ id: "10", statement: "means 10" }),
    assertOp({ id: "2", subject: "two dots", statement: "means 2" }),
  ]);
  assert.equal(serializeKb(Object.fromEntries(map)), serializeKb(map));
  assert.deepEqual(
    detectContradictions(Object.fromEntries(map)),
    detectContradictions(map),
  );
});

// A belief is re-sent in every later prompt, so a degenerate field is not just
// ugly — it costs tokens forever and crowds out real beliefs. Seen live: a
// revise whose `reason` was 4,000 characters of repeated word salad.
test("absurdly long fields are capped rather than stored whole", async () => {
  const { MAX_FIELD_CHARS } = await import("../kb.js");
  const junk = "sequential mappings sequential list values ".repeat(200);
  const kb = foldOps([
    {
      op: "assert",
      kind: "concept",
      subject: "channel index",
      statement: junk,
      confidence: "high",
      level: 6,
    },
  ]);
  const belief = [...kb.values()][0];
  assert.ok(belief.statement.length <= MAX_FIELD_CHARS + 1, "statement not capped");
  assert.ok(belief.statement.endsWith("…"), "truncation is not signposted");
});

test("a normal-length statement is untouched by the cap", () => {
  const s = "The hydrogen line frequency is 1420405752 Hz and indexes from 0.";
  const kb = foldOps([
    { op: "assert", kind: "concept", subject: "hydrogen line frequency", statement: s, confidence: "high", level: 6 },
  ]);
  assert.equal([...kb.values()][0].statement, s);
});
