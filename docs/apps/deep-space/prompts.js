// Prompt + response-schema construction for the Deep Space companion.
//
// Pure and node-importable: no DOM, no network, no IndexedDB, no clock, no
// randomness. Everything here is a function of its arguments so the tests in
// __tests__/prompts.test.js can pin the invariants.
//
// THE LOAD-BEARING INVARIANT: `mapPrompt` is knowledge-base-free. The
// screenshot-reading call sees the image and the marker legend and nothing
// else — no beliefs, no glyph vocabulary, no prior levels, no interpretation.
// That is what makes a reading a pure function of (image, prompt version) and
// therefore cacheable, which in turn makes "re-reduce the whole op log" a
// button instead of an O(n) chain of nondeterministic vision calls. All
// interpretation happens later, in `answerPrompt`. Do not add a KB parameter
// to `mapPrompt`; the test asserts its arity is 1.

// Bumping this invalidates every cached reading (cache key is
// imageHash + model + PROMPT_VERSION), so bump it only when the *map* prompt
// or the reading schema changes in a way that makes old readings wrong.
export const PROMPT_VERSION = 2;

// Mirrors kb.js BELIEF_KINDS / CONFIDENCES. Duplicated rather than imported so
// this module stays standalone-importable (and so a broken kb.js can never
// take the prompt layer down with it). __tests__/prompts.test.js cross-checks
// the two lists whenever kb.js is present.
const KIND_VALUES = [
  "numeral",
  "glyph",
  "operator",
  "grammar",
  "mechanic",
  "concept",
  "recipe",
];
const CONFIDENCE_VALUES = ["low", "medium", "high"];

// Marker used for op provenance when the caller did not tell us the shot hash.
// gemini.js rewrites it to the real hash after the call.
export const SHOT_HASH_PLACEHOLDER = "THIS_SHOT";

const str = (description) => ({ type: "STRING", description });
const strList = (description) => ({
  type: "ARRAY",
  description,
  items: { type: "STRING" },
});

// --- schemas --------------------------------------------------------------

// Gemini `responseSchema` (OpenAPI subset) for the map call.
export const READING_SCHEMA = {
  type: "OBJECT",
  description: "A literal, uninterpreted description of one game screenshot.",
  properties: {
    // Separating signal from flavour is the whole point of these two fields.
    // Observed failure: a reading that lumped "Ain't that splendid! Another
    // new transmission!" in with "1420405752" led the answer call to decide
    // the screen was a cutscene and refuse to solve it.
    transmissionContent: strList(
      "THE SIGNAL ITSELF. Every symbol, digit, glyph or value shown in a transmission, output, message or readout area, verbatim and IN THE ORDER DISPLAYED, one entry per line or row. This is the puzzle data. If a panel is labelled OUTPUT, MESSAGE, SIGNAL, RECEIVED or similar, everything inside it goes here. Never summarise, never round, never reorder.",
    ),
    narrativeText: strList(
      "Story and flavour text only: crew dialogue, subtitles, character names, exclamations, mission chatter. This is scene-setting, never puzzle data. Keep it strictly separate from transmissionContent.",
    ),
    screenText: strList(
      "Any remaining ordinary human-readable text — labels, menu items, counters, button captions — verbatim.",
    ),
    glyphs: {
      type: "ARRAY",
      description: "Every non-Latin / invented symbol visible on screen.",
      items: {
        type: "OBJECT",
        properties: {
          shape: str(
            "Purely geometric description of the form: strokes, curves, dots, enclosures, symmetry, orientation. Never what it means.",
          ),
          position: str(
            "Where on screen this form appears, relative to panels, rows and neighbours.",
          ),
          count: {
            type: "INTEGER",
            description: "How many times this exact form appears on screen.",
          },
        },
        required: ["shape", "position", "count"],
        propertyOrdering: ["shape", "position", "count"],
      },
    },
    layout: str(
      "One paragraph on the overall arrangement: panels, grids, rows, separators, what sits above/below/beside what.",
    ),
    affordances: strList(
      "Every element that looks interactive, with its label or shape, its location and its apparent state.",
    ),
    colors: strList(
      "The palette in use, especially any colour that distinguishes one element from another, and where it appears.",
    ),
    observations: strList(
      "Any other literal fact: counts, alignments, repetitions, gaps, cut-off elements, cursor position, alert states, one entry per drawn marker.",
    ),
  },
  required: [
    "transmissionContent",
    "narrativeText",
    "screenText",
    "glyphs",
    "layout",
    "affordances",
    "colors",
    "observations",
  ],
  propertyOrdering: [
    "transmissionContent",
    "narrativeText",
    "screenText",
    "glyphs",
    "layout",
    "affordances",
    "colors",
    "observations",
  ],
};

