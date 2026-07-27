// deep space — the integration layer.
//
// Everything interesting lives in the modules this file wires together:
//   image.js    capture -> lossless PNG, burned markers, hashes, thumbnails
//   db.js       IndexedDB: shots, cached readings, the append-only op log
//   gemini.js   the two calls per level (map, then answer)
//   kb.js       pure fold + validation; the knowledge base is a derived view
//   sandbox.js  opaque-origin iframe for running model-written JavaScript
//
// The one invariant this file must not break: the map call sees the image and
// the marker legend and NOTHING else. All interpretation happens in the answer
// call, which is what lets readings be cached by content hash and re-reduce be
// a fold instead of a chain of nondeterministic vision calls.

import {
  DB_VERSION,
  openDb,
  putShot,
  getShot,
  allShots,
  deleteShot,
  readingKey,
  putReading,
  getReading,
  putAnalysis,
  allAnalyses,
  appendOps,
  allOps,
  deleteOpsFrom,
  getSetting,
  setSetting,
  storageEstimate,
  requestPersist,
  exportBundle,
  importBundle,
} from "./db.js";

import {
  hashBlob,
  makeThumb,
  burnMarkers,
  markerLegend,
  blobToBase64,
  imageDims,
} from "./image.js";

import {
  BELIEF_KINDS,
  foldOpsDetailed,
  validateOps,
  serializeKb,
  detectContradictions,
  kbStats,
} from "./kb.js";

import {
  DEFAULT_MODEL,
  PROMPT_VERSION,
  listModels,
  mapScreenshot,
  answerLevel,
} from "./gemini.js";

import { runInSandbox } from "./sandbox.js";

import { buildDebugReport, debugFilename } from "./debug.js";

// --------------------------------------------------------------- helpers

const qs = (sel) => document.querySelector(sel);

// Minimal element builder. `text` sets textContent; nothing here ever touches
// innerHTML, so model output cannot inject markup.
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid);
  }
  return node;
};

const clear = (node) => node.replaceChildren();

const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return "unknown";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));

const todayStamp = () => new Date().toISOString().slice(0, 10);

// Validator reasons, said the way a person would say them.
const REASON_TEXT = {
  malformed: "the assistant sent something that was not a proper entry",
  "unknown-op": "the assistant asked for an operation this app does not have",
  "unknown-kind": "the category is not one we recognise",
  "missing-subject": "it did not say what the entry is about",
  "missing-statement": "there was nothing to record",
  "missing-target": "it tried to change an entry without saying which one",
  "unknown-target": "it tried to change an entry that does not exist",
  "target-retracted": "it tried to change an entry that was already withdrawn",
  "already-retracted": "that entry had already been withdrawn",
  duplicate: "we already know this",
};

const reasonText = (r) =>
  `${REASON_TEXT[r.reason] || r.reason}${r.existing ? ` (already recorded as ${r.existing})` : ""}`;

// ----------------------------------------------------------------- state

// How many knowledge-base entries may ride along in one answer prompt. The op
// log exists so the KB can grow for 30+ hours of play; without a cap the whole
// of it enters every prompt, which is the context blow-up the log was meant to
// avoid. serializeKb ranks by confidence, then recency, before it truncates.
const DEFAULT_KB_MAX = 120;

const state = {
  shots: [],
  currentHash: null,
  kb: new Map(),
  ops: [],
  skipped: [], // ops the fold could not apply — reported, never swallowed
  analyses: new Map(), // shot hash -> { reading, answer, pending, withoutKb, codeRun }
  settings: {
    apiKey: "",
    model: DEFAULT_MODEL,
    allowCodeExec: false,
    withoutKb: false,
    kbMax: DEFAULT_KB_MAX,
    autoAnalyze: true,
    standingNotes: "",
  },
  tab: "level",
  revealKey: false,
};

const thumbUrls = new Map();
const currentShot = () =>
  state.shots.find((s) => s.hash === state.currentHash) || null;

const analysisFor = (hash) => {
  if (!state.analyses.has(hash)) state.analyses.set(hash, {});
  return state.analyses.get(hash);
};

// Analyses are derived — but the pending ops inside them are the user's
// undecided work, and a reload used to throw those away along with the
// reading, which also disabled "Re-run with my updated notes". Persisted after
// every change so a refresh costs nothing.
const saveAnalysis = async (hash) => {
  const entry = state.analyses.get(hash);
  if (!hash || !entry) return;
  try {
    await putAnalysis(hash, entry);
  } catch (err) {
    showError(`Could not save this analysis for next time: ${err.message}`);
  }
};

// --------------------------------------------------------------- banners

const banners = () => qs("#banners");

const dismissable = (kind, message) => {
  const box = el(
    "div",
    { class: `banner banner-${kind}`, role: kind === "error" ? "alert" : null },
    el("p", { text: message }),
  );
  const close = el("button", {
    type: "button",
    "aria-label": "dismiss",
    text: "×",
    onclick: () => box.remove(),
  });
  box.append(close);
  banners().append(box);
  return box;
};

// Kept for the debug report: what went wrong, and when, is half of any
// diagnosis and is otherwise lost the moment the banner is dismissed.
const recentErrors = [];

// Errors stay until dismissed. Nothing important is ever console-only.
const showError = (err) => {
  const message =
    typeof err === "string" ? err : err && err.message ? err.message : String(err);
  recentErrors.push({ at: new Date().toISOString(), message });
  if (recentErrors.length > 25) recentErrors.shift();
  dismissable("error", message);
};

const showNote = (message) => {
  const box = dismissable("note", message);
  setTimeout(() => box.remove(), 7000);
};

// Aborts are the user's own doing, not failures.
const isAbort = (err) => Boolean(err) && err.name === "AbortError";

const guard = async (fn) => {
  try {
    await fn();
  } catch (err) {
    if (isAbort(err)) showNote("Stopped.");
    else showError(err);
  }
};

// ------------------------------------------------------------------ busy

let busyController = null;

const setBusyLabel = (label) => {
  qs("#busy-label").textContent = label;
};

// Every long call runs through here: a visible spinner, a label, and a Stop
// button wired to a real AbortController.
const withBusy = async (label, fn) => {
  if (busyController) throw new Error("Something is already running. Wait for it to finish, or press Stop.");
  const controller = new AbortController();
  busyController = controller;
  setBusyLabel(label);
  qs("#busy").hidden = false;
  renderRunBar();
  try {
    return await fn(controller.signal, setBusyLabel);
  } finally {
    busyController = null;
    qs("#busy").hidden = true;
    renderRunBar();
  }
};

// A second press used to raise "Something is already running", which reads as
// an error the user caused. The buttons now say what is happening instead, and
// Stop in the busy bar is the way out.
const renderReadingStale = () => {
  const box = qs("#reading-stale");
  if (!box) return;
  const shot = currentShot();
  const entry = shot ? analysisFor(shot.hash) : null;
  box.hidden = !readingIsStale(entry, state.settings.model || DEFAULT_MODEL);
};

const renderRunBar = () => {
  const running = Boolean(busyController);
  const analyze = qs("#btn-analyze");
  const amend = qs("#btn-amend");
  if (!analyze || !amend) return;
  analyze.disabled = running;
  amend.disabled = running;
  const reread = qs("#btn-reread");
  if (reread) reread.disabled = running;
  analyze.textContent = running ? "Reading\u2026" : "Analyze this screen";
  amend.textContent = running ? "Working\u2026" : "Re-run with my updated notes";
  analyze.title = running ? "Already running — press Stop above to cancel." : "";
};

// ------------------------------------------------------- live transcript

// Shows the answer arriving token by token, and any reasoning the model
// chooses to expose. The app is a wrapper around someone else's model; being
// able to watch it work is most of what makes it trustworthy.
const live = { text: "", thoughts: "" };

const beginLive = () => {
  live.text = "";
  live.thoughts = "";
  qs("#live").hidden = false;
  qs("#live-thinking").hidden = true;
  qs("#live-output").open = true;
  qs("#live-text").textContent = "";
  qs("#live-thoughts").textContent = "";
};

