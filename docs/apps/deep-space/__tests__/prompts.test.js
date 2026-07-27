import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_VERSION,
  READING_SCHEMA,
  ANSWER_SCHEMA,
  SHOT_HASH_PLACEHOLDER,
  mapPrompt,
  answerPrompt,
} from "../prompts.js";

// A KB blob with sentinels we can search for. If any of these ever turn up in
// a map prompt, the reading is no longer a pure function of the image.
const KB_SENTINEL = "ZQX-BELIEF-SENTINEL-4471";
const KB_TEXT = [
  `b3 [numeral] high — three stacked bars ${KB_SENTINEL} denote the value 3`,
  "b7 [mechanic] medium — the left dial cycles the transmit buffer",
].join("\n");

const LEGEND = "1) this glyph changed when I clicked the left dial\n2) blinking";

// --- the invariant: map is knowledge-base free ----------------------------

test("mapPrompt takes exactly one argument — the marker legend", () => {
  // Arity 1 is the mechanical guard. A second parameter is how the KB would
  // sneak in, and that turns re-reduce from a fold into an O(n) chain of
  // nondeterministic vision calls.
  assert.equal(mapPrompt.length, 1);
});

test("mapPrompt output contains no knowledge-base content", () => {
  const prompt = mapPrompt(LEGEND);

  // The sentinel is detectable when it is actually present (see the
  // answerPrompt test below), so its absence here is meaningful.
  assert.ok(!prompt.includes(KB_SENTINEL));
  assert.ok(!prompt.includes(KB_TEXT));

  // Nor any of the vocabulary a KB block would bring with it.
  const banned = [
    /\bbeliefs?\b/i,
    /\bknowledge base\b/i,
    /\bhypothes/i,
    /\blexicon\b/i,
    /\bdictionar/i,
    /\bvocabular/i,
    /\bglossar/i,
    /\bprevious(ly)? level/i,
    /\bearlier screens?\b/i,
    /\bwe (?:know|believe)\b/i,
  ];
  for (const re of banned)
    assert.ok(!re.test(prompt), `map prompt must not mention ${re}`);
});

test("mapPrompt is a pure function of its one argument", () => {
  assert.equal(mapPrompt(LEGEND), mapPrompt(LEGEND));
  assert.notEqual(mapPrompt(LEGEND), mapPrompt(""));
});

test("mapPrompt forbids interpretation and demands literal description", () => {
  const prompt = mapPrompt("");
  assert.match(prompt, /Never say what a symbol means/i);
  assert.match(prompt, /Never propose a solution/i);
  for (const field of [
    "screenText",
    "glyphs",
    "layout",
    "affordances",
    "colors",
    "observations",
  ])
    assert.ok(prompt.includes(field), `map prompt must ask for ${field}`);
});

test("mapPrompt embeds the marker legend and says so when there is none", () => {
  const withMarkers = mapPrompt(LEGEND);
  assert.ok(withMarkers.includes(LEGEND));
  assert.match(withMarkers, /marker N/);

  const without = mapPrompt("");
  assert.ok(!without.includes(LEGEND));
  assert.match(without, /None were drawn/i);

  // Missing / non-string legends behave like an empty one, not like "undefined".
  assert.equal(mapPrompt(undefined), without);
  assert.equal(mapPrompt("   "), without);
});

// --- schemas ---------------------------------------------------------------

const TYPES = new Set([
  "STRING",
  "NUMBER",
  "INTEGER",
  "BOOLEAN",
  "ARRAY",
  "OBJECT",
]);