// One flat op object covers assert/revise/retract; only `op` is required and
// local validation in kb.js rejects the shapes that come back malformed.
const OP_SCHEMA = {
  type: "OBJECT",
  description:
    "A single append-only knowledge-base operation. assert needs kind+subject+statement+confidence; revise needs target+statement+confidence+reason; retract needs target+reason.",
  properties: {
    op: {
      type: "STRING",
      enum: ["assert", "revise", "retract"],
      description: "Which operation this is.",
    },
    id: str(
      "assert only: a short new identifier you propose for this belief. Omit if unsure.",
    ),
    kind: {
      type: "STRING",
      enum: [...KIND_VALUES],
      description: "assert only: the coarse category of the belief.",
    },
    subject: str(
      "assert only: a STABLE CONCEPT NAME, lowercase, 1-4 words — 'hydrogen line frequency', 'tally numeral', 'channel index'. NEVER a value, number, instance or example. Two beliefs about the same concept must use the SAME subject so a contradiction between them can be detected; if you are correcting something you already believe about a concept, use revise, not a new assert.",
    ),
    statement: str(
      "assert/revise: the belief itself, ONE sentence, concrete and checkable, 40 words maximum. Required for revise as well as assert.",
    ),
    confidence: {
      type: "STRING",
      enum: [...CONFIDENCE_VALUES],
      description: "assert/revise: how strongly the evidence supports this.",
    },
    evidence: strList(
      "The shot hashes this belief rests on. Use exactly the hash given in the prompt.",
    ),
    level: {
      type: "INTEGER",
      description: "The level number this op was produced from.",
    },
    target: str(
      "revise/retract only: the id of an existing active belief you were shown. Never invent one.",
    ),
    reason: str(
      "revise/retract only: ONE short sentence, 20 words maximum, on why the existing belief is wrong. Never put the corrected belief here — that goes in statement.",
    ),
  },
  required: ["op"],
  propertyOrdering: [
    "op",
    "id",
    "kind",
    "subject",
    "statement",
    "confidence",
    "evidence",
    "level",
    "target",
    "reason",
  ],
};

// Gemini `responseSchema` for the answer call.
export const ANSWER_SCHEMA = {
  type: "OBJECT",
  description:
    "A reading, hypotheses, a concrete next move, an outgoing reply, and knowledge-base deltas.",
  properties: {
    summary: str(
      "Two to four sentences: what this screen is asking for, in plain English.",
    ),
    hypotheses: {
      type: "ARRAY",
      description:
        "Candidate readings of the puzzle, strongest first. Include rivals you are not sure about.",
      items: {
        type: "OBJECT",
        properties: {
          claim: str("The hypothesis, stated so it could be proved wrong."),
          confidence: {
            type: "STRING",
            enum: [...CONFIDENCE_VALUES],
            description: "How strongly this screen supports the claim.",
          },
          rationale: str(
            "The specific observed evidence, cited from the reading, that supports or weakens it.",
          ),
        },
        required: ["claim", "confidence", "rationale"],
        propertyOrdering: ["claim", "confidence", "rationale"],
      },
    },
    proposedReply: str(
      "The exact content to send back, symbol by symbol, with the reasoning that makes it the right answer to what arrived. ALWAYS give your best candidate reply, even when the composer is not open and even when the screen also shows story dialogue — say how confident you are instead of declining. Never describe interface mechanics; the player knows how to send.",
    ),
    proposedMove: str(
      "Only what is needed BEFORE the reply can be settled: the specific reading, count, comparison or experiment that would decide between the hypotheses. Empty string if the reply above is already determined.",
    ),
    ops: {
      type: "ARRAY",
      description:
        "Knowledge-base deltas justified by THIS screen. Empty array if nothing new was learned.",
      items: OP_SCHEMA,
    },
    code: {
      type: "OBJECT",
      nullable: true,
      description:
        "Optional program that checks or brute-forces the answer. null when no code would help.",
      properties: {
        language: {
          type: "STRING",
          enum: ["javascript", "python"],
          description:
            "javascript for the local sandbox, python for server-side execution.",
        },
        source: str("The program source."),
        purpose: str("What running it would settle."),
        expectedShape: str("What the return value / output looks like."),
      },
      required: ["language", "source", "purpose", "expectedShape"],
      propertyOrdering: ["language", "source", "purpose", "expectedShape"],
    },
  },
  required: [
    "summary",
    "hypotheses",
    "proposedReply",
    "proposedMove",
    "ops",
    "code",
  ],
  propertyOrdering: [
    "summary",
    "hypotheses",
    "proposedReply",
    "proposedMove",
    "ops",
    "code",
  ],
};