const pushLive = ({ text, thought }) => {
  if (!text) return;
  if (thought) {
    live.thoughts += text;
    const box = qs("#live-thinking");
    box.hidden = false;
    box.open = true;
    const pre = qs("#live-thoughts");
    pre.textContent = live.thoughts;
    pre.scrollTop = pre.scrollHeight;
    return;
  }
  live.text += text;
  const pre = qs("#live-text");
  pre.textContent = live.text;
  pre.scrollTop = pre.scrollHeight;
};

// Once the parsed answer is on screen the raw stream is evidence, not news.
const settleLive = () => {
  if (qs("#live").hidden) return;
  qs("#live-output").open = false;
  qs("#live-output").querySelector("summary").textContent =
    "What Gemini sent back, raw";
  const thinking = qs("#live-thinking");
  if (!thinking.hidden) {
    thinking.open = false;
    thinking.querySelector("summary").textContent = "How it reasoned";
  }
};

// --------------------------------------------------------------- settings

const loadSettings = async () => {
  state.settings.apiKey = await getSetting("apiKey", "");
  state.settings.model = (await getSetting("model", DEFAULT_MODEL)) || DEFAULT_MODEL;
  state.settings.allowCodeExec = Boolean(await getSetting("allowCodeExec", false));
  state.settings.withoutKb = Boolean(await getSetting("withoutKb", false));
  const kbMax = Number(await getSetting("kbMax", DEFAULT_KB_MAX));
  state.settings.kbMax = Number.isFinite(kbMax) && kbMax >= 0 ? kbMax : DEFAULT_KB_MAX;
  state.settings.autoAnalyze = Boolean(await getSetting("autoAnalyze", true));
  state.settings.standingNotes = String(await getSetting("standingNotes", "") || "");
};

// ------------------------------------------------------------ data reload

const reloadShots = async () => {
  state.shots = await allShots();
  if (!state.shots.some((s) => s.hash === state.currentHash)) {
    state.currentHash = state.shots.length ? state.shots[0].hash : null;
  }
};

const reloadKb = async () => {
  state.ops = await allOps();
  const { kb, skipped } = foldOpsDetailed(state.ops.map((entry) => entry.op));
  state.kb = kb;
  state.skipped = skipped;
};

const reloadAnalyses = async () => {
  const rows = await allAnalyses();
  state.analyses = new Map(rows.map((row) => [row.hash, row.entry || {}]));
};

const thumbUrl = (shot) => {
  if (!shot.thumb && !shot.blob) return null;
  if (!thumbUrls.has(shot.hash)) {
    thumbUrls.set(shot.hash, URL.createObjectURL(shot.thumb || shot.blob));
  }
  return thumbUrls.get(shot.hash);
};

// ---------------------------------------------------------------- capture

const nextLevel = () => {
  const numbers = state.shots
    .map((s) => Number(s.level))
    .filter((n) => Number.isFinite(n));
  return numbers.length ? Math.max(...numbers) + 1 : 1;
};

// One entry point for paste, drop, the file picker and getDisplayMedia.
const addShot = async (blob) => {
  if (!blob || !blob.type || !blob.type.startsWith("image/")) {
    showError("That does not look like a picture. Paste a screenshot, or choose a PNG or JPEG file.");
    return;
  }
  await guard(async () => {
    const hash = await hashBlob(blob);
    const existing = await getShot(hash);
    if (existing) {
      state.currentHash = hash;
      openTab("level");
      render();
      showNote(`You already had that exact picture — it is level ${existing.level ?? "?"}.`);
      return;
    }
    // Captured before the store write, so "is this the first level?" is
    // answered by what existed when he pasted, not by what exists after.
    const hadShots = state.shots.length > 0;
    const level = nextLevel();
    const dims = await imageDims(blob);
    const thumb = await makeThumb(blob, 320);
    await putShot({
      hash,
      blob,
      thumb,
      width: dims.width,
      height: dims.height,
      level,
      note: "",
      markers: [],
      solved: false,
    });
    await reloadShots();
    state.currentHash = hash;
    openTab("level");
    render();

    // From the second level onward there is a knowledge base worth applying,
    // so reading the screen is what he wants next every time. The first level
    // still waits: there is nothing remembered yet, and a fresh user should
    // see the screen before anything is spent on their behalf.
    if (hadShots && state.settings.autoAnalyze && state.settings.apiKey) {
      showNote(`Level ${level} added. Reading it now — press Stop if you would rather not.`);
      await analyze();
    }
  });
};