// Walk a Gemini responseSchema and assert it is structurally usable.
const checkSchema = (node, path) => {
  assert.ok(node && typeof node === "object", `${path}: not an object`);
  assert.ok(TYPES.has(node.type), `${path}: bad type ${node.type}`);

  if (node.enum) {
    assert.equal(node.type, "STRING", `${path}: enum only valid on STRING`);
    assert.ok(Array.isArray(node.enum) && node.enum.length, `${path}: empty enum`);
    assert.ok(
      node.enum.every((v) => typeof v === "string"),
      `${path}: non-string enum value`,
    );
  }

  if (node.type === "ARRAY") {
    assert.ok(node.items, `${path}: ARRAY without items`);
    checkSchema(node.items, `${path}[]`);
  }

  if (node.type === "OBJECT") {
    assert.ok(node.properties, `${path}: OBJECT without properties`);
    const keys = Object.keys(node.properties);
    assert.ok(keys.length, `${path}: OBJECT with no properties`);
    for (const k of node.required || [])
      assert.ok(keys.includes(k), `${path}: required "${k}" is not a property`);
    for (const k of node.propertyOrdering || [])
      assert.ok(
        keys.includes(k),
        `${path}: propertyOrdering "${k}" is not a property`,
      );
    for (const k of keys) checkSchema(node.properties[k], `${path}.${k}`);
  }
};

test("READING_SCHEMA is a structurally valid Gemini schema of the reading shape", () => {
  checkSchema(READING_SCHEMA, "reading");
  assert.deepEqual(Object.keys(READING_SCHEMA.properties).sort(), [
    "affordances",
    "colors",
    "glyphs",
    "layout",
    "narrativeText",
    "observations",
    "screenText",
    "transmissionContent",
  ]);
  // Separating the signal from the story is why the reading exists at all:
  // a reading that mixed crew dialogue in with the transmission numbers made
  // the answer call decide a puzzle screen was a cutscene.
  assert.ok(READING_SCHEMA.required.includes("transmissionContent"));
  assert.ok(READING_SCHEMA.required.includes("narrativeText"));
  assert.equal(READING_SCHEMA.propertyOrdering[0], "transmissionContent");
  assert.deepEqual(
    Object.keys(READING_SCHEMA.properties.glyphs.items.properties).sort(),
    ["count", "position", "shape"],
  );
  assert.equal(READING_SCHEMA.properties.glyphs.items.properties.count.type, "INTEGER");
});

test("ANSWER_SCHEMA is a structurally valid Gemini schema of the answer shape", () => {
  checkSchema(ANSWER_SCHEMA, "answer");
  assert.deepEqual(Object.keys(ANSWER_SCHEMA.properties).sort(), [
    "code",
    "hypotheses",
    "ops",
    "proposedMove",
    "proposedReply",
    "summary",
  ]);
  assert.deepEqual(
    Object.keys(ANSWER_SCHEMA.properties.hypotheses.items.properties).sort(),
    ["claim", "confidence", "rationale"],
  );
  // code must be droppable — most levels need no program.
  assert.equal(ANSWER_SCHEMA.properties.code.nullable, true);
});

test("ANSWER_SCHEMA op items cover assert/revise/retract with only `op` required", () => {
  const op = ANSWER_SCHEMA.properties.ops.items;
  assert.deepEqual(op.required, ["op"]);
  assert.deepEqual(op.properties.op.enum, ["assert", "revise", "retract"]);
  for (const field of [
    "id",
    "kind",
    "subject",
    "statement",
    "confidence",
    "evidence",
    "level",
    "target",
    "reason",
  ])
    assert.ok(op.properties[field], `op schema is missing ${field}`);
  assert.deepEqual(op.properties.confidence.enum, ["low", "medium", "high"]);
});

test("schema kind/confidence enums stay in sync with kb.js when it exists", async (t) => {
  let kb;
  try {
    kb = await import("../kb.js");
  } catch {
    return t.skip("kb.js not present yet");
  }
  if (!kb.BELIEF_KINDS || !kb.CONFIDENCES)
    return t.skip("kb.js does not export BELIEF_KINDS / CONFIDENCES yet");

  const op = ANSWER_SCHEMA.properties.ops.items;
  assert.deepEqual([...op.properties.kind.enum], [...kb.BELIEF_KINDS]);
  assert.deepEqual([...op.properties.confidence.enum], [...kb.CONFIDENCES]);
});

// --- answer prompt ---------------------------------------------------------

const baseArgs = {
  readingJson: { layout: "one panel", glyphs: [], screenText: ["TRANSMIT"] },
  kbText: KB_TEXT,
  userNote: "the left dial has four positions",
  level: 7,
  allowCodeExec: false,
  shotHash: "abc123",
};