// --- map prompt (KB-FREE — see the header comment) -------------------------

const MAP_BODY = `You are transcribing a single screenshot from a puzzle game set in 1973. The
screen shows an invented symbolic writing system. You are the eyes, not the
mind: another process does every bit of interpretation. Your only job is to
describe, exhaustively and literally, what is on this screen.

ABSOLUTE RULES
- Never say what a symbol means, stands for, denotes, or represents.
- Never name a symbol after a concept. "the number three symbol" is banned;
  "three stacked horizontal bars inside a circle" is what you write.
- Never propose a solution, an answer, or an action the player should take.
- Never assume anything you cannot see in this image. There is no earlier
  context and you must not act as if there were.
- If a detail is unreadable, say it is unreadable. Do not fill it in.
- Describe duplicates as duplicates. Do not summarise with "etc." or "and so
  on"; enumerate.

WHAT TO PRODUCE

screenText — every run of ordinary human-readable text: Latin letters, Arabic
digits, punctuation. Labels, buttons, menus, counters, titles, status lines.
Verbatim, preserving casing, spacing and spelling exactly, typos included.
Mark anything you are unsure of with [?].

glyphs — every symbol that is NOT ordinary Latin text: the invented forms, and
also diagrams, icons and marks. One entry per visually distinct form:
  shape — geometry only. Count the strokes. Say whether they are straight or
    curved, their orientation, whether anything is enclosed, filled, dotted or
    hatched, whether the form is symmetric, and whether it looks built out of
    smaller parts that also appear elsewhere on screen.
  position — where it sits, described against panels, rows, columns and its
    immediate neighbours, plus its left-to-right order within its group.
  count — how many times that exact form appears on this screen.
Treat two forms as distinct entries unless they are identical. Put groupings,
ordering, spacing and repetition patterns in observations.

layout — one paragraph on the overall arrangement: panels, columns, rows,
grids, dividers, what is above/below/beside what, and any reading order the
layout implies.

affordances — every element that looks interactive: buttons, dials, sliders,
tiles, text fields, drag handles, arrows, send/submit controls, tabs,
scrollbars. Give each one's visible label or shape, its location, and its
apparent state: enabled, greyed out, selected, highlighted, empty, filled.

colors — the palette actually in use, and specifically every colour that
distinguishes one element from another (highlighted vs plain, active vs
inactive, correct vs error), with where each appears.

observations — every other literal fact: counts of repeated elements,
alignments and symmetries, gaps and blank slots, anything cut off by the edge
of the frame, motion blur, cursor position, and any error or alert state.`;

const MARKER_BLOCK = `NUMBERED MARKERS
The player has drawn numbered circles onto this image. Each number below is
followed by the player's own note about that spot:

`;

const MARKER_INSTRUCTIONS = `
Find each numbered circle in the image and describe, literally, what sits
underneath and immediately around it. The note tells you where to look and
nothing more: do not act on its content, do not judge whether it is right, and
do not repeat its wording as if it were something you observed. Add one entry
per marker to observations, each beginning "marker N: ".`;

const NO_MARKER_BLOCK = `NUMBERED MARKERS
None were drawn on this image.`;

// The screenshot-reading prompt. ONE parameter, and it is the marker legend
// text produced by image.js markerLegend(). Adding a second parameter — above
// all a knowledge-base one — breaks the reading cache and the re-reduce
// guarantee. The test asserts mapPrompt.length === 1.
export function mapPrompt(markerLegendText) {
  const legend = typeof markerLegendText === "string" ? markerLegendText.trim() : "";
  const markers = legend
    ? MARKER_BLOCK + legend + "\n" + MARKER_INSTRUCTIONS
    : NO_MARKER_BLOCK;
  return `${MAP_BODY}\n\n${markers}`;
}