const imageFromClipboard = (event) => {
  const data = event.clipboardData;
  if (!data) return null;
  for (const item of data.items || []) {
    if (item.kind === "file" && String(item.type).startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  for (const file of data.files || []) {
    if (String(file.type).startsWith("image/")) return file;
  }
  return null;
};

// Screen capture: pick the game window once, grab a single frame, stop the
// track immediately so no recording indicator lingers.
const captureScreen = async () => {
  const media = navigator.mediaDevices;
  if (!media || typeof media.getDisplayMedia !== "function") {
    showError("This browser cannot capture the screen. Use a screenshot and paste it instead.");
    return;
  }
  let stream = null;
  try {
    stream = await media.getDisplayMedia({ video: true, audio: false });
  } catch {
    showNote("Screen capture was cancelled.");
    return;
  }
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("The screen capture came back empty. Try again.");
    await addShot(blob);
  } catch (err) {
    showError(err);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
};

// ----------------------------------------------------------- shot editing

const persistShot = async (shot) => {
  await putShot(shot);
};

// Pull the live DOM values into the shot record before anything is sent.
const syncShotFromForm = async () => {
  const shot = currentShot();
  if (!shot) return null;
  const levelValue = qs("#level-number").value.trim();
  const levelNumber = Number(levelValue);
  shot.level =
    levelValue === "" || !Number.isFinite(levelNumber) ? null : levelNumber;
  shot.note = qs("#level-note").value;
  shot.solved = qs("#level-solved").checked;
  shot.markers = (shot.markers || []).map((marker, i) => {
    const input = qs(`#marker-text-${i}`);
    return { ...marker, text: input ? input.value : marker.text || "" };
  });
  await persistShot(shot);
  return shot;
};

const addMarker = async (x, y) => {
  const shot = await syncShotFromForm();
  if (!shot) return;
  const markers = [...(shot.markers || [])];
  markers.push({ x: clamp01(x), y: clamp01(y), label: markers.length + 1, text: "" });
  shot.markers = markers.map((m, i) => ({ ...m, label: i + 1 }));
  await persistShot(shot);
  render();
  const input = qs(`#marker-text-${shot.markers.length - 1}`);
  if (input) input.focus();
};

const removeMarker = async (index) => {
  const shot = await syncShotFromForm();
  if (!shot) return;
  shot.markers = (shot.markers || [])
    .filter((_, i) => i !== index)
    .map((m, i) => ({ ...m, label: i + 1 }));
  await persistShot(shot);
  render();
};

const removeShot = async (shot) => {
  if (!window.confirm(`Delete the screenshot for level ${shot.level ?? "?"}? What it taught the knowledge base is kept.`)) {
    return;
  }
  await deleteShot(shot.hash);
  for (const key of [shot.hash, `full:${shot.hash}`]) {
    const url = thumbUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    thumbUrls.delete(key);
  }
  state.analyses.delete(shot.hash);
  await reloadShots();
  render();
  showNote("Screenshot deleted.");
};

// --------------------------------------------------------------- analysis

const requireKey = () => {
  if (state.settings.apiKey) return true;
  showError("Add your Gemini API key in Settings before analyzing a screen.");
  openTab("settings");
  return false;
};

// ----------------------------------------------------------- key gate

// Nothing in this app does anything without a Gemini key, so the console is
// not rendered at all until there is one — no button to press early, no empty
// state to misread. Clearing the key in Settings puts the gate back.
// Single authority over which of the two top-level regions is on screen.
// Called from boot, from openTab, and whenever the key changes.
const applyKeyGate = () => {
  const needsKey = !state.settings.apiKey;
  // Help stays reachable behind the gate — someone without a key yet is
  // exactly the person most likely to want instructions — so while it is open
  // the guide replaces the gate rather than hiding behind it.
  const showingHelp = needsKey && state.tab === "help";

  qs("#setup-gate").hidden = !needsKey || showingHelp;
  qs("#shell").hidden = needsKey && !showingHelp;

  document.querySelectorAll(".tabs .tab").forEach((tab) => {
    // "Screen" stays enabled while gated so there is a way back to the gate.
    tab.disabled = needsKey && tab.id !== "tab-help" && tab.id !== "tab-level";
  });

  if (needsKey && !showingHelp) qs("#setup-key").focus();
};

const finishSetup = async (key) => {
  if (!key) return;
  state.settings.apiKey = key;
  await setSetting("apiKey", key);
  applyKeyGate();
  renderSettings();
  showNote("Key saved. Paste a screenshot of the game to begin.");
};

// Verify the key against Google before letting the console open — a bad paste
// is far cheaper to catch here than as a confusing failure mid-analysis. A
// network problem must not lock anyone out, hence "Use it anyway".
const saveSetupKey = async () => {
  const key = qs("#setup-key").value.trim();
  const report = qs("#setup-report");
  const anyway = qs("#setup-anyway");
  if (!key) {
    report.textContent = "Paste the key from Google AI Studio first.";
    return;
  }
  report.textContent = "";
  anyway.hidden = true;

  const model = state.settings.model || DEFAULT_MODEL;
  let models = null;
  try {
    models = await withBusy("Checking the key with Google…", (signal) =>
      listModels(key, { signal }),
    );
  } catch (err) {
    if (!isAbort(err)) {
      report.textContent = `${err && err.message ? err.message : String(err)} Try again, or use the key anyway and sort it out in Settings.`;
      anyway.hidden = false;
    }
    return;
  }

  await finishSetup(key);
  if (models && !models.includes(model)) {
    showError(
      `The key works, but it cannot use “${model}”. Pick one of these in Settings: ${models.slice(0, 8).join(", ")}.`,
    );
  }
};

// map (cached by burned-image hash + model + prompt version) -> answer.
// The screenshot is the ground truth; a reading is derived from it. This is
// the only place a reading is produced, so re-reading a picture and answering
// from an existing reading are genuinely separate operations — which is why
// they are separate buttons: one costs a vision call, the other does not.
//
// `force` ignores the cache entirely (the picture is read again even if a
// current reading exists). `reuse` keeps the in-memory reading if the markers
// have not changed since it was made.
const ensureReading = async (shot, model, { reuse = false, force = false, signal } = {}) => {
  const entry = analysisFor(shot.hash);

  // Markers reach the model ONLY through the burned pixels and the map
  // prompt's legend, so a reading taken before a marker was added is not
  // valid for it — the burned hash is what decides.
  const burned = await burnMarkers(shot.blob, shot.markers || []);
  const readHash = await hashBlob(burned);
  const markersChanged = reuse && entry.readHash && entry.readHash !== readHash;
  if (markersChanged) {
    showNote("Your markers changed since the last reading, so the picture is being read again.");
  }

  if (!force && reuse && !markersChanged && entry.reading) {
    entry.readingCached = true;
    return entry.reading;
  }

  let reading = null;
  const cached = force ? null : await getReading(readHash, model, PROMPT_VERSION);
  if (cached) {
    reading = cached.reading;
    entry.readingCached = true;
  } else {
    const imageBase64 = await blobToBase64(burned);
    reading = await mapScreenshot(state.settings.apiKey, model, {
      imageBase64,
      mimeType: "image/png",
      markerLegendText: markerLegend(shot.markers || []),
      signal,
    });
    await putReading({
      key: readingKey(readHash, model, PROMPT_VERSION),
      hash: shot.hash,
      readHash,
      model,
      promptVersion: PROMPT_VERSION,
      reading,
    });
    entry.readingCached = false;
  }

  entry.reading = reading;
  entry.readHash = readHash;
  // Stamped so a later prompt-version bump can be *seen* rather than only
  // silently invalidating the cache key.
  entry.readingPromptVersion = PROMPT_VERSION;
  entry.readingModel = model;
  // Persist now: an abort between the two calls used to lose the reading,
  // disabling "Re-run" after a reload even though it was cached and free.
  await saveAnalysis(shot.hash);
  return reading;
};

// A reading made under an older prompt version, or a different model, is not
// wrong — but it was produced by a question we no longer ask.
const readingIsStale = (entry, model) =>
  Boolean(entry && entry.reading) &&
  (entry.readingPromptVersion !== PROMPT_VERSION || entry.readingModel !== model);

// Map only. No answer call, no ops proposed, nothing to adjudicate.
const rereadScreen = async () => {
  if (!requireKey()) return;
  const shot = await syncShotFromForm();
  if (!shot) return;
  const model = state.settings.model || DEFAULT_MODEL;
  await guard(() =>
    withBusy("Reading the picture again…", async (signal) => {
      await ensureReading(shot, model, { force: true, signal });
      showNote("The picture was read again. Press Analyze to work out an answer from it.");
    }),
  );
  render();
};

// Bulk refresh after a prompt-version bump. Skips screens whose reading is
// already current, so the cost is only what actually changed.
const rereadAll = async () => {
  if (!requireKey()) return;
  const model = state.settings.model || DEFAULT_MODEL;
  const shots = state.shots;
  const stale = shots.filter((s) => readingIsStale(analysisFor(s.hash), model) || !analysisFor(s.hash).reading);
  if (!stale.length) {
    showNote("Every screen has already been read with the current prompts.");
    return;
  }
  if (
    !confirm(
      `Read ${stale.length} screen${stale.length === 1 ? "" : "s"} again with the current prompts?\n\n` +
        `That is ${stale.length} call${stale.length === 1 ? "" : "s"} to Google. Screens already up to date are skipped, and you can press Stop at any point.`,
    )
  )
    return;

  let done = 0;
  await guard(() =>
    withBusy("Re-reading screens…", async (signal, label) => {
      for (const shot of stale) {
        label(`Re-reading level ${shot.level ?? "?"} — ${done + 1} of ${stale.length}…`);
        await ensureReading(shot, model, { force: true, signal });
        done += 1;
      }
    }),
  );
  showNote(
    done === stale.length
      ? `Read ${done} screen${done === 1 ? "" : "s"} again. Their answers are now out of date — press Analyze on the ones you care about.`
      : `Stopped after ${done} of ${stale.length}.`,
  );
  render();
};

const analyze = async ({ reuseReading = false, feedback = "" } = {}) => {
  if (!requireKey()) return;
  const shot = await syncShotFromForm();
  if (!shot) return;
  const model = state.settings.model || DEFAULT_MODEL;
  const entry = analysisFor(shot.hash);

  let failed = false;
  await guard(() =>
    withBusy(reuseReading ? "Thinking about your updated notes…" : "Reading the screen…", async (signal, label) => {
      const reading = await ensureReading(shot, model, {
        reuse: reuseReading,
        signal,
      });

      label("Working out what it means…");
      const withoutKb = state.settings.withoutKb;
      const kbText = withoutKb
        ? ""
        : serializeKb(state.kb, { maxEntries: state.settings.kbMax });
      beginLive();
      const answer = await answerLevel(state.settings.apiKey, model, {
        reading,
        kbText,
        userNote: shot.note,
        standingNotes: state.settings.standingNotes,
        feedback,
        level: shot.level,
        allowCodeExec: state.settings.allowCodeExec,
        shotHash: shot.hash,
        signal,
        onDelta: pushLive,
      });

      entry.answer = answer;
      entry.withoutKb = withoutKb;
      entry.feedbackUsed = Array.isArray(feedback) ? [...feedback] : feedback ? [feedback] : [];
      // A fresh answer is never stale, and the box starts empty for the next
      // complaint — the old text now lives in the list above it.
      entry.answerStale = false;
      entry.feedbackDraft = "";
      const knownTotal = [...state.kb.values()].filter(
        (b) => b.status === "active",
      ).length;
      entry.kbSent = {
        sent: withoutKb ? 0 : Math.min(knownTotal, state.settings.kbMax),
        total: knownTotal,
      };
      entry.pending = validateOps(answer.ops, state.kb);
      entry.codeRun = null;
      await saveAnalysis(shot.hash);
      settleLive();
    }).catch((err) => {
      // guard() will report it; we only need to know it did not succeed, so
      // the answer still on screen is not mistaken for the retry's result.
      failed = true;
      throw err;
    }),
  );
  if (failed && entry.answer) {
    entry.answerStale = true;
    await saveAnalysis(shot.hash);
  }
  render();
};

const amend = async () => {
  const shot = currentShot();
  if (!shot) return;
  const entry = analysisFor(shot.hash);
  if (!entry.reading) {
    showNote("Nothing to re-run yet — press “Analyze this screen” first.");
    return;
  }
  await analyze({ reuseReading: true });
};

// ------------------------------------------------------------- op actions

const appendOp = async (op, source) => {
  const shot = currentShot();
  const check = validateOps([op], state.kb);
  if (!check.accepted.length) {
    const why = check.rejected[0] ? reasonText(check.rejected[0]) : "it is no longer valid";
    showError(`That entry could not be added: ${why}.`);
    return false;
  }
  await appendOps([
    {
      level: shot ? shot.level : null,
      shotHash: shot ? shot.hash : null,
      op: check.accepted[0],
      source,
    },
  ]);
  await reloadKb();
  return true;
};

const dropPendingOp = (entry, bucket, index) => {
  entry.pending = {
    ...entry.pending,
    [bucket]: entry.pending[bucket].filter((_, i) => i !== index),
  };
};

const acceptPending = async (entry, bucket, index) => {
  const item = entry.pending[bucket][index];
  const op = bucket === "rewritten" ? item.to : item;
  await guard(async () => {
    if (await appendOp(op, "model")) {
      dropPendingOp(entry, bucket, index);
      await saveAnalysis(state.currentHash);
      render();
    }
  });
};

const rejectPending = (entry, bucket, index) => {
  dropPendingOp(entry, bucket, index);
  void saveAnalysis(state.currentHash);
  render();
};

const acceptAll = async (entry) => {
  await guard(async () => {
    const queue = [...entry.pending.accepted];
    let added = 0;
    // Ops that fail the second validation used to be skipped in silence, so
    // "Add all 6" could report six and record four. Anything refused here goes
    // back on the pile as a rejection card with its reason.
    const refused = [];
    for (const op of queue) {
      const check = validateOps([op], state.kb);
      if (!check.accepted.length) {
        refused.push(check.rejected[0] || { op, reason: "malformed" });
        continue;
      }
      const shot = currentShot();
      await appendOps([
        {
          level: shot ? shot.level : null,
          shotHash: shot ? shot.hash : null,
          op: check.accepted[0],
          source: "model",
        },
      ]);
      await reloadKb();
      added += 1;
    }
    entry.pending = {
      ...entry.pending,
      accepted: [],
      rejected: [...entry.pending.rejected, ...refused],
    };
    await saveAnalysis(state.currentHash);
    render();
    showNote(
      `Added ${added} entr${added === 1 ? "y" : "ies"} to the knowledge base.${
        refused.length
          ? ` ${refused.length} could not be added — see “Turned down by the checker”.`
          : ""
      }`,
    );
  });
};

const retractBelief = async (belief, reason) => {
  await guard(async () => {
    const check = validateOps(
      [{ op: "retract", target: belief.id, reason, level: belief.level }],
      state.kb,
    );
    if (!check.accepted.length) {
      showError("That entry could not be withdrawn — it may already be gone.");
      return;
    }
    await appendOps([
      {
        level: belief.level,
        shotHash: (belief.evidence || [])[0] || null,
        op: check.accepted[0],
        source: "user",
      },
    ]);
    await reloadKb();
    render();
  });
};

// Rebuild the whole knowledge base from the op log and report the delta. The
// fold is deterministic, so a clean run reports zeros — that is the point.
const reReduce = async () => {
  await guard(async () => {
    const before = state.kb;
    const ops = await allOps();
    const { kb: after, skipped } = foldOpsDetailed(ops.map((entry) => entry.op));
    const signature = (b) =>
      `${b.status}|${b.kind}|${b.subject}|${b.statement}|${b.confidence}`;
    let added = 0;
    let changed = 0;
    let removed = 0;
    for (const [id, belief] of after) {
      const old = before.get(id);
      if (!old) added += 1;
      else if (signature(old) !== signature(belief)) changed += 1;
    }
    for (const id of before.keys()) if (!after.has(id)) removed += 1;
    state.ops = ops;
    state.kb = after;
    state.skipped = skipped;
    render();
    qs("#rereduce-report").textContent =
      `Rebuilt ${after.size} entr${after.size === 1 ? "y" : "ies"} from ${ops.length} recorded change${ops.length === 1 ? "" : "s"} — ${added} added, ${removed} removed, ${changed} different.${
        skipped.length
          ? ` ${skipped.length} recorded change${skipped.length === 1 ? " could" : "s could"} not be applied — see below.`
          : ""
      }`;
  });
};

// The one way back out of a bad accept. The log stays append-only in normal
// use; this is an explicit, confirmed amputation of its tail, and the KB is a
// fold, so undoing the op undoes everything it implied.
const undoLastOp = async () => {
  await guard(async () => {
    const ops = await allOps();
    const last = ops[ops.length - 1];
    if (!last) {
      showNote("There is nothing to undo — no changes have been recorded yet.");
      return;
    }
    const what = opSummary(last.op || {});
    if (!window.confirm(`Undo the last recorded change?\n\n${what}\n\nEverything that followed from it is rebuilt without it.`)) {
      return;
    }
    await deleteOpsFrom(last.seq);
    await reloadKb();
    render();
    qs("#rereduce-report").textContent = `Undone: ${what}`;
    showNote("The last recorded change has been undone.");
  });
};

// ------------------------------------------------------------------- code

const runCodeLocally = async () => {
  const shot = currentShot();
  if (!shot) return;
  const entry = analysisFor(shot.hash);
  const code = entry.answer && entry.answer.code;
  if (!code) return;
  if (code.language !== "javascript") {
    showError("This program is Python, so it cannot run on this computer. Turn on server-side execution and analyze again to have Google run it.");
    return;
  }
  await guard(() =>
    withBusy("Running the program in a sealed sandbox…", async () => {
      entry.codeRun = await runInSandbox(
        code.source,
        { level: shot.level, note: shot.note },
        { timeoutMs: 4000 },
      );
      await saveAnalysis(shot.hash);
    }),
  );
  render();
};

const copyCode = async (source) => {
  try {
    await navigator.clipboard.writeText(source);
    showNote("Program copied to the clipboard.");
  } catch {
    showError("This browser would not let the page copy to the clipboard. Select the text and copy it by hand.");
  }
};

// --------------------------------------------------------------- settings

const checkModel = async () => {
  const key = qs("#api-key").value.trim();
  const model = qs("#model-name").value.trim() || DEFAULT_MODEL;
  state.settings.apiKey = key;
  state.settings.model = model;
  await setSetting("apiKey", key);
  await setSetting("model", model);
  const report = qs("#model-report");
  report.textContent = "";
  await guard(() =>
    withBusy("Asking Google which models this key can use…", async (signal) => {
      const models = await listModels(key, { signal });
      if (models.includes(model)) {
        report.textContent = `“${model}” is available to this key. ${models.length} usable model${models.length === 1 ? "" : "s"} in total.`;
        return;
      }
      report.textContent = `This key cannot use “${model}”. It can use: ${models.slice(0, 12).join(", ")}${models.length > 12 ? ", and more" : ""}.`;
    }),
  );
};

const refreshStorage = async () => {
  const report = qs("#storage-report");
  try {
    const { usage, quota, persisted } = await storageEstimate();
    const shots = state.shots.length;
    const used = usage === null ? "an unknown amount" : fmtBytes(usage);
    const room = quota === null ? "unknown" : fmtBytes(quota);
    report.textContent = `${shots} screenshot${shots === 1 ? "" : "s"}, ${state.ops.length} recorded change${state.ops.length === 1 ? "" : "s"}. Using ${used} of about ${room}. Storage is ${persisted ? "permanent" : "not permanent — the browser may throw it away if the disk fills up"}.`;
  } catch (err) {
    report.textContent = `Could not read the storage numbers: ${err.message}`;
  }
};

const makePersistent = async () => {
  await guard(async () => {
    const ok = await requestPersist();
    showNote(
      ok
        ? "Storage is now permanent on this computer."
        : "The browser declined. Installing this page as an app usually makes it grant permanent storage.",
    );
    await refreshStorage();
  });
};

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Could not read the picture."));
    reader.readAsDataURL(blob);
  });

