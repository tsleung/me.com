// Gemini REST client for the Deep Space companion. Browser only.
//
// Two calls per level, deliberately:
//   mapScreenshot() — image + marker legend -> a literal reading. KB-free, so
//                     the caller can cache it by image hash and replay the
//                     whole op log without spending vision calls again.
//   answerLevel()   — reading + serialized KB + note -> hypotheses, a move, an
//                     outgoing reply, and knowledge-base ops.
//
// Return values (app.js depends on these):
//   mapScreenshot -> the reading object, normalized to the reading shape.
//   answerLevel   -> the answer object, normalized to the answer shape, with
//                    an extra `serverExecutions` array (empty unless Gemini's
//                    server-side code execution actually ran) and `usage`.
//
// Every thrown Error carries a message written to be shown to the user as-is.

import {
  PROMPT_VERSION,
  READING_SCHEMA,
  ANSWER_SCHEMA,
  SHOT_HASH_PLACEHOLDER,
  mapPrompt,
  answerPrompt,
} from "./prompts.js";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export const DEFAULT_MODEL = "gemini-3.5-flash";

// The cap is a BACKSTOP, not a budget — the repetition detector below is what
// actually stops a runaway. It was briefly set to 8192, which was a mistake:
// for thinking models the reasoning tokens are drawn from this same budget, so
// a long think left too little room for the JSON answer and the call died with
// MAX_TOKENS part-way through the object. Keep this generous, and bound the
// thinking separately.
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

// Enough reasoning to be useful, not enough to crowd out the answer.
export const DEFAULT_THINKING_BUDGET = 8192;

export { PROMPT_VERSION };

// Model families on the list endpoint that cannot take an image, or cannot do
// generateContent usefully for us.
const NON_VISION = /embedding|aqa|imagen|veo|text-to-speech|-tts|learnlm-.*-e2b/i;