// --- answer prompt --------------------------------------------------------

const GAME_BRIEF = `THE GAME
"The Message from Deep Space". It is 1973. A meteorite is broadcasting radio
waves and the player is the mission's Translator. The alien language is built
from the one substrate both sides share: mathematics and physical science.
Content runs roughly numeral system, then arithmetic, then pattern, then
geometry, then wider scientific concepts.

The channel is TWO-WAY. The player does not only decode what arrives — the
player composes and sends replies, and it is a correct reply that elicits the
next transmission. So a screen usually needs both a reading of what was
received and a constructed outgoing message.`;

// The player has sent dozens of replies. Telling them where the button is
// wastes the answer; what they cannot get anywhere else is the CONTENT.
const REPLY_CONVENTION = `WHAT THE PLAYER ALREADY KNOWS
The player is fluent in the interface. Composing and sending a reply works the
same way on every screen, and they have done it many times. Do not spend words
on the mechanics — no "click Respond", no "press the send button", no
walkthrough of how to enter symbols. Assume every one of those steps is
obvious and already handled.

What they cannot work out on their own, and what you are here for, is WHAT TO
SEND: the exact content of the outgoing transmission, symbol by symbol, and
the reasoning that makes it the right answer to what arrived. Spend your words
there.

Three failures to avoid, in order of how badly they waste the answer:

1. DO NOT PUNT ON THE COMPOSER. "This screen does not ask for a reply
   directly, we must open the composition panel first" is a non-answer. The
   composer being closed is not information. If the data needed to determine
   the response is visible — the numbers, the symbols, the pattern — then work
   out the response NOW and state it. Only say a screen wants no reply when
   the screen is genuinely not a puzzle, such as a title card or a cutscene.
2. DO NOT FORM HYPOTHESES ABOUT THE INTERFACE. A hypothesis is a claim about
   the alien language, the mathematics, or the encoding — something a later
   transmission could prove wrong. "The green button opens the composer" is
   not a hypothesis; it is a description of a button, and it is worth nothing.
3. DO NOT RECORD INTERFACE FACTS IN THE KNOWLEDGE BASE. Beliefs are about the
   language and the mathematics only. Never assert, revise or retract anything
   about buttons, panels, monitors, layout or where a control sits. That
   knowledge does not transfer between screens and it crowds out what does.

If the reply genuinely cannot be determined from what is visible, say exactly
which observation is missing and how to get it — not which control to press.`;

const ROLE = `You are the Translator's assistant. You are given a literal, uninterpreted
description of what is on the player's screen right now, everything the team
believes so far, and the player's own note. You do all the interpreting.`;

const OPS_RULES = `KNOWLEDGE-BASE OPS
Emit only deltas that THIS screen justifies. An empty ops array is a perfectly
good answer; padding the log with restatements is actively harmful, because
every belief you write is fed back into every future prompt.

  assert  — something newly learned. Give kind, subject, statement,
            confidence. The statement must be one concrete sentence that a
            later screen could contradict. "The three-bar glyph is a numeral"
            is useful; "the aliens use mathematics" is noise.

            subject MUST be a stable concept name, lowercase, 1-4 words, and
            it must be IDENTICAL every time you refer to that concept.
            Good:  subject "hydrogen line frequency", statement "The hydrogen
                   line frequency is 1420405752 Hz."
            Wrong: subject "1420405752", statement "1420405752 is the hydrogen
                   line frequency."
            Putting the value in the subject is the single most damaging
            mistake you can make here. Every new value becomes a new subject,
            so four incompatible beliefs about one quantity sit in the
            knowledge base at high confidence and nothing detects the clash —
            because contradictions are found by matching kind + subject. If
            you already hold a belief about a concept and now think the value
            is different, that is a revise, never a fresh assert.
  revise  — an existing belief is nearly right but needs correcting. Set
            target to the id of a belief listed above, AND statement to the
            full corrected belief — a revise without a statement is discarded,
            because there is nothing to replace the old text with. reason is
            ONE short sentence, twenty words at most, saying why the old
            version was wrong. Do not put the correction in reason.
  retract — an existing belief is wrong. Set target to a listed id and give a
            reason.

Rules you must not break:
- Beliefs are about the alien language, its numerals, its operators and the
  mathematics or science being expressed. NEVER record anything about the
  interface: buttons, panels, monitors, layout, which control opens what.
  Interface facts do not transfer between screens and they crowd out what
  does.
- target may only ever be an id that appears verbatim in the beliefs listed
  above. Never invent, guess, abbreviate or reformat an id. If you want to
  correct something you were not shown, use assert and explain in the
  statement.
- Do not re-assert a belief that is already listed. Prefer revise.
- Contradicting an existing belief is allowed and expected — decoding puzzles
  go wrong early. Say so explicitly with revise or retract rather than
  quietly asserting the opposite.`;