const doExport = async () => {
  await guard(async () => {
    const blob = await exportBundle();
    downloadBlob(blob, `deep-space-backup-${todayStamp()}.json`);
    showNote("Backup saved. It contains your screenshots and everything learned — but not your API key.");
  });
};

const doImport = async (file) => {
  if (!file) return;
  await guard(async () => {
    const counts = await importBundle(file);
    await reloadShots();
    await reloadKb();
    render();
    await refreshStorage();
    showNote(`Restored ${counts.shots} screenshot${counts.shots === 1 ? "" : "s"} and ${counts.ops} recorded change${counts.ops === 1 ? "" : "s"}.`);
  });
};

// ----------------------------------------------------------------- render

const openTab = (tab) => {
  state.tab = tab;
  for (const name of ["level", "kb", "settings", "help"]) {
    qs(`#tab-${name}`).setAttribute("aria-pressed", String(name === tab));
    qs(`#panel-${name}`).hidden = name !== tab;
  }
  if (tab === "settings") void refreshStorage();
  // The gate decides what is on screen, and that depends on which tab is open.
  applyKeyGate();
};

const pasteKey = () => (/Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘V" : "Ctrl+V");

// Always tells you how to add the *next* level, not just the first one.
const renderAddHint = () => {
  const hint = qs("#level-empty");
  clear(hint);
  if (state.shots.length === 0) {
    hint.append(
      document.createTextNode("Nothing captured yet. Press "),
      el("kbd", { text: pasteKey() }),
      document.createTextNode(" anywhere on this page to paste your first screenshot."),
    );
    return;
  }
  hint.append(
    document.createTextNode("Finished this one? Press "),
    el("kbd", { text: pasteKey() }),
    document.createTextNode(
      ` anywhere to paste the next screen — it becomes level ${nextLevel()}.`,
    ),
  );
};

const renderSidebar = () => {
  const list = qs("#level-list");
  clear(list);
  renderAddHint();

  for (const shot of state.shots) {
    const url = thumbUrl(shot);
    const item = el(
      "button",
      {
        type: "button",
        class: "level-item",
        "aria-current": String(shot.hash === state.currentHash),
        onclick: () => {
          state.currentHash = shot.hash;
          openTab("level");
          render();
        },
      },
      url
        ? el("img", { class: "thumb", src: url, alt: "" })
        : el("span", { class: "thumb" }),
      el(
        "span",
        { class: "level-meta" },
        el("span", { class: "level-no", text: `Level ${shot.level ?? "—"}` }),
        el("span", {
          class: `level-state${shot.solved ? " solved" : ""}`,
          text: shot.solved ? "solved" : "unsolved",
        }),
      ),
    );
    list.append(el("li", {}, item));
  }
};

const renderMarkers = (shot) => {
  const stage = qs("#shot-stage");
  clear(stage);

  const url = thumbUrls.get(`full:${shot.hash}`) || URL.createObjectURL(shot.blob);
  thumbUrls.set(`full:${shot.hash}`, url);

  const img = el("img", {
    src: url,
    alt: `the game screen you captured for level ${shot.level ?? "?"}`,
    onclick: (event) => {
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      void addMarker(
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height,
      );
    },
  });
  const layer = el("div", { class: "markers" });
  (shot.markers || []).forEach((marker, i) => {
    layer.append(
      el("button", {
        type: "button",
        class: "marker-chip",
        title: "remove this marker",
        text: String(marker.label ?? i + 1),
        onclick: (event) => {
          event.stopPropagation();
          void removeMarker(i);
        },
      }),
    );
  });
  Array.from(layer.children).forEach((chip, i) => {
    const marker = (shot.markers || [])[i] || { x: 0, y: 0 };
    chip.style.left = `${clamp01(marker.x) * 100}%`;
    chip.style.top = `${clamp01(marker.y) * 100}%`;
  });
  stage.append(img, layer);

  const rows = qs("#marker-list");
  clear(rows);
  (shot.markers || []).forEach((marker, i) => {
    rows.append(
      el(
        "div",
        { class: "marker-row" },
        el("span", { class: "marker-badge", text: String(marker.label ?? i + 1) }),
        el("input", {
          type: "text",
          id: `marker-text-${i}`,
          value: marker.text || "",
          placeholder: "what should the assistant look at here?",
          "aria-label": `note for marker ${marker.label ?? i + 1}`,
          onchange: () => void syncShotFromForm(),
        }),
        el("button", {
          type: "button",
          class: "btn btn-quiet btn-small danger",
          text: "Remove",
          onclick: () => void removeMarker(i),
        }),
      ),
    );
  });
};

const renderReading = (reading) => {
  const box = qs("#answer-reading");
  clear(box);
  if (!reading) {
    box.append(el("p", { class: "empty-line", text: "No reading yet." }));
    return;
  }
  const block = (title, items) => {
    if (!items || !items.length) return;
    box.append(
      el(
        "div",
        { class: "reading-block" },
        el("h4", { text: title }),
        el("ul", {}, items.map((line) => el("li", { text: line }))),
      ),
    );
  };
  // Signal first, story second, everything else after — the same ordering the
  // answer prompt is told to weight them by.
  block("The transmission itself", reading.transmissionContent);
  block("Story text (not part of the puzzle)", reading.narrativeText);
  block("Other text on screen", reading.screenText);
  block(
    "Symbols",
    (reading.glyphs || []).map(
      (g) => `${g.shape} — ${g.position}${g.count > 1 ? ` (×${g.count})` : ""}`,
    ),
  );
  if (reading.layout) {
    box.append(
      el(
        "div",
        { class: "reading-block" },
        el("h4", { text: "Layout" }),
        el("p", { text: reading.layout }),
      ),
    );
  }
  block("Things that look clickable", reading.affordances);
  block("Colours", reading.colors);
  block("Other observations", reading.observations);
};

// A malformed op is exactly the case this panel exists to show, so it must
// still read as English — never "target → undefined".
const orNothing = (v, fallback) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s || fallback;
};

