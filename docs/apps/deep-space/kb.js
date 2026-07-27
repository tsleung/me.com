// Knowledge base for the deep-space companion.
//
// Readings are the source of truth; this KB is a *materialized view* over an
// append-only op log. Nothing here touches the DOM or IndexedDB — it is a
// pure, deterministic fold plus the validation that guards it, so it can be
// imported by `node --test` and re-run from scratch at any time.
//
// The three op shapes the model may emit:
//   { op:'assert',  id?, kind, subject, statement, confidence, evidence[], level }
//   { op:'revise',  target, statement, confidence, evidence[], level, reason }
//   { op:'retract', target, reason, level }
//
// The belief shape they fold into (derived — never authored directly):
//   { id, kind, subject, statement, confidence, status, evidence[],
//     supersedes, level, seq, reason }

export const BELIEF_KINDS = [
  "numeral",
  "glyph",
  "operator",
  "grammar",
  "mechanic",
  "concept",
  "recipe",
];

export const CONFIDENCES = ["low", "medium", "high"];

export const OP_KINDS = ["assert", "revise", "retract"];

const KIND_PREFIX = {
  numeral: "num",
  glyph: "gly",
  operator: "opr",
  grammar: "gra",
  mechanic: "mec",
  concept: "con",
  recipe: "rec",
};

const CONF_RANK = { low: 0, medium: 1, high: 2 };

// --- small coercions ------------------------------------------------------

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// A belief line is re-sent in every future prompt, so one degenerate field
// poisons every later answer and costs tokens forever. Observed live: a
// `revise` came back with a 4,000-character `reason` of repeated word salad
// ("sequential mappings sequential list values ..."). Degeneration inside a
// single JSON string is invisible to the stream-level repetition guard,
// because it is not exactly periodic — so the length cap is the backstop.
export const MAX_FIELD_CHARS = 600;