const stripModelPrefix = (model) => String(model || "").replace(/^models\//, "");

const authHeaders = (apiKey) => ({
  "content-type": "application/json",
  "x-goog-api-key": apiKey,
});

const isAbort = (err) =>
  Boolean(err) && (err.name === "AbortError" || err.code === 20);

// --- errors ---------------------------------------------------------------

// Turn an HTTP failure into a sentence the UI can print verbatim.
const httpError = (status, body, model) => {
  const detail =
    (body && body.error && body.error.message) ||
    (typeof body === "string" ? body.slice(0, 300) : "") ||
    "";
  const status_ = (body && body.error && body.error.status) || "";
  const named = model ? `model "${model}"` : "the model";

  if (status === 400 && /api[_ ]?key/i.test(detail + status_))
    return new Error(
      "Google rejected the API key. Check it in Settings — it should start with “AIza” and have the Generative Language API enabled.",
    );
  if (status === 400)
    return new Error(
      `Gemini rejected the request${detail ? `: ${detail}` : "."} This usually means the model name or the request options are wrong.`,
    );
  if (status === 401 || status === 403)
    return new Error(
      `Google refused the key for ${named}. Check that the key is valid, that the Generative Language API is enabled, and that any HTTP-referrer restriction on the key allows this page.${detail ? ` (${detail})` : ""}`,
    );
  if (status === 404)
    return new Error(
      `Gemini has no ${named}. Open Settings and use “Check model” to see the model names this key can actually call.`,
    );
  if (status === 429)
    return new Error(
      "Gemini is rate-limiting this key (quota exceeded). Wait a minute and try again, or check the quota on your Google Cloud project.",
    );
  if (status >= 500)
    return new Error(
      `Google's servers returned an error (${status}). This is on their end — try again in a moment.`,
    );
  return new Error(
    `Gemini request failed (HTTP ${status})${detail ? `: ${detail}` : "."}`,
  );
};

const networkError = () =>
  new Error(
    "Could not reach Google's Gemini API. Check your internet connection — and if the key has an HTTP-referrer restriction, that it allows this page.",
  );

// --- lenient JSON ---------------------------------------------------------

// Pull the outermost JSON object out of a model reply that may be fenced,
// prefixed with prose, or followed by commentary. Used on the code-execution
// path, where Gemini forbids responseSchema so we cannot rely on clean JSON.
export function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const unfenced = raw
    .replace(/^```(?:json|javascript|js)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const direct = tryParse(unfenced);
  if (direct !== undefined) return direct;

  const start = unfenced.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i += 1) {
    const ch = unfenced[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const parsed = tryParse(unfenced.slice(start, i + 1));
        return parsed === undefined ? null : parsed;
      }
    }
  }
  return null;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// --- models ---------------------------------------------------------------

// Vision-capable generateContent model ids this key can call, e.g.
// ["gemini-3.5-flash", "gemini-3-pro", ...]. Used by the Settings
// "Check model" button so a wrong model id is a UI message, not a 404.
// `signal` is optional so the Stop button can actually abort this fetch and
// not just the controller; every other network call here takes one too.
export async function listModels(apiKey, { signal } = {}) {
  if (!apiKey)
    throw new Error("No API key set. Add a Gemini API key in Settings first.");

  const out = [];
  let pageToken = "";
  for (let page = 0; page < 10; page += 1) {
    const url = `${API_ROOT}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    let res;
    try {
      res = await fetch(url, { headers: authHeaders(apiKey), signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw networkError();
    }
    const body = await readBody(res);
    if (!res.ok) throw httpError(res.status, body, null);

    for (const m of (body && body.models) || []) {
      const id = stripModelPrefix(m.name);
      const methods = m.supportedGenerationMethods || [];
      if (!methods.includes("generateContent")) continue;
      if (NON_VISION.test(id)) continue;
      out.push(id);
    }
    pageToken = (body && body.nextPageToken) || "";
    if (!pageToken) break;
  }
  return out;
}

async function readBody(res) {
  const text = await res.text();
  const parsed = tryParse(text);
  return parsed === undefined ? text : parsed;
}

// --- generate -------------------------------------------------------------

// Flash models occasionally fall into a degeneration loop, emitting the same
// phrase until the output cap. Observed in play: "Chapter 4. Design and
// Implementation of the non-commercial configuration of automated
// configuration management architecture", hundreds of times. Nothing upstream
// stops it, so the client has to.
const LOOP_MIN_UNIT = 12; // shortest repeating phrase worth calling a loop
const LOOP_MAX_UNIT = 240;
const LOOP_REPEATS = 5; // consecutive repeats before we call it
const LOOP_CHECK_EVERY = 2000; // characters between checks — this is O(n·k)
const LOOP_MIN_TEXT = 3000; // never judge a short answer to be looping

// Returns the repeated unit if the tail is `LOOP_REPEATS` copies of one
// phrase, else null. Deliberately only looks at the tail: a document that
// legitimately repeats a heading early on must not trip it.
export function detectRepetitionLoop(text) {
  if (typeof text !== "string") return null;
  const window = text.slice(-LOOP_MAX_UNIT * LOOP_REPEATS);
  for (let unit = LOOP_MIN_UNIT; unit <= LOOP_MAX_UNIT; unit++) {
    const need = unit * LOOP_REPEATS;
    if (window.length < need) break;
    const tail = window.slice(-need);
    const candidate = tail.slice(0, unit);
    let repeated = true;
    for (let i = 1; i < LOOP_REPEATS; i++) {
      if (tail.slice(i * unit, (i + 1) * unit) !== candidate) {
        repeated = false;
        break;
      }
    }
    if (repeated && candidate.trim().length >= LOOP_MIN_UNIT) return candidate;
  }
  return null;
}

const loopError = (unit) => {
  const shown = unit.trim().replace(/\s+/g, " ").slice(0, 60);
  return new Error(
    `Gemini got stuck repeating itself (“${shown}…”) and was stopped before it ran up the bill. Press Analyze again — it usually does not happen twice. “What Gemini sent back, raw” below shows exactly what it was repeating, and “How it reasoned” shows whether it happened while thinking or while answering.`,
  );
};

// Server-sent-event reader for :streamGenerateContent?alt=sse. Accumulates the
// deltas into the same payload shape the non-streaming endpoint returns, so
// everything downstream is identical either way.
const collectStream = async (res, onDelta) => {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parts = [];
  let usageMetadata = null;
  let finishReason = "";
  let promptFeedback = null;

  const push = (part) => {
    const last = parts[parts.length - 1];
    const mergeable =
      last &&
      typeof last.text === "string" &&
      typeof part.text === "string" &&
      Boolean(last.thought) === Boolean(part.thought);
    if (mergeable) last.text += part.text;
    else parts.push({ ...part });
  };

  let seen = "";
  let checkedAt = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.promptFeedback) promptFeedback = chunk.promptFeedback;
      if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
      const candidate = (chunk.candidates || [])[0];
      if (!candidate) continue;
      if (candidate.finishReason) finishReason = candidate.finishReason;
      for (const part of (candidate.content && candidate.content.parts) || []) {
        push(part);
        if (typeof part.text === "string" && part.text) {
          if (onDelta) onDelta({ text: part.text, thought: Boolean(part.thought) });
          // Reasoning is allowed to wander; the answer is not.
          if (!part.thought) {
            seen += part.text;
            if (
              seen.length >= LOOP_MIN_TEXT &&
              seen.length - checkedAt >= LOOP_CHECK_EVERY
            ) {
              checkedAt = seen.length;
              const unit = detectRepetitionLoop(seen);
              if (unit) {
                await reader.cancel().catch(() => {});
                throw loopError(unit);
              }
            }
          }
        }
      }
    }
  }

  return {
    candidates: [{ content: { parts }, finishReason }],
    usageMetadata,
    promptFeedback,
  };
};