const opSummary = (op) => {
  if (op.op === "assert") {
    return `${orNothing(op.subject, "(no subject given)")}: ${orNothing(op.statement, "(no statement given)")}`;
  }
  if (op.op === "revise") {
    const target = orNothing(op.target, "(no entry named)");
    const statement = orNothing(op.statement, "(no replacement statement given)");
    return `${target} → ${statement}${op.reason ? ` (because ${op.reason})` : ""}`;
  }
  if (op.op === "retract") {
    return `${orNothing(op.target, "(no entry named)")}${op.reason ? ` — ${op.reason}` : ""}`;
  }
  return JSON.stringify(op);
};

const opCard = (op, extraClass, actions, why) =>
  el(
    "div",
    { class: `op-card${extraClass ? ` ${extraClass}` : ""}` },
    el(
      "div",
      { class: "op-body" },
      el(
        "div",
        {},
        el("span", { class: "op-kind", text: op && op.op ? op.op : "?" }),
        op && op.kind ? el("span", { class: "conf", text: op.kind }) : null,
        op && op.confidence
          ? el("span", { class: `conf conf-${op.confidence}`, text: op.confidence })
          : null,
      ),
      el("p", { class: "op-statement", text: op ? opSummary(op) : "(unreadable)" }),
      why ? el("p", { class: "op-why", text: why }) : null,
    ),
    actions ? el("div", { class: "op-actions" }, actions) : null,
  );