const buildKindLine = () =>
  `Valid kind values: ${KIND_VALUES.join(", ")}. Valid confidence values: ${CONFIDENCE_VALUES.join(", ")}.`;

const jsCodeRules = `CODE
If a check would settle a hypothesis — decoding a numeral, brute-forcing a
small mapping, verifying that decode(encode(x)) round-trips — return it in
code with language "javascript". It runs in a locked-down sandbox with no
network and no page access, and it is executed as a FUNCTION BODY that
receives one object called input and must return a value. Do not write an
import, a fetch, a DOM reference, or a top-level function wrapper — just the
body statements ending in a return. Put whatever it needs inside the source
itself; input may be empty. Describe the return value in expectedShape.
Return code as null when no program would help.`;

const pyCodeRules = `CODE
Server-side code execution is enabled for this run. If a computation would
settle a hypothesis, run Python now and use the real output in your summary,
hypotheses and reply — do not report a result you did not actually compute.
Then put that same program in code with language "python", and describe its
output in expectedShape. Return code as null if you ran nothing.`;

const answerShapeSkeleton = `{
  "summary": "string",
  "hypotheses": [{ "claim": "string", "confidence": "low|medium|high", "rationale": "string" }],
  "proposedReply": "string",
  "proposedMove": "string",
  "ops": [{ "op": "assert|revise|retract", "id": "string", "kind": "string", "subject": "string", "statement": "string", "confidence": "low|medium|high", "evidence": ["string"], "level": 0, "target": "string", "reason": "string" }],
  "code": null
}`;

const section = (heading, body) => `${heading}\n${body}`;