// Some models reject an unknown thinkingConfig outright; that must not take
// the whole request down, so a 400 mentioning it retries once without.
const isThinkingRejection = (err) =>
  Boolean(err) &&
  /thinking|includeThoughts|Unknown name|unknown field/i.test(String(err.message || ""));

// Thin wrapper over models/{model}:generateContent, or
// :streamGenerateContent?alt=sse when onDelta is supplied. Returns
// { text, thoughts, json, parts, executableCode, codeResults, usage,
//   finishReason, raw }.
export async function generate(
  apiKey,
  model,
  {
    parts,
    responseSchema,
    tools,
    systemInstruction,
    signal,
    onDelta,
    includeThoughts,
    maxOutputTokens,
  } = {},
) {
  if (!apiKey)
    throw new Error("No API key set. Add a Gemini API key in Settings first.");
  const id = stripModelPrefix(model) || DEFAULT_MODEL;
  if (!Array.isArray(parts) || parts.length === 0)
    throw new Error("Nothing to send to Gemini — the request had no content.");

  const usesCodeExec = (tools || []).some((t) => t && t.codeExecution);
  if (usesCodeExec && responseSchema)
    throw new Error(
      "Gemini cannot use server-side code execution and a JSON response schema in the same request. Turn one of them off.",
    );

  const buildBody = (withThoughts) => {
    const body = { contents: [{ role: "user", parts }] };
    if (systemInstruction)
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (tools && tools.length) body.tools = tools;
    const cfg = {};
    if (responseSchema) {
      cfg.responseMimeType = "application/json";
      cfg.responseSchema = responseSchema;
    }
    if (withThoughts)
      cfg.thinkingConfig = {
        includeThoughts: true,
        // Bounded so reasoning cannot consume the whole output budget and
        // truncate the answer — that was the MAX_TOKENS bug.
        thinkingBudget: DEFAULT_THINKING_BUDGET,
      };
    // A hard ceiling so a degeneration loop the detector misses still ends.
    cfg.maxOutputTokens = maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS;
    if (Object.keys(cfg).length) body.generationConfig = cfg;
    return body;
  };

  const streaming = typeof onDelta === "function";
  const url = streaming
    ? `${API_ROOT}/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`
    : `${API_ROOT}/models/${encodeURIComponent(id)}:generateContent`;

  const attempt = async (withThoughts) => {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify(buildBody(withThoughts)),
        signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw networkError();
    }
    if (!res.ok) throw httpError(res.status, await readBody(res), id);
    if (streaming) return collectStream(res, onDelta);
    const body = await readBody(res);
    if (typeof body === "string")
      throw new Error("Gemini returned a response that was not JSON.");
    return body;
  };

  let payload;
  try {
    payload = await attempt(Boolean(includeThoughts));
  } catch (err) {
    if (!includeThoughts || isAbort(err) || !isThinkingRejection(err)) throw err;
    payload = await attempt(false);
  }

  const blocked = payload.promptFeedback && payload.promptFeedback.blockReason;
  if (blocked)
    throw new Error(
      `Gemini refused to process this screenshot (${blocked}). Try a different capture or reword the note.`,
    );

  const candidate = (payload.candidates || [])[0];
  if (!candidate)
    throw new Error(
      "Gemini returned no answer at all. Try again, or try a different model in Settings.",
    );

  const outParts = (candidate.content && candidate.content.parts) || [];
  // Thought parts must NOT reach the JSON parser — reasoning text mixed into
  // the answer is exactly what makes structured output fail to parse.
  const text = outParts
    .filter((p) => !p.thought)
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
  const thoughts = outParts
    .filter((p) => p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();

  const executableCode = outParts
    .filter((p) => p.executableCode)
    .map((p) => ({
      language: String(p.executableCode.language || "python").toLowerCase(),
      code: p.executableCode.code || "",
    }));
  const codeResults = outParts
    .filter((p) => p.codeExecutionResult)
    .map((p) => ({
      outcome: p.codeExecutionResult.outcome || "",
      output: p.codeExecutionResult.output || "",
    }));

  const finishReason = candidate.finishReason || "";
  if (finishReason === "MAX_TOKENS" && text && !tryParseOrNull(text)) {
    throw new Error(
      "Gemini hit its output limit part-way through the answer, so what came back was incomplete. Press Analyze again. If it keeps happening, lower how much of the knowledge base is sent, in Settings — and “What Gemini sent back, raw” below shows exactly where it stopped.",
    );
  }
  if (!text && !executableCode.length) {
    if (finishReason === "MAX_TOKENS")
      throw new Error(
        "Gemini ran out of output budget before saying anything. Try a shorter note, or a model with a bigger output limit.",
      );
    if (finishReason && finishReason !== "STOP")
      throw new Error(
        `Gemini stopped early (${finishReason}) and returned nothing usable.`,
      );
    throw new Error("Gemini returned an empty answer. Try again.");
  }

  return {
    text,
    thoughts,
    json: responseSchema ? tryParseOrNull(text) : extractJson(text),
    parts: outParts,
    executableCode,
    codeResults,
    usage: payload.usageMetadata || null,
    finishReason,
    raw: payload,
  };
}