const renderOps = (entry) => {
  const box = qs("#ops-review");
  clear(box);
  const pending = entry.pending;
  if (!pending) {
    box.append(el("p", { class: "empty-line", text: "Nothing proposed yet." }));
    return;
  }

  const group = (title, nodes, head) => {
    if (!nodes.length) return;
    box.append(el("div", { class: "op-group" }, el("h4", { text: title }), head, nodes));
  };

  group(
    `Ready to add (${pending.accepted.length})`,
    pending.accepted.map((op, i) =>
      opCard(op, null, [
        el("button", {
          type: "button",
          class: "btn btn-small btn-yes",
          text: "Add",
          onclick: () => void acceptPending(entry, "accepted", i),
        }),
        el("button", {
          type: "button",
          class: "btn btn-quiet btn-small",
          text: "Discard",
          onclick: () => rejectPending(entry, "accepted", i),
        }),
      ]),
    ),
    pending.accepted.length > 1
      ? el(
          "p",
          {},
          el("button", {
            type: "button",
            class: "btn btn-small",
            text: `Add all ${pending.accepted.length}`,
            onclick: () => void acceptAll(entry),
          }),
        )
      : null,
  );

  // Rejected ops get no "Add": the checker has already refused them, and
  // re-offering it would just fail with the same reason. Where the refusal is
  // recoverable the rewrite below is the accept path. Dismiss clears the card.
  group(
    `Turned down by the checker (${pending.rejected.length})`,
    pending.rejected.map((r, i) =>
      opCard(
        r.op,
        "is-rejected",
        [
          el("button", {
            type: "button",
            class: "btn btn-quiet btn-small",
            text: "Dismiss",
            onclick: () => rejectPending(entry, "rejected", i),
          }),
        ],
        reasonText(r),
      ),
    ),
  );

  group(
    `Offered as new entries instead (${pending.rewritten.length})`,
    pending.rewritten.map((w, i) =>
      opCard(
        w.to,
        "is-rewritten",
        [
          el("button", {
            type: "button",
            class: "btn btn-small btn-yes",
            text: "Add",
            onclick: () => void acceptPending(entry, "rewritten", i),
          }),
          el("button", {
            type: "button",
            class: "btn btn-quiet btn-small",
            text: "Discard",
            onclick: () => rejectPending(entry, "rewritten", i),
          }),
        ],
        `The assistant tried to change ${w.from.target || "an entry"} that is not there, so it has been rewritten as a new entry.`,
      ),
    ),
  );

  if (!box.children.length) {
    box.append(
      el("p", {
        class: "empty-line",
        text: "Nothing left to decide — every proposed change has been handled.",
      }),
    );
  }
};

const renderCode = (entry) => {
  const panel = qs("#code-panel");
  const answer = entry.answer;
  const code = answer && answer.code;
  const serverRuns = (answer && answer.serverExecutions) || [];
  panel.hidden = !code && !serverRuns.length;
  if (panel.hidden) return;

  qs("#code-purpose").textContent = code
    ? `${code.purpose || "A program the assistant wrote."}${code.expectedShape ? ` It should return: ${code.expectedShape}.` : ""} Language: ${code.language}.`
    : "The assistant ran code on Google's servers for this answer.";
  qs("#code-source").textContent = code ? code.source : "";
  qs("#btn-run-code").disabled = !code || code.language !== "javascript";
  qs("#btn-copy-code").disabled = !code;
  qs("#btn-toggle-exec").textContent = `Server-side execution: ${state.settings.allowCodeExec ? "on" : "off"}`;

  const result = qs("#code-result");
  clear(result);
  if (entry.codeRun) {
    const run = entry.codeRun;
    result.append(
      el(
        "div",
        { class: `result-block${run.ok ? "" : " bad"}` },
        el("h4", { text: run.ok ? "Result (run on this computer)" : "It did not run" }),
        el("pre", {
          text: run.ok ? JSON.stringify(run.result, null, 2) : run.error,
        }),
        run.logs && run.logs.length
          ? el("pre", { text: run.logs.join("\n") })
          : null,
      ),
    );
  }

  const server = qs("#server-exec");
  clear(server);
  for (const run of serverRuns) {
    server.append(
      el(
        "div",
        { class: "result-block" },
        el("h4", { text: `Ran on Google's servers (${run.language})` }),
        el("pre", { text: run.code }),
        el("pre", { text: run.output || run.outcome || "(no output)" }),
      ),
    );
  }
};

const renderAnswer = (entry) => {
  const box = qs("#answer");
  const answer = entry.answer;
  box.hidden = !answer;
  if (!answer) return;

  qs("#baseline-flag").hidden = !entry.withoutKb;

  // The reading cache is the reason re-running is cheap; say so, or the win is
  // invisible and the user assumes every Analyze costs a fresh look at the
  // picture.
  const provenance = [];
  if (entry.readingCached === true)
    provenance.push("The picture was not read again — the earlier reading was reused.");
  else if (entry.readingCached === false)
    provenance.push("The picture was read fresh.");
  if (entry.kbSent && !entry.withoutKb) {
    provenance.push(
      entry.kbSent.sent < entry.kbSent.total
        ? `Sent ${entry.kbSent.sent} of ${entry.kbSent.total} remembered entries (the rest were over the limit set in Settings).`
        : `Sent all ${entry.kbSent.total} remembered entr${entry.kbSent.total === 1 ? "y" : "ies"}.`,
    );
  }
  qs("#answer-provenance").textContent = provenance.join(" ");

  qs("#stale-flag").hidden = !entry.answerStale;

  const fb = qs("#answer-feedback");
  if (document.activeElement !== fb) fb.value = entry.feedbackDraft || "";

  // Every complaint made about this screen, all of which go out with each
  // retry. Removable, because a complaint the model has clearly absorbed is
  // just prompt weight.
  const list = qs("#complaint-list");
  clear(list);
  const complaints = entry.complaints || [];
  if (complaints.length) {
    list.append(
      el("p", {
        class: "hint",
        text: `Sent with every retry of this screen (${complaints.length}):`,
      }),
    );
    complaints.forEach((c, i) => {
      list.append(
        el(
          "div",
          { class: "complaint" },
          el("span", { text: `${i + 1}. ${c}` }),
          el("button", {
            type: "button",
            class: "btn btn-quiet",
            text: "Remove",
            onclick: () => {
              complaints.splice(i, 1);
              void saveAnalysis(state.currentHash);
              render();
            },
          }),
        ),
      );
    });
  }

  qs("#sent-map").textContent =
    (entry.reading && entry.reading.promptText) ||
    "(reused from an earlier run — the picture was not read again)";
  qs("#sent-answer").textContent =
    answer.promptText || "(not recorded for this answer)";

  qs("#answer-summary").textContent = answer.summary || "(nothing said)";
  qs("#answer-move").textContent = answer.proposedMove || "(no move proposed)";
  qs("#answer-reply").textContent = answer.proposedReply || "(no reply proposed)";

  const hyp = qs("#answer-hypotheses");
  clear(hyp);
  if (!answer.hypotheses.length) {
    hyp.append(el("p", { class: "empty-line", text: "No hypotheses offered." }));
  }
  for (const h of answer.hypotheses) {
    hyp.append(
      el(
        "div",
        { class: "hyp" },
        el(
          "p",
          { class: "hyp-claim" },
          el("span", { class: `conf conf-${h.confidence}`, text: h.confidence }),
          h.claim,
        ),
        el("p", { class: "hyp-why", text: h.rationale }),
      ),
    );
  }

  renderOps(entry);
  renderCode(entry);
  renderReading(entry.reading);
};