const text = (v) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS).trimEnd()}…` : s;
};

const isFilled = (v) => text(v).length > 0;

const firstFilled = (...vs) => {
  for (const v of vs) if (isFilled(v)) return text(v);
  return "";
};

// Unknown kinds are preserved rather than coerced: an honest KB shows the
// model inventing a category, and `validateOps` is what refuses to accept it.
const normKind = (v) => {
  const k = text(v).toLowerCase();
  return k || "concept";
};

// A kind only counts as *stated* when it is present and in the vocabulary.
// Distinguishing this from `normKind` matters: an absent kind must not be
// silently laundered into "concept" by the validator.
const statedKind = (v) => {
  const k = text(v).toLowerCase();
  return BELIEF_KINDS.includes(k) ? k : null;
};

const normConfidence = (v) => {
  const c = text(v).toLowerCase();
  return CONFIDENCES.includes(c) ? c : "low";
};

const normEvidence = (v) => {
  const raw = Array.isArray(v) ? v : isFilled(v) ? [v] : [];
  const out = [];
  for (const item of raw) {
    const s = text(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
};

const normLevel = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const mergeEvidence = (a, b) => normEvidence([...normEvidence(a), ...normEvidence(b)]);

// A plain object cannot preserve insertion order for integer-like keys —
// `Object.values` emits "2" before "10" whatever order they were written in.
// Beliefs carry the seq of the op that created them, and Map order IS creation
// order, so sorting by seq reproduces the canonical order after a JSON round
// trip. Arrays are left alone: their order is the caller's own statement.
const bySeq = (list) =>
  list
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      const sx = Number.isFinite(x.b.seq) ? x.b.seq : Infinity;
      const sy = Number.isFinite(y.b.seq) ? y.b.seq : Infinity;
      return sx - sy || x.i - y.i;
    })
    .map((x) => x.b);

// Accepts a Map (the canonical form), an array of beliefs, or a plain object
// keyed by id, so callers never have to think about which they are holding.
const beliefsOf = (kb) => {
  if (!kb) return [];
  if (kb instanceof Map) return [...kb.values()];
  if (Array.isArray(kb)) return kb.filter(isObject);
  if (isObject(kb)) return bySeq(Object.values(kb).filter(isObject));
  return [];
};

const hasId = (kb, id) => {
  if (kb instanceof Map) return kb.has(id);
  return beliefsOf(kb).some((b) => b.id === id);
};

const cloneBelief = (b) => ({ ...b, evidence: [...normEvidence(b.evidence)] });

// --- normalization --------------------------------------------------------

// Statement text reduced to a comparison key: lowercase, punctuation dropped,
// symbols isolated so "1+1=2" and "1 + 1 = 2" collapse together, whitespace
// squeezed. Symbols are deliberately KEPT — glyph statements are often little
// more than a symbol, and stripping them would make every glyph a duplicate
// of every other glyph.
export function normalizeStatement(s) {
  const raw = typeof s === "string" ? s : s == null ? "" : String(s);
  return raw
    .toLowerCase()
    .replace(/\p{P}+/gu, " ")
    .replace(/(\p{S})/gu, " $1 ")
    .replace(/\s+/gu, " ")
    .trim();
}

// --- ids ------------------------------------------------------------------

const prefixFor = (kind) => {
  const k = normKind(kind);
  if (KIND_PREFIX[k]) return KIND_PREFIX[k];
  return k.replace(/[^a-z0-9]/g, "").slice(0, 3) || "bel";
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Deterministic: one past the highest number already used by that prefix. No
// Math.random, no Date.now — folding the same log twice must produce
// byte-identical ids.
//
// Derived from the ids present rather than from a COUNT of them, so a KB that
// has holes in it (an id retired, an op hand-removed) still moves forward
// instead of landing on a number already spent. Pass the WHOLE kb: hand it a
// filtered view whose highest id has been filtered out and it can only reissue
// that number — the caller, not this function, is the one holding the
// information needed to avoid that.
export function nextBeliefId(kb, kind) {
  const prefix = prefixFor(kind);
  const pattern = new RegExp(`^${escapeRe(prefix)}-(\\d+)`);
  let n = 1;
  for (const b of beliefsOf(kb)) {
    const m = pattern.exec(text(b && b.id));
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  let id = `${prefix}-${n}`;
  while (hasId(kb, id)) {
    n += 1;
    id = `${prefix}-${n}`;
  }
  return id;
}

const uniqueId = (map, wanted) => {
  if (!map.has(wanted)) return wanted;
  let n = 2;
  while (map.has(`${wanted}#${n}`)) n += 1;
  return `${wanted}#${n}`;
};

// A revision of `num-3` becomes `num-3.2`, then `num-3.3` — the chain stays
// legible in the serialized KB instead of sprouting nested suffixes.
const revisionId = (map, targetId) => {
  const base = String(targetId).replace(/\.\d+$/, "");
  let n = 2;
  while (map.has(`${base}.${n}`)) n += 1;
  return `${base}.${n}`;
};

// --- the fold -------------------------------------------------------------

const makeBelief = (fields) => ({
  id: fields.id,
  kind: fields.kind,
  subject: fields.subject,
  statement: fields.statement,
  confidence: fields.confidence,
  status: fields.status || "active",
  evidence: fields.evidence || [],
  supersedes: fields.supersedes === undefined ? null : fields.supersedes,
  level: fields.level === undefined ? null : fields.level,
  seq: fields.seq,
  reason: fields.reason === undefined ? null : fields.reason,
});