// The answer call. Takes the reading (from the map call), the serialized
// knowledge base, the player's free-text note and the level number.
// `kbText` empty is the deliberate "run without KB" baseline: the beliefs
// section is omitted entirely rather than sent as an empty heading.
// `shotHash` is optional; when supplied the model is told to stamp it as
// evidence, and gemini.js re-stamps it locally afterwards regardless.
export function answerPrompt({
  readingJson,
  kbText,
  userNote,
  standingNotes,
  feedback,
  level,
  allowCodeExec,
  shotHash,
} = {}) {
  const reading =
    typeof readingJson === "string"
      ? readingJson
      : JSON.stringify(readingJson ?? {}, null, 2);
  const kbRaw = typeof kbText === "string" ? kbText.trim() : "";
  // serializeKb never returns "" — an empty KB comes back as a sentinel
  // line. Treating that as content told the model on level 1 that this was
  // everything the team had learned so far, followed by nothing.
  const kb = /^\(knowledge base is empty\)$/i.test(kbRaw) ? "" : kbRaw;
  const note = typeof userNote === "string" ? userNote.trim() : "";
  const standing = typeof standingNotes === "string" ? standingNotes.trim() : "";
  // Complaints accumulate per screen. Sending only the newest one lets the
  // model regress on an earlier complaint it can no longer see — there are no
  // conversational turns, so nothing else remembers them.
  const complaints = (Array.isArray(feedback) ? feedback : [feedback])
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean);
  const levelText =
    level === undefined || level === null || level === "" ? "unknown" : String(level);
  const hash =
    typeof shotHash === "string" && shotHash ? shotHash : SHOT_HASH_PLACEHOLDER;

  const parts = [ROLE, GAME_BRIEF, REPLY_CONVENTION, section("LEVEL", levelText)];

  // Standing instructions outrank a single screen's note: they are the things
  // the player got tired of repeating, so they ride along with every prompt.
  if (standing) {
    parts.push(
      section(
        "STANDING INSTRUCTIONS FROM THE PLAYER",
        `These apply to EVERY screen, not just this one. The player set them once
because they were tired of saying them again each level. Follow them exactly;
where they conflict with your own habits, they win.\n\n${standing}`,
      ),
    );
  }

  if (kb) {
    parts.push(
      section(
        "KNOWN BELIEFS",
        `Everything the team currently believes, from earlier screens. Some of it
is wrong. Weigh it against what is on screen now, and say so when this screen
contradicts it.\n\n${kb}`,
      ),
    );
  } else {
    parts.push(
      section(
        "NO PRIOR BELIEFS",
        `This run is a deliberate baseline: nothing accumulated from earlier screens
has been supplied. Work from the screen reading alone, and do not pretend to
remember anything. Ops may only be assert; you have no ids to target.`,
      ),
    );
  }

  // A rejected answer is the most specific signal available: the player has
  // seen a real attempt and said exactly what was wrong with it.
  if (complaints.length) {
    const list = complaints.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const plural = complaints.length === 1 ? "attempt was" : "attempts were";
    parts.push(
      section(
        "YOUR PREVIOUS ANSWERS WERE REJECTED",
        `You have already answered this screen and the player turned it down. Your
${plural} wrong for ${complaints.length === 1 ? "this reason" : "these reasons"}, oldest first:

${list}

Every one of these still applies. Fixing the newest complaint while falling
back into an earlier one is the failure mode here — re-read the whole list
before you answer. Do not defend a previous answer, do not restate one in
different words, and do not explain what you got wrong. Produce a genuinely
different answer that satisfies all ${complaints.length === 1 ? "of it" : "of them"} at once.`,
      ),
    );
  }

  parts.push(
    section(
      "PLAYER NOTE",
      note ||
        "(none — the player did not add a note, so rely on the screen reading)",
    ),
  );

  parts.push(
    section(
      "SCREEN READING",
      `A literal description of the current screen, produced by an observer that was
shown nothing but the image. It contains no interpretation, and it may be
incomplete or mistaken about detail. Treat it as evidence, not as truth.

HOW TO WEIGHT IT. transmissionContent is the puzzle: the actual signal, in the
order shown. Work from it first and quote it back precisely. narrativeText is
crew chatter and scene-setting — it is atmosphere, it is NEVER the puzzle, and
a dialogue box on screen does not make a screen unanswerable. screenText,
affordances, layout and colors are context for locating things, not the
problem to be solved.

${reading}`,
    ),
  );

  parts.push(
    section(
      "WHAT TO PRODUCE",
      `summary — two to four sentences in plain English: what this screen is
asking for and where the puzzle stands.

hypotheses — the candidate readings of the LANGUAGE or the MATHEMATICS,
strongest first, each with a confidence and a rationale citing specific
observed detail from the reading above. Include the rival you are least sure
about; do not collapse to one answer to look decisive. Nothing about buttons,
panels or where a control sits — those are not hypotheses.

proposedReply — the heart of the answer, and where most of your words belong.
The exact content to send back, symbol by symbol, and why that is the correct
response to what arrived. No interface instructions of any kind: the player
knows how to compose and send.

ALWAYS commit to a best candidate reply. A closed composer, a dialogue box on
screen, a cutscene overlay — none of these are reasons to withhold an answer,
and "this screen does not currently ask for a reply" is a non-answer. If the
transmission content is visible, the puzzle is answerable NOW; give the reply
and state your confidence. Only if there is genuinely no transmission content
anywhere on screen may you say there is nothing to answer yet — and then say
what you would need to see.

proposedMove — only what must happen BEFORE the reply can be settled: the
specific thing to read, count, compare or try that would decide between your
hypotheses, and what each outcome would mean. If proposedReply is already
determined, return an empty string rather than padding this with steps the
player does not need.

ops — knowledge-base deltas, per the rules below.

code — per the rules below.`,
    ),
  );

  parts.push(
    section(
      "OPS",
      `${OPS_RULES}\n\n${buildKindLine()}\nSet level to ${levelText} on every op, and set evidence to exactly ["${hash}"].`,
    ),
  );

  parts.push(allowCodeExec ? pyCodeRules : jsCodeRules);

  parts.push(
    section(
      "OUTPUT",
      allowCodeExec
        ? `Your final output must be one JSON object and nothing else — no prose around
it, no markdown code fence, no commentary after it. Any Python you run is
separate from this object. Shape:\n\n${answerShapeSkeleton}`
        : `Return one JSON object of this shape:\n\n${answerShapeSkeleton}`,
    ),
  );

  return parts.join("\n\n");
}