const renderLevel = () => {
  const shot = currentShot();
  qs("#level-empty-state").hidden = Boolean(shot);
  qs("#level-body").hidden = !shot;
  if (!shot) return;

  qs("#level-title").textContent = `Level ${shot.level ?? "—"}`;
  qs("#level-number").value = shot.level ?? "";
  qs("#level-note").value = shot.note || "";
  qs("#level-solved").checked = Boolean(shot.solved);
  qs("#opt-nokb").checked = state.settings.withoutKb;
  qs("#opt-codeexec").checked = state.settings.allowCodeExec;

  renderMarkers(shot);

  const entry = analysisFor(shot.hash);
  qs("#btn-amend").disabled = !entry.reading;
  renderAnswer(entry);
};

const provenanceLinks = (belief) => {
  const hashes = belief.evidence || [];
  if (!hashes.length) return [el("span", { class: "prov-none", text: "no source recorded" })];
  return hashes.map((hash) => {
    const shot = state.shots.find((s) => s.hash === hash);
    return el("button", {
      type: "button",
      class: "prov-link",
      text: shot ? `from level ${shot.level ?? "?"}` : `from ${hash.slice(0, 8)}…`,
      disabled: !shot,
      onclick: () => {
        if (!shot) return;
        state.currentHash = shot.hash;
        openTab("level");
        render();
      },
    });
  });
};

const beliefCard = (belief, retired) =>
  el(
    "div",
    { class: "belief" },
    el(
      "div",
      { class: "belief-body" },
      el(
        "div",
        {},
        el("span", { class: "belief-id", text: belief.id }),
        el("span", { class: `conf conf-${belief.confidence}`, text: belief.confidence }),
        el("span", { class: "belief-subject", text: belief.subject }),
      ),
      el("p", { class: "belief-statement", text: belief.statement }),
      belief.reason ? el("p", { class: "hint", text: `Reason: ${belief.reason}` }) : null,
      el("div", { class: "belief-prov" }, provenanceLinks(belief)),
    ),
    retired
      ? null
      : el(
          "div",
          { class: "op-actions" },
          el("button", {
            type: "button",
            class: "btn btn-quiet btn-small danger",
            text: "Withdraw",
            onclick: () => void retractBelief(belief, "withdrawn by hand"),
          }),
        ),
  );

const renderKb = () => {
  const stats = kbStats(state.kb);
  const badge = qs("#kb-count");
  badge.textContent = String(stats.active);
  badge.className = stats.contradictions ? "pill warn" : "pill";

  qs("#kb-summary").textContent =
    `${stats.active} active entr${stats.active === 1 ? "y" : "ies"}, ${stats.retracted} withdrawn, built from ${state.ops.length} recorded change${state.ops.length === 1 ? "" : "s"}.`;

  const clashes = detectContradictions(state.kb);
  const clashBox = qs("#contradictions");
  clashBox.hidden = clashes.length === 0;
  const clashList = qs("#contradiction-list");
  clear(clashList);
  for (const clash of clashes) {
    const [a, b] = clash.beliefs;
    const side = (keep, drop) =>
      el(
        "div",
        { class: "clash-side" },
        el("p", { text: keep.statement }),
        el("p", { class: "hint", text: `${keep.id} · ${keep.confidence} confidence` }),
        el("button", {
          type: "button",
          class: "btn btn-small btn-yes",
          text: "Keep this one",
          onclick: () =>
            void retractBelief(drop, `contradicted ${keep.id}, which the player kept`),
        }),
      );
    clashList.append(
      el(
        "div",
        { class: "clash" },
        side(a, b),
        side(b, a),
      ),
    );
  }

  const active = [];
  const retired = [];
  for (const belief of state.kb.values()) {
    (belief.status === "active" ? active : retired).push(belief);
  }

  const list = qs("#kb-list");
  clear(list);
  if (!active.length) {
    list.append(
      el("p", {
        class: "empty-line",
        text: "Nothing learned yet. Analyze a screen and add what the assistant proposes.",
      }),
    );
  }
  const kinds = [
    ...BELIEF_KINDS,
    ...new Set(active.map((b) => b.kind).filter((k) => !BELIEF_KINDS.includes(k))),
  ];
  for (const kind of kinds) {
    const group = active.filter((b) => b.kind === kind);
    if (!group.length) continue;
    list.append(
      el(
        "div",
        { class: "kb-group" },
        el("h4", { text: `${kind} (${group.length})` }),
        group.map((b) => beliefCard(b, false)),
      ),
    );
  }

  // Ops the fold could not apply. Normally empty; after an import or an undo
  // it is the only place a dropped change is visible at all.
  const skippedBox = qs("#skipped-ops");
  const skippedList = qs("#skipped-list");
  clear(skippedList);
  skippedBox.hidden = state.skipped.length === 0;
  for (const s of state.skipped) {
    skippedList.append(
      el(
        "div",
        { class: "op-card is-rejected" },
        el(
          "div",
          { class: "op-body" },
          el("p", { class: "op-statement", text: opSummary(s.op || {}) }),
          el("p", { class: "op-why", text: reasonText(s) }),
        ),
      ),
    );
  }

  const retiredBox = qs("#kb-retired");
  clear(retiredBox);
  if (!retired.length) {
    retiredBox.append(el("p", { class: "empty-line", text: "Nothing withdrawn." }));
  }
  for (const belief of retired) retiredBox.append(beliefCard(belief, true));
};

const renderSettings = () => {
  const keyField = qs("#api-key");
  if (document.activeElement !== keyField) keyField.value = state.settings.apiKey || "";
  keyField.type = state.revealKey ? "text" : "password";
  qs("#btn-reveal").textContent = state.revealKey ? "Hide" : "Show";
  const modelField = qs("#model-name");
  if (document.activeElement !== modelField) modelField.value = state.settings.model;
  const kbMaxField = qs("#kb-max");
  if (document.activeElement !== kbMaxField)
    kbMaxField.value = String(state.settings.kbMax);
  qs("#auto-analyze").checked = state.settings.autoAnalyze;

  const model = state.settings.model || DEFAULT_MODEL;
  const behind = state.shots.filter((sh) => {
    const e = state.analyses.get(sh.hash);
    return e && e.reading && readingIsStale(e, model);
  }).length;
  const never = state.shots.filter((sh) => {
    const e = state.analyses.get(sh.hash);
    return !e || !e.reading;
  }).length;
  qs("#reread-report").textContent = behind
    ? `${behind} screen${behind === 1 ? " was" : "s were"} read with older prompts${never ? `, ${never} never read` : ""}.`
    : never
      ? `${never} screen${never === 1 ? " has" : "s have"} never been read.`
      : "Every screen is up to date with the current prompts.";
  const standingField = qs("#standing-notes");
  if (document.activeElement !== standingField)
    standingField.value = state.settings.standingNotes || "";
};

const render = () => {
  renderSidebar();
  renderLevel();
  renderReadingStale();
  renderRunBar();
  renderKb();
  renderSettings();
};

// ------------------------------------------------------------------ wiring