// Applies one op to a working map in place. Total: an op it cannot apply is a
// no-op rather than a throw, so a log can always be folded even if it was
// hand-edited or merged. Returns null on success and a REASON STRING when the
// op was skipped — `foldOpsDetailed` collects those, because a fold that drops
// ops without saying so is how a knowledge base quietly loses history.
//
// The legality rules here are deliberately the same ones `validateOps` uses.
// They used to differ (this function checked only that the target existed),
// which meant a revise could resurrect a belief the user had withdrawn.
const applyOp = (map, op, seq) => {
  if (!isObject(op)) return "malformed";
  const verb = text(op.op).toLowerCase();

  if (verb === "assert") {
    if (!isFilled(op.statement)) return "missing-statement";
    const kind = normKind(op.kind);
    const id = uniqueId(map, isFilled(op.id) ? text(op.id) : nextBeliefId(map, kind));
    map.set(
      id,
      makeBelief({
        id,
        kind,
        subject: text(op.subject),
        statement: text(op.statement),
        confidence: normConfidence(op.confidence),
        status: "active",
        evidence: normEvidence(op.evidence),
        supersedes: null,
        level: normLevel(op.level),
        seq,
      }),
    );
    return null;
  }

  if (verb === "revise") {
    if (!isFilled(op.statement)) return "missing-statement";
    if (!isFilled(op.target)) return "missing-target";
    const target = map.get(text(op.target));
    if (!target) return "unknown-target";
    if (target.status !== "active") return "target-retracted";
    const id = uniqueId(map, isFilled(op.id) ? text(op.id) : revisionId(map, target.id));
    // Map.set on an existing key keeps its insertion position, so retiring the
    // target does not reorder the KB.
    map.set(target.id, {
      ...cloneBelief(target),
      status: "retracted",
      reason: firstFilled(op.reason) || target.reason || null,
    });
    map.set(
      id,
      makeBelief({
        id,
        kind: target.kind,
        subject: isFilled(op.subject) ? text(op.subject) : target.subject,
        statement: text(op.statement),
        confidence: isFilled(op.confidence)
          ? normConfidence(op.confidence)
          : target.confidence,
        status: "active",
        evidence: mergeEvidence(target.evidence, op.evidence),
        supersedes: target.id,
        level: normLevel(op.level) === null ? target.level : normLevel(op.level),
        seq,
      }),
    );
    return null;
  }

  if (verb === "retract") {
    if (!isFilled(op.target)) return "missing-target";
    const target = map.get(text(op.target));
    if (!target) return "unknown-target";
    // Already withdrawn: leave the original reason alone. Re-retracting used
    // to overwrite it, losing why the belief was dropped in the first place.
    if (target.status !== "active") return "already-retracted";
    map.set(target.id, {
      ...cloneBelief(target),
      status: "retracted",
      reason: firstFilled(op.reason) || target.reason || null,
    });
    return null;
  }

  return isFilled(op.op) ? "unknown-op" : "malformed";
};

// The whole point of the design: KB = fold(oplog). Same array in, same Map
// out, every time. `seq` is the op's index in the log.
//
// `skipped` is the honest half: [{ index, op, reason }] for every op the fold
// could not apply. Re-reduce and import both fold logs that `validateOps` never
// saw, and an op that evaporates with no report is indistinguishable from one
// that was never recorded.
export function foldOpsDetailed(ops) {
  const kb = new Map();
  const list = Array.isArray(ops) ? ops : [];
  const skipped = [];
  list.forEach((op, i) => {
    const reason = applyOp(kb, op, i);
    if (reason) skipped.push({ index: i, op, reason });
  });
  return { kb, skipped };
}

export function foldOps(ops) {
  return foldOpsDetailed(ops).kb;
}

// --- merging a foreign log ------------------------------------------------

// Ids in this design are POSITIONAL — `nextBeliefId` reads them off the KB the
// fold has built so far — and revise/retract carry their target as a literal
// id string. Both facts are fine for one append-only log and catastrophic for
// two: concatenate another device's log onto ours and its asserts land on our
// id numbers while its revise/retract ops aim at OUR beliefs. A belief the
// other machine withdrew can come back alive here, silently, and survive a
// re-reduce because the log now genuinely says that.
//
// So a foreign log is rewritten into its own id namespace before it is
// appended. Every id it creates gets `tag:` in front of it, and every target
// is rewritten the same way — including targets that resolve to nothing, which
// makes them inert no-ops instead of aimed at a local belief by coincidence.
//
// Pure: takes the ops, returns new ops, touches nothing.
export function remapOpIds(ops, tag) {
  const list = Array.isArray(ops) ? ops : [];
  const prefix = text(tag) || "imported";
  const rename = (id) => `${prefix}:${id}`;

  // Fold the foreign log on its own to learn which id each op produced —
  // a belief's `seq` is the index of the op that created it.
  const madeAt = new Map();
  for (const b of foldOpsDetailed(list).kb.values()) {
    if (Number.isFinite(b.seq) && !madeAt.has(b.seq)) madeAt.set(b.seq, b.id);
  }

  return list.map((op, i) => {
    if (!isObject(op)) return op;
    const verb = text(op.op).toLowerCase();
    if (!OP_KINDS.includes(verb)) return op;
    const out = { ...op };
    if (verb === "assert" || verb === "revise") {
      const made = madeAt.get(i);
      if (made) out.id = rename(made);
      else if (isFilled(op.id)) out.id = rename(text(op.id));
    }
    if (verb === "revise" || verb === "retract") {
      if (isFilled(op.target)) out.target = rename(text(op.target));
    }
    return out;
  });
}