test("answerPrompt includes the KB block when kbText is non-empty", () => {
  const prompt = answerPrompt(baseArgs);
  assert.ok(prompt.includes("KNOWN BELIEFS"));
  assert.ok(prompt.includes(KB_TEXT));
  assert.ok(prompt.includes(KB_SENTINEL));
  assert.ok(!prompt.includes("NO PRIOR BELIEFS"));
});

test("answerPrompt excludes the KB block entirely when kbText is empty", () => {
  // This is the "run without KB" baseline — the experiment that tests whether
  // the knowledge base actually compounds. An empty heading would not be a
  // clean control, so the section is omitted outright.
  for (const kbText of ["", "   ", undefined, null]) {
    const prompt = answerPrompt({ ...baseArgs, kbText });
    assert.ok(!prompt.includes("KNOWN BELIEFS"), `kbText=${JSON.stringify(kbText)}`);
    assert.ok(!prompt.includes(KB_SENTINEL));
    assert.ok(prompt.includes("NO PRIOR BELIEFS"));
    // Still a complete request otherwise.
    assert.ok(prompt.includes("SCREEN READING"));
    assert.ok(prompt.includes("proposedReply"));
  }
});

test("answerPrompt carries reading, note and level through", () => {
  const prompt = answerPrompt(baseArgs);
  assert.ok(prompt.includes("TRANSMIT"));
  assert.ok(prompt.includes("the left dial has four positions"));
  assert.match(prompt, /LEVEL\n7/);
  assert.ok(prompt.includes("Set level to 7 on every op"));
});

test("answerPrompt accepts the reading as a pre-serialized string too", () => {
  const asString = JSON.stringify(baseArgs.readingJson, null, 2);
  assert.equal(
    answerPrompt({ ...baseArgs, readingJson: asString }),
    answerPrompt(baseArgs),
  );
});

test("answerPrompt says there is no note when the note is empty", () => {
  const prompt = answerPrompt({ ...baseArgs, userNote: "" });
  assert.match(prompt, /did not add a note/i);
});

test("answerPrompt demands the bidirectional reply, not just a reading", () => {
  const prompt = answerPrompt(baseArgs);
  assert.match(prompt, /TWO-WAY/);
  assert.match(prompt, /outgoing transmission/i);
  assert.match(prompt, /elicits the\s+next transmission/i);
});

test("answerPrompt pins op evidence to the shot hash", () => {
  assert.ok(answerPrompt(baseArgs).includes('evidence to exactly ["abc123"]'));
  const noHash = answerPrompt({ ...baseArgs, shotHash: undefined });
  assert.ok(noHash.includes(`evidence to exactly ["${SHOT_HASH_PLACEHOLDER}"]`));
});

test("answerPrompt forbids inventing belief ids for revise/retract", () => {
  const prompt = answerPrompt(baseArgs);
  assert.match(prompt, /Never invent, guess, abbreviate or reformat an id/i);
  assert.match(prompt, /may only ever be an id that appears verbatim/i);
});

test("answerPrompt swaps the code rules with allowCodeExec", () => {
  const local = answerPrompt({ ...baseArgs, allowCodeExec: false });
  assert.match(local, /language "javascript"/);
  assert.match(local, /FUNCTION BODY/);
  assert.ok(!/Server-side code execution is enabled/.test(local));

  const server = answerPrompt({ ...baseArgs, allowCodeExec: true });
  assert.match(server, /Server-side code execution is enabled/);
  assert.match(server, /language "python"/);
  // No responseSchema on that path, so the shape has to be spelled out and
  // fences explicitly banned.
  assert.match(server, /no markdown code fence/i);
  assert.match(server, /"proposedReply": "string"/);
});

test("answerPrompt is deterministic and survives a bare call", () => {
  assert.equal(answerPrompt(baseArgs), answerPrompt(baseArgs));
  const empty = answerPrompt();
  assert.ok(empty.includes("SCREEN READING"));
  assert.match(empty, /LEVEL\nunknown/);
});

test("PROMPT_VERSION is a positive integer — it is part of the reading cache key", () => {
  assert.ok(Number.isInteger(PROMPT_VERSION) && PROMPT_VERSION > 0);
});