const tryParseOrNull = (s) => {
  const v = tryParse(s);
  return v === undefined ? extractJson(s) : v;
};

// --- normalizers ----------------------------------------------------------

const asStrings = (v) =>
  Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).filter(Boolean)
    : typeof v === "string" && v
      ? [v]
      : [];

const normalizeReading = (r) => {
  const o = r && typeof r === "object" ? r : {};
  return {
    transmissionContent: asStrings(o.transmissionContent),
    narrativeText: asStrings(o.narrativeText),
    screenText: asStrings(o.screenText),
    glyphs: (Array.isArray(o.glyphs) ? o.glyphs : [])
      .filter((g) => g && typeof g === "object")
      .map((g) => ({
        shape: String(g.shape || ""),
        position: String(g.position || ""),
        count: Number.isFinite(Number(g.count)) ? Number(g.count) : 1,
      })),
    layout: typeof o.layout === "string" ? o.layout : "",
    affordances: asStrings(o.affordances),
    colors: asStrings(o.colors),
    observations: asStrings(o.observations),
  };
};

const normalizeAnswer = (a, level, shotHash) => {
  // Arrays pass a bare typeof check, and every field then reads undefined —
  // a blank answer with no error, on exactly the lenient-parsing path.
  const o = a && typeof a === "object" && !Array.isArray(a) ? a : {};
  const code =
    o.code && typeof o.code === "object" && o.code.source
      ? {
          language: String(o.code.language || "javascript").toLowerCase(),
          source: String(o.code.source),
          purpose: String(o.code.purpose || ""),
          expectedShape: String(o.code.expectedShape || ""),
        }
      : null;

  return {
    summary: typeof o.summary === "string" ? o.summary : "",
    hypotheses: (Array.isArray(o.hypotheses) ? o.hypotheses : [])
      .filter((h) => h && typeof h === "object")
      .map((h) => ({
        claim: String(h.claim || ""),
        confidence: String(h.confidence || "low").toLowerCase(),
        rationale: String(h.rationale || ""),
      })),
    proposedMove: typeof o.proposedMove === "string" ? o.proposedMove : "",
    proposedReply: typeof o.proposedReply === "string" ? o.proposedReply : "",
    // Stamp provenance locally: the model is asked for it, but evidence is a
    // fact about our storage and must not depend on the model getting it right.
    ops: (Array.isArray(o.ops) ? o.ops : [])
      .filter((op) => op && typeof op === "object")
      .map((op) => stampOp(op, level, shotHash)),
    code,
  };
};