// --- duplicates and contradictions ----------------------------------------

// The separator is a NUL written as an escape, never as a literal byte: a raw
// NUL makes the whole file read as binary to grep/file, which silently
// swallows source searches over it.
const dupKey = (kind, subject) =>
  `${normKind(kind)}\u0000${normalizeStatement(subject)}`;

// An assert is a near-duplicate when an *active* belief already shares its
// kind + subject and says the same thing once normalized. Without this the KB
// grows linearly with the model re-asserting what it already knows.
export function findDuplicate(kb, op) {
  if (!isObject(op)) return null;
  const key = dupKey(op.kind, op.subject);
  const statement = normalizeStatement(op.statement);
  if (!statement) return null;
  for (const b of beliefsOf(kb)) {
    if (b.status !== "active") continue;
    if (dupKey(b.kind, b.subject) !== key) continue;
    if (normalizeStatement(b.statement) === statement) return b;
  }
  return null;
}

// Active beliefs that share kind + subject but disagree. This — not context
// length — is what poisons the prompt around level 20, so the UI queues these
// for the user to adjudicate.
export function detectContradictions(kb) {
  const groups = new Map();
  for (const b of beliefsOf(kb)) {
    if (b.status !== "active") continue;
    // A subject-less belief cannot be *about* anything, so it cannot disagree
    // with anything either. Grouping them would put every unvalidated assert
    // (imported log, hand-edited log) into one bucket and report the whole
    // bucket as a storm of contradictions.
    if (!normalizeStatement(b.subject)) continue;
    const key = dupKey(b.kind, b.subject);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const out = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (normalizeStatement(a.statement) === normalizeStatement(b.statement)) continue;
        out.push({ subject: a.subject, kind: a.kind, beliefs: [a, b] });
      }
    }
  }
  return out;
}

// --- validation -----------------------------------------------------------

const normalizedAssert = (op) => ({
  op: "assert",
  ...(isFilled(op.id) ? { id: text(op.id) } : {}),
  kind: normKind(op.kind),
  subject: text(op.subject),
  statement: text(op.statement),
  confidence: normConfidence(op.confidence),
  evidence: normEvidence(op.evidence),
  level: normLevel(op.level),
});

// A revise/retract we cannot apply still carries real information. Rather
// than drop it, turn it into an assert the user can accept — the model was
// trying to say something, it just aimed at an id that no longer exists.
const proposeAssert = (source, fallback) => {
  const kind = statedKind(source.kind) || (fallback ? fallback.kind : "concept");
  const subject = firstFilled(source.subject, fallback && fallback.subject, source.target);
  const statement = firstFilled(source.statement, source.reason);
  if (!subject || !statement) return null;
  return {
    op: "assert",
    kind,
    subject,
    statement,
    confidence: isFilled(source.confidence)
      ? normConfidence(source.confidence)
      : fallback
        ? fallback.confidence
        : "low",
    evidence: mergeEvidence(fallback ? fallback.evidence : [], source.evidence),
    level: normLevel(source.level),
  };
};