const wire = () => {
  qs("#tab-level").addEventListener("click", () => openTab("level"));
  qs("#tab-kb").addEventListener("click", () => openTab("kb"));
  qs("#tab-settings").addEventListener("click", () => openTab("settings"));
  qs("#tab-help").addEventListener("click", () => openTab("help"));

  qs("#busy-cancel").addEventListener("click", () => {
    if (busyController) busyController.abort();
  });

  // Paste is the primary capture path: anywhere on the page, always live.
  document.addEventListener("paste", (event) => {
    const file = imageFromClipboard(event);
    if (!file) return;
    event.preventDefault();
    void addShot(file);
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    document.body.classList.add("dropping");
  });
  window.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) document.body.classList.remove("dropping");
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    document.body.classList.remove("dropping");
    const file = (event.dataTransfer && event.dataTransfer.files[0]) || null;
    if (file) void addShot(file);
  });

  qs("#file-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) void addShot(file);
  });

  qs("#btn-capture").addEventListener("click", () => void captureScreen());

  qs("#level-number").addEventListener("change", () => {
    void guard(async () => {
      await syncShotFromForm();
      await reloadShots();
      render();
    });
  });
  qs("#level-note").addEventListener("change", () => void syncShotFromForm());
  qs("#level-solved").addEventListener("change", () => {
    void guard(async () => {
      await syncShotFromForm();
      render();
    });
  });
  qs("#btn-delete-shot").addEventListener("click", () => {
    const shot = currentShot();
    if (shot) void guard(() => removeShot(shot));
  });

  qs("#btn-analyze").addEventListener("click", () => void analyze());
  qs("#btn-amend").addEventListener("click", () => void amend());

  qs("#opt-nokb").addEventListener("change", (event) => {
    state.settings.withoutKb = event.target.checked;
    void setSetting("withoutKb", state.settings.withoutKb);
  });
  const setCodeExec = (value) => {
    state.settings.allowCodeExec = value;
    void setSetting("allowCodeExec", value);
    render();
  };
  qs("#opt-codeexec").addEventListener("change", (event) =>
    setCodeExec(event.target.checked),
  );
  qs("#btn-toggle-exec").addEventListener("click", () =>
    setCodeExec(!state.settings.allowCodeExec),
  );

  qs("#btn-run-code").addEventListener("click", () => void runCodeLocally());
  qs("#btn-copy-code").addEventListener("click", () => {
    const shot = currentShot();
    const entry = shot ? analysisFor(shot.hash) : null;
    const code = entry && entry.answer && entry.answer.code;
    if (code) void copyCode(code.source);
  });

  qs("#btn-rereduce").addEventListener("click", () => void reReduce());
  qs("#btn-undo-op").addEventListener("click", () => void undoLastOp());

  qs("#btn-reveal").addEventListener("click", () => {
    state.revealKey = !state.revealKey;
    renderSettings();
  });
  // The key is written on blur and never logged, echoed, or exported.
  qs("#api-key").addEventListener("change", (event) => {
    state.settings.apiKey = event.target.value.trim();
    void setSetting("apiKey", state.settings.apiKey);
    applyKeyGate();
  });

  qs("#auto-analyze").addEventListener("change", (event) => {
    state.settings.autoAnalyze = event.target.checked;
    void setSetting("autoAnalyze", state.settings.autoAnalyze);
  });

  qs("#answer-feedback").addEventListener("input", (event) => {
    const entry = state.currentHash ? analysisFor(state.currentHash) : null;
    if (entry) entry.feedbackDraft = event.target.value;
  });

  // A complaint is the most specific signal there is: the user has seen a real
  // attempt and said what is wrong with it. Retry reuses the cached reading, so
  // this costs one answer call, not a fresh look at the picture.
  // Complaints accumulate for the screen. Sending only the newest one lets the
  // model fix that and regress on an earlier one it can no longer see — there
  // are no conversational turns, so nothing else remembers them.
  qs("#btn-reread").addEventListener("click", () => void rereadScreen());
  qs("#btn-reread-all").addEventListener("click", () => void rereadAll());

  qs("#btn-debug").addEventListener("click", () => {
    void guard(async () => {
      const shot = await syncShotFromForm();
      if (!shot) {
        showError("Open a screen first, then save a debug report for it.");
        return;
      }
      const entry = analysisFor(shot.hash);
      const withImage = qs("#debug-image").checked;
      const stampedAt = new Date().toISOString();

      const report = buildDebugReport({
        shot,
        entry,
        kb: state.kb,
        ops: state.ops,
        skipped: state.skipped,
        contradictions: detectContradictions(state.kb),
        settings: state.settings,
        errors: recentErrors,
        promptVersion: PROMPT_VERSION,
        dbVersion: DB_VERSION,
        imageDataUrl: withImage && shot.blob ? await blobToDataUrl(shot.blob) : null,
        stampedAt,
      });

      const blob = new Blob([JSON.stringify(report, null, 2)], {
        type: "application/json",
      });
      downloadBlob(blob, debugFilename(shot, stampedAt));
      showNote(
        `Debug report saved (${fmtBytes(blob.size)}). Send it to whoever is fixing this — your API key is not in it.`,
      );
    });
  });

  qs("#btn-retry-feedback").addEventListener("click", () => {
    const entry = state.currentHash ? analysisFor(state.currentHash) : null;
    if (!entry) return;
    const text = qs("#answer-feedback").value.trim();
    const complaints = entry.complaints || [];
    if (!text && !complaints.length) {
      showError("Say what was wrong with the answer first, then press this.");
      return;
    }
    if (text && !complaints.includes(text)) complaints.push(text);
    entry.complaints = complaints;
    void analyze({ reuseReading: true, feedback: complaints });
  });

  qs("#btn-feedback-standing").addEventListener("click", () => {
    void guard(async () => {
      const entry = state.currentHash ? analysisFor(state.currentHash) : null;
      const text =
        qs("#answer-feedback").value.trim() ||
        ((entry && entry.complaints) || []).slice(-1)[0] ||
        "";
      if (!text) {
        showError("Write the complaint first, then press this to apply it to every level.");
        return;
      }
      const existing = state.settings.standingNotes || "";
      if (existing.includes(text)) {
        showNote("That is already a standing instruction.");
        return;
      }
      state.settings.standingNotes = existing ? `${existing}\n${text}` : text;
      await setSetting("standingNotes", state.settings.standingNotes);
      renderSettings();
      showNote("Added to your standing instructions — every level from now on will be told this.");
    });
  });

  qs("#standing-notes").addEventListener("change", (event) => {
    state.settings.standingNotes = event.target.value.trim();
    void setSetting("standingNotes", state.settings.standingNotes);
  });

  // The same instruction retyped every level belongs in the prompt, not in
  // his fingers. One press moves it there.
  qs("#btn-promote-note").addEventListener("click", () => {
    void guard(async () => {
      const shot = await syncShotFromForm();
      const note = shot && typeof shot.note === "string" ? shot.note.trim() : "";
      if (!note) {
        showError("Write the note first, then press this to apply it to every level.");
        return;
      }
      const existing = state.settings.standingNotes || "";
      if (existing.includes(note)) {
        showNote("That is already a standing instruction.");
        return;
      }
      state.settings.standingNotes = existing ? `${existing}\n${note}` : note;
      await setSetting("standingNotes", state.settings.standingNotes);
      shot.note = "";
      await putShot(shot);
      await reloadShots();
      render();
      showNote("Added to your standing instructions — it now goes out with every level, so it has been cleared from this one.");
    });
  });

  qs("#setup-save").addEventListener("click", () => void saveSetupKey());
  qs("#setup-key").addEventListener("keydown", (event) => {
    if (event.key === "Enter") void saveSetupKey();
  });
  qs("#setup-anyway").addEventListener("click", () => {
    void finishSetup(qs("#setup-key").value.trim());
  });
  qs("#setup-reveal").addEventListener("click", () => {
    const field = qs("#setup-key");
    const reveal = field.type === "password";
    field.type = reveal ? "text" : "password";
    qs("#setup-reveal").textContent = reveal ? "Hide" : "Show";
  });
  qs("#model-name").addEventListener("change", (event) => {
    state.settings.model = event.target.value.trim() || DEFAULT_MODEL;
    void setSetting("model", state.settings.model);
    renderSettings();
  });
  qs("#kb-max").addEventListener("change", (event) => {
    const n = Number(event.target.value);
    state.settings.kbMax = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_KB_MAX;
    void setSetting("kbMax", state.settings.kbMax);
    renderSettings();
  });
  qs("#btn-check-model").addEventListener("click", () => void checkModel());
  qs("#btn-persist").addEventListener("click", () => void makePersistent());
  qs("#btn-export").addEventListener("click", () => void doExport());
  qs("#import-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    void doImport(file);
  });
};

const registerSw = () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
};

const boot = async () => {
  wire();
  registerSw();
  try {
    await openDb();
  } catch (err) {
    // Both panes start hidden, so surface *something* rather than a blank page.
    showError(err);
    applyKeyGate();
    return;
  }
  await guard(async () => {
    await loadSettings();
    await reloadShots();
    await reloadKb();
    await reloadAnalyses();
    openTab("level");
    render();
    applyKeyGate();
  });
};

void boot();
