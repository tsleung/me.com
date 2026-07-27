// Debug report assembly. Pure and node-importable: no DOM, no IndexedDB, no
// network — so the redaction rules below are unit-testable, which is the whole
// reason this is a separate module.
//
// The report exists because diagnosing a bad answer otherwise depends on the
// player describing it. What actually settles a question is the exact prompt
// that was sent, the raw text that came back, and the knowledge base as it
// stood at that moment. This bundles all three.

export const DEBUG_REPORT_VERSION = 1;

// Anything that looks like a Google API key, wherever it turns up — including
// inside an error message Google itself echoed back at us. The settings key is
// dropped by name below; this is the net for every other path.
const KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;
const SECRET_KEYS = /^(apikey|api_key|key|token|secret|password|authorization)$/i;

// Deep copy with secrets removed. Returns plain JSON-safe values only.
export function redact(value) {
  if (typeof value === "string") return value.replace(KEY_PATTERN, "«REDACTED-API-KEY»");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) {
        out[k] = "«REDACTED»";
        continue;
      }
      out[k] = redact(v);
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return null;
  return String(value);
}

const beliefList = (kb) => {
  const values = kb && typeof kb.values === "function" ? [...kb.values()] : [];
  return values.map((b) => ({
    id: b.id,
    kind: b.kind,
    subject: b.subject,
    statement: b.statement,
    confidence: b.confidence,
    status: b.status,
    supersedes: b.supersedes ?? null,
    level: b.level ?? null,
    evidence: b.evidence || [],
  }));
};

// `imageDataUrl` is optional and, when present, dominates the file size —
// callers decide whether the picture is worth including.
export function buildDebugReport({
  shot,
  entry,
  kb,
  ops,
  skipped,
  contradictions,
  settings,
  errors,
  promptVersion,
  dbVersion,
  imageDataUrl,
  stampedAt,
} = {}) {
  const s = shot || {};
  const e = entry || {};
  const answer = e.answer || null;
  const reading = e.reading || null;

  return redact({
    reportVersion: DEBUG_REPORT_VERSION,
    stampedAt: stampedAt || null,
    promptVersion: promptVersion ?? null,
    dbVersion: dbVersion ?? null,

    // What the run was configured to do. The key is never included.
    settings: {
      model: (settings && settings.model) || null,
      kbMax: (settings && settings.kbMax) ?? null,
      withoutKb: Boolean(settings && settings.withoutKb),
      allowCodeExec: Boolean(settings && settings.allowCodeExec),
      autoAnalyze: Boolean(settings && settings.autoAnalyze),
      standingNotes: (settings && settings.standingNotes) || "",
      hasApiKey: Boolean(settings && settings.apiKey),
    },

    screen: {
      level: s.level ?? null,
      solved: Boolean(s.solved),
      note: s.note || "",
      markers: s.markers || [],
      hash: s.hash || null,
      width: s.width ?? null,
      height: s.height ?? null,
      imageIncluded: Boolean(imageDataUrl),
      image: imageDataUrl || null,
    },

    // The two calls, each with the exact prompt text that was sent.
    calls: {
      map: {
        cached: e.readingCached ?? null,
        readHash: e.readHash || null,
        prompt: (reading && reading.promptText) || null,
        reading: reading ? { ...reading, promptText: undefined } : null,
      },
      answer: {
        prompt: (answer && answer.promptText) || null,
        rawText: (answer && answer.rawText) || null,
        reasoning: (answer && answer.thoughts) || null,
        parsed: answer
          ? { ...answer, promptText: undefined, rawText: undefined, thoughts: undefined }
          : null,
        usage: (answer && answer.usage) || null,
        kbSent: e.kbSent || null,
        withoutKb: Boolean(e.withoutKb),
        complaintsSent: e.feedbackUsed || [],
        answerStale: Boolean(e.answerStale),
      },
    },

    // What local validation made of the proposed ops.
    validation: e.pending
      ? {
          accepted: e.pending.accepted || [],
          rejected: e.pending.rejected || [],
          rewritten: e.pending.rewritten || [],
        }
      : null,

    knowledgeBase: {
      beliefs: beliefList(kb),
      opLogLength: Array.isArray(ops) ? ops.length : 0,
      skipped: skipped || [],
      contradictions: (contradictions || []).map((c) => ({
        kind: c.kind,
        subject: c.subject,
        beliefIds: (c.beliefs || []).map((b) => b.id),
      })),
    },

    complaints: e.complaints || [],
    recentErrors: errors || [],
  });
}

// Stable, sortable, and obviously about one screen.
export function debugFilename(shot, stampedAt) {
  const level = shot && shot.level != null ? shot.level : "unknown";
  const stamp = String(stampedAt || "").replace(/[:.]/g, "-").slice(0, 19);
  return `deep-space-debug-level-${level}-${stamp}.json`;
}