// What arrived where an op array was expected. Nothing is allowed to fall
// through unaccounted for: `null`/`undefined` is genuinely "no ops proposed",
// a bare object is one op, and anything else — a number, a boolean, a JSON
// STRING from the schema-free code-execution path — is junk that must be
// reported rather than silently discarded. A string that parses is given the
// benefit of the doubt first, because that is a real model failure mode.
const opList = (ops) => {
  if (ops === null || ops === undefined) return { list: [], junk: [] };
  if (Array.isArray(ops)) return { list: ops, junk: [] };
  if (isObject(ops)) return { list: [ops], junk: [] };
  if (typeof ops === "string") {
    let parsed;
    try {
      parsed = JSON.parse(ops);
    } catch {
      return { list: [], junk: [ops] };
    }
    if (Array.isArray(parsed)) return { list: parsed, junk: [] };
    if (isObject(parsed)) return { list: [parsed], junk: [] };
    return { list: [], junk: [ops] };
  }
  return { list: [], junk: [ops] };
};

// Gate between the model's proposed ops and the append-only log.
//
//   accepted  — normalized ops safe to append now, in order.
//   rejected  — [{ op, reason }] with the ORIGINAL op, never silently dropped.
//   rewritten — [{ from, to, reason }] proposals for rejected revise/retract
//               ops. `to` ops are NOT in `accepted`: they are suggestions the
//               user opts into, and they carry no id (foldOps assigns one).
//
// Ops are checked against a working copy of `kb` that accumulates accepted
// ops, so a batch can assert then revise, and intra-batch duplicates are
// caught too.
export function validateOps(ops, kb) {
  const working = new Map();
  for (const b of beliefsOf(kb)) working.set(b.id, cloneBelief(b));

  const accepted = [];
  const rejected = [];
  const rewritten = [];
  const { list, junk } = opList(ops);
  for (const item of junk) rejected.push({ op: item, reason: "malformed" });
  let seq = working.size;

  const take = (op) => {
    accepted.push(op);
    applyOp(working, op, seq);
    seq += 1;
  };

  for (const raw of list) {
    if (!isObject(raw)) {
      rejected.push({ op: raw, reason: "malformed" });
      continue;
    }

    // The verb is matched case-insensitively like every other field. On the
    // code-execution path there is no response schema, and a capitalized
    // "Assert" used to reject the entire batch.
    const verb = text(raw.op).toLowerCase();
    if (!OP_KINDS.includes(verb)) {
      rejected.push({ op: raw, reason: isFilled(raw.op) ? "unknown-op" : "malformed" });
      continue;
    }

    if (verb === "assert") {
      if (!statedKind(raw.kind)) {
        rejected.push({ op: raw, reason: "unknown-kind" });
        continue;
      }
      if (!isFilled(raw.subject)) {
        rejected.push({ op: raw, reason: "missing-subject" });
        continue;
      }
      if (!isFilled(raw.statement)) {
        rejected.push({ op: raw, reason: "missing-statement" });
        continue;
      }
      const dup = findDuplicate(working, raw);
      if (dup) {
        rejected.push({ op: raw, reason: "duplicate", existing: dup.id });
        continue;
      }
      take(normalizedAssert(raw));
      continue;
    }

    const targetId = text(raw.target);
    if (!targetId) {
      rejected.push({ op: raw, reason: "missing-target" });
      continue;
    }
    const target = working.get(targetId);

    if (verb === "revise") {
      if (!isFilled(raw.statement)) {
        rejected.push({ op: raw, reason: "missing-statement" });
        continue;
      }
      if (!target || target.status !== "active") {
        const reason = target ? "target-retracted" : "unknown-target";
        rejected.push({ op: raw, reason });
        const to = proposeAssert(raw, target);
        if (to) rewritten.push({ from: raw, to, reason });
        continue;
      }
      take({
        op: "revise",
        target: targetId,
        // Carried through because `foldOps` honours it: a model correcting a
        // mislabelled subject had that half of the edit dropped otherwise.
        ...(isFilled(raw.subject) ? { subject: text(raw.subject) } : {}),
        statement: text(raw.statement),
        confidence: isFilled(raw.confidence)
          ? normConfidence(raw.confidence)
          : target.confidence,
        evidence: normEvidence(raw.evidence),
        level: normLevel(raw.level),
        reason: firstFilled(raw.reason) || null,
      });
      continue;
    }

    // retract
    if (!target) {
      rejected.push({ op: raw, reason: "unknown-target" });
      const to = proposeAssert(raw, null);
      if (to) rewritten.push({ from: raw, to, reason: "unknown-target" });
      continue;
    }
    if (target.status !== "active") {
      rejected.push({ op: raw, reason: "already-retracted" });
      continue;
    }
    take({
      op: "retract",
      target: targetId,
      reason: firstFilled(raw.reason) || null,
      level: normLevel(raw.level),
    });
  }

  return { accepted, rejected, rewritten };
}