const stampOp = (op, level, shotHash) => {
  const out = { ...op };
  if (shotHash) out.evidence = [shotHash];
  else
    out.evidence = asStrings(op.evidence).filter(
      (e) => e !== SHOT_HASH_PLACEHOLDER,
    );
  if (level !== undefined && level !== null && level !== "")
    out.level = Number(level);
  return out;
};

// --- the two calls --------------------------------------------------------

// The map call. Sees the image and the marker legend. It does NOT see the
// knowledge base — that is the invariant the reading cache rests on, so do not
// add a kb argument here.
export async function mapScreenshot(
  apiKey,
  model,
  { imageBase64, mimeType, markerLegendText, signal } = {},
) {
  if (!imageBase64) throw new Error("No screenshot to read — capture one first.");

  // Deliberately takes no knowledge base: see the KB-free-map invariant in
  // notes/deep-space/protocol.md.
  const promptText = mapPrompt(markerLegendText);

  const res = await generate(apiKey, model, {
    parts: [
      { inlineData: { mimeType: mimeType || "image/png", data: imageBase64 } },
      { text: promptText },
    ],
    responseSchema: READING_SCHEMA,
    signal,
  });

  if (!res.json)
    throw new Error(
      "Gemini's description of the screenshot was not valid JSON. Try Analyze again, or a different model in Settings.",
    );
  const reading = normalizeReading(res.json);
  reading.promptText = promptText;
  return reading;
}

// The answer call. Everything interpretive happens here.
// `kbText` empty is the "run without KB" baseline. `allowCodeExec` switches to
// Gemini's server-side Python, which cannot be combined with a response
// schema — so on that path we ask for JSON in the prompt and parse leniently.
export async function answerLevel(
  apiKey,
  model,
  {
    reading,
    kbText,
    userNote,
    standingNotes,
    feedback,
    level,
    allowCodeExec,
    shotHash,
    signal,
    onDelta,
  } = {},
) {
  const text = answerPrompt({
    readingJson: reading,
    kbText,
    userNote,
    standingNotes,
    feedback,
    level,
    allowCodeExec: Boolean(allowCodeExec),
    shotHash,
  });

  const res = await generate(apiKey, model, {
    parts: [{ text }],
    // Mutually exclusive by Gemini's own rules — see generate().
    responseSchema: allowCodeExec ? undefined : ANSWER_SCHEMA,
    tools: allowCodeExec ? [{ codeExecution: {} }] : undefined,
    signal,
    onDelta,
    includeThoughts: true,
  });

  if (!res.json || Array.isArray(res.json))
    throw new Error(
      allowCodeExec
        ? "Gemini ran the code but its final answer was not valid JSON. Turn off server-side code execution and try again."
        : "Gemini's answer was not valid JSON. Try Analyze again, or a different model in Settings.",
    );

  const answer = normalizeAnswer(res.json, level, shotHash);
  answer.serverExecutions = res.executableCode.map((c, i) => ({
    language: c.language,
    code: c.code,
    outcome: (res.codeResults[i] && res.codeResults[i].outcome) || "",
    output: (res.codeResults[i] && res.codeResults[i].output) || "",
  }));
  answer.usage = res.usage;
  // Kept so the player can see exactly what was sent and what came back —
  // the app is otherwise a black box wrapped around someone else's model.
  answer.promptText = text;
  answer.rawText = res.text;
  answer.thoughts = res.thoughts || "";
  return answer;
}