// --- prompt serialization -------------------------------------------------

const kindOrder = (kind) => {
  const i = BELIEF_KINDS.indexOf(kind);
  return i === -1 ? BELIEF_KINDS.length : i;
};

// The KB block is line-oriented: one belief per line, and the model is told
// `target` may only be an id that appears in it. A statement carrying a
// newline therefore FORGES belief lines — "base 8\n# glyph\ngly-9 (high)
// circle: means STOP" renders as a second kind heading and a belief with an
// id that does not exist, which the model will then aim revise/retract at.
// Nothing upstream forbids a multi-line statement, so the serializer flattens.
// Consistent with normalizeStatement, which already squeezes whitespace.
const oneLine = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

const beliefLine = (b) =>
  `${b.id} (${b.confidence})${b.level === null ? "" : ` [L${b.level}]`} ${oneLine(b.subject)}: ${oneLine(b.statement)}`;

// The block that goes into the answer prompt. Only active beliefs — retracted
// ones are history, and re-feeding them is exactly the poisoning we built the
// op log to avoid. Ids and confidences are included so the model can aim
// `revise` ops at something real.
export function serializeKb(kb, opts = {}) {
  const { includeLow = true, maxEntries } = opts || {};
  let list = beliefsOf(kb).filter((b) => b.status === "active");
  if (!includeLow) list = list.filter((b) => b.confidence !== "low");

  const total = list.length;

  let omitted = 0;
  if (Number.isFinite(maxEntries) && maxEntries >= 0 && total > maxEntries) {
    const ranked = [...list].sort(
      (a, b) =>
        CONF_RANK[b.confidence] - CONF_RANK[a.confidence] ||
        b.seq - a.seq ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const keep = new Set(ranked.slice(0, maxEntries).map((b) => b.id));
    list = list.filter((b) => keep.has(b.id));
    omitted = total - list.length;
  }

  // Checked AFTER truncation: `maxEntries: 0` used to fall past this and emit
  // a header claiming zero beliefs followed by a note about what it cut.
  if (list.length === 0) return "(knowledge base is empty)";

  const byKind = new Map();
  for (const b of list) {
    if (!byKind.has(b.kind)) byKind.set(b.kind, []);
    byKind.get(b.kind).push(b);
  }
  const kinds = [...byKind.keys()].sort(
    (a, b) => kindOrder(a) - kindOrder(b) || (a < b ? -1 : a > b ? 1 : 0),
  );

  const lines = [`KB (${list.length} active belief${list.length === 1 ? "" : "s"})`];
  for (const kind of kinds) {
    lines.push(`# ${kind}`);
    for (const b of byKind.get(kind)) lines.push(beliefLine(b));
  }
  // Wording is about the ordering, not the cut entries themselves: the ranking
  // is confidence first, then recency, so the last thing dropped may well have
  // been the same confidence as the last thing kept.
  if (omitted > 0)
    lines.push(
      `(${omitted} further entr${omitted === 1 ? "y" : "ies"} omitted — kept in order of confidence, then recency)`,
    );
  return lines.join("\n");
}

export function kbStats(kb) {
  const list = beliefsOf(kb);
  const byKind = {};
  let active = 0;
  let retracted = 0;
  for (const b of list) {
    if (b.status === "active") {
      active += 1;
      byKind[b.kind] = (byKind[b.kind] || 0) + 1;
    } else {
      retracted += 1;
    }
  }
  return {
    total: list.length,
    active,
    retracted,
    byKind,
    contradictions: detectContradictions(kb).length,
  };
}
