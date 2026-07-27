// IndexedDB layer for the Deep Space companion. Browser only.
//
// Five stores, one invariant each:
//   shots     original lossless PNG + thumbnail + the user's annotations
//   readings  cached map-call output, keyed by hash|model|promptVersion so
//             re-reducing the whole run costs zero vision calls
//   oplog     APPEND-ONLY. The knowledge base is a fold over this, never a
//             stored document, so nothing here is ever mutated in place.
//   analyses  the last answer for a shot plus its still-undecided proposed
//             ops. Derived, not truth — but a reload used to throw away every
//             pending op the user had not yet accepted, with no way back.
//   settings  api key, model name, ui prefs

import { blobToBase64 } from "./image.js";
import { remapOpIds } from "./kb.js";

export const DB_NAME = "deep-space";
export const DB_VERSION = 2;
export const BUNDLE_FORMAT = "deep-space-bundle";
export const BUNDLE_VERSION = 1;

// Never leaves the machine, and never lands in an export bundle.
const SECRET_SETTING_NAMES = new Set(["apiKey"]);
const SECRET_SETTING_PATTERN = /(key|token|secret|password)/i;

const isSecretSetting = (name) =>
  SECRET_SETTING_NAMES.has(name) || SECRET_SETTING_PATTERN.test(String(name));

// --- promise plumbing -----------------------------------------------------

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error || new Error("IndexedDB request failed"));
  });

const txDone = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted"));
  });

const upgrade = (db) => {
  if (!db.objectStoreNames.contains("shots")) {
    db.createObjectStore("shots", { keyPath: "hash" });
  }
  if (!db.objectStoreNames.contains("readings")) {
    const store = db.createObjectStore("readings", { keyPath: "key" });
    store.createIndex("hash", "hash", { unique: false });
  }
  if (!db.objectStoreNames.contains("oplog")) {
    const store = db.createObjectStore("oplog", {
      keyPath: "seq",
      autoIncrement: true,
    });
    store.createIndex("level", "level", { unique: false });
    store.createIndex("shotHash", "shotHash", { unique: false });
  }
  if (!db.objectStoreNames.contains("analyses")) {
    db.createObjectStore("analyses", { keyPath: "hash" });
  }
  if (!db.objectStoreNames.contains("settings")) {
    db.createObjectStore("settings", { keyPath: "name" });
  }
};

let dbPromise = null;
let connection = null;

// Only clear the cache if the connection being retired is the one it holds —
// a newer open must not be thrown away by an older connection's teardown.
const forget = (db) => {
  if (connection === db) {
    connection = null;
    dbPromise = null;
  }
};

// An open connection BLOCKS another tab's upgrade. Without this, a tab still
// holding the DB at version 1 makes every newly-loaded tab reject with
// "blocked" forever — the 1 -> 2 migration could only happen if the user
// happened to close the old tab. Closing on request costs this tab its
// connection (in-flight writes abort and surface as errors) and hands the
// upgrade over; the next call to openDb reopens at the new version.
const track = (db) => {
  connection = db;
  db.onversionchange = () => {
    db.close();
    forget(db);
  };
  // Forced close: eviction, or the profile going away underneath us. The
  // cached promise is dead either way and must not be handed out again.
  db.onclose = () => forget(db);
  return db;
};

export const openDb = () => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      let settled = false;
      open.onupgradeneeded = () => upgrade(open.result);
      open.onsuccess = () => {
        // `blocked` may already have rejected. The connection still arrives
        // once the blocker goes away, and nobody is holding it — close it, or
        // it sits there blocking the NEXT upgrade with no way to reach it.
        if (settled) {
          open.result.close();
          return;
        }
        settled = true;
        resolve(track(open.result));
      };
      open.onerror = () => {
        if (settled) return;
        settled = true;
        reject(
          open.error ||
            new Error("could not open local storage (IndexedDB blocked?)"),
        );
      };
      open.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new Error("local storage is blocked by another open tab"));
      };
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
};

// Run `fn` against one or more stores in a single transaction.
const runTx = async (names, mode, fn) => {
  const list = Array.isArray(names) ? names : [names];
  const db = await openDb();
  const tx = db.transaction(list, mode);
  const stores = list.map((name) => tx.objectStore(name));
  const out = await fn(...stores);
  await txDone(tx);
  return out;
};

// --- shots ----------------------------------------------------------------

export const putShot = async (shot) => {
  if (!shot || !shot.hash) throw new Error("putShot needs a shot with a hash");
  const record = { createdAt: Date.now(), markers: [], note: "", ...shot };
  await runTx("shots", "readwrite", (shots) => request(shots.put(record)));
  return record;
};

export const getShot = (hash) =>
  runTx("shots", "readonly", (shots) => request(shots.get(hash)));

// Level order first (unnumbered last), then capture time — the sidebar order.
export const allShots = async () => {
  const rows = await runTx("shots", "readonly", (shots) =>
    request(shots.getAll()),
  );
  const rank = (s) =>
    Number.isFinite(Number(s.level)) ? Number(s.level) : Infinity;
  return rows.sort(
    (a, b) => rank(a) - rank(b) || (a.createdAt || 0) - (b.createdAt || 0),
  );
};

// Drops the shot, its cached readings and its stored analysis. Ops that cite
// it stay — the log is append-only and its provenance hashes are history, not
// foreign keys.
export const deleteShot = (hash) =>
  runTx(
    ["shots", "readings", "analyses"],
    "readwrite",
    async (shots, readings, analyses) => {
      await request(shots.delete(hash));
      await request(analyses.delete(hash));
      const keys = await request(readings.index("hash").getAllKeys(hash));
      for (const key of keys) await request(readings.delete(key));
      return keys.length;
    },
  );

// --- readings -------------------------------------------------------------

export const readingKey = (hash, model, promptVersion) =>
  `${hash}|${model}|${promptVersion}`;

export const putReading = async (r) => {
  if (!r || !r.hash) throw new Error("putReading needs a reading with a hash");
  const record = {
    createdAt: Date.now(),
    ...r,
    key: r.key || readingKey(r.hash, r.model, r.promptVersion),
  };
  await runTx("readings", "readwrite", (readings) =>
    request(readings.put(record)),
  );
  return record;
};

export const getReading = (hash, model, promptVersion) =>
  runTx("readings", "readonly", (readings) =>
    request(readings.get(readingKey(hash, model, promptVersion))),
  );

// --- analyses -------------------------------------------------------------

// entry: { reading, answer, pending, withoutKb, codeRun, readingCached }.
// Everything in it is plain JSON, so it survives structured clone untouched.
export const putAnalysis = async (hash, entry) => {
  if (!hash) throw new Error("putAnalysis needs a shot hash");
  const record = { hash, entry, savedAt: Date.now() };
  await runTx("analyses", "readwrite", (store) => request(store.put(record)));
  return record;
};

export const getAnalysis = (hash) =>
  runTx("analyses", "readonly", (store) => request(store.get(hash)));

export const allAnalyses = () =>
  runTx("analyses", "readonly", (store) => request(store.getAll()));

export const deleteAnalysis = (hash) =>
  runTx("analyses", "readwrite", (store) => request(store.delete(hash)));

// --- op log ---------------------------------------------------------------

// entries: [{ level, shotHash, op, source }]. Returns them with seq assigned.
export const appendOps = async (entries) => {
  const list = (entries || []).map((e) => ({
    acceptedAt: Date.now(),
    source: "model",
    ...e,
  }));
  if (list.length === 0) return [];
  return runTx("oplog", "readwrite", async (oplog) => {
    const out = [];
    for (const entry of list) {
      const seq = await request(oplog.add(entry));
      out.push({ ...entry, seq });
    }
    return out;
  });
};

// Primary-key order === insertion order === fold order.
export const allOps = () =>
  runTx("oplog", "readonly", (oplog) => request(oplog.getAll()));

// Undo tail of the log (e.g. after a bad accept). Returns the count removed.
export const deleteOpsFrom = (seq) =>
  runTx("oplog", "readwrite", async (oplog) => {
    const range = IDBKeyRange.lowerBound(seq);
    const keys = await request(oplog.getAllKeys(range));
    for (const key of keys) await request(oplog.delete(key));
    return keys.length;
  });

// --- settings -------------------------------------------------------------

export const getSetting = async (name, fallback) => {
  const row = await runTx("settings", "readonly", (settings) =>
    request(settings.get(name)),
  );
  return row === undefined ? fallback : row.value;
};

export const setSetting = async (name, value) => {
  await runTx("settings", "readwrite", (settings) =>
    request(settings.put({ name, value })),
  );
  return value;
};

const allSettings = () =>
  runTx("settings", "readonly", (settings) => request(settings.getAll()));

// --- storage --------------------------------------------------------------

export const storageEstimate = async () => {
  const store = navigator.storage;
  if (!store || typeof store.estimate !== "function") {
    return { usage: null, quota: null, persisted: false };
  }
  const { usage = null, quota = null } = await store.estimate();
  const persisted =
    typeof store.persisted === "function" ? await store.persisted() : false;
  return { usage, quota, persisted };
};

export const requestPersist = async () => {
  const store = navigator.storage;
  if (!store || typeof store.persist !== "function") return false;
  return store.persist();
};

// --- export / import ------------------------------------------------------

const base64ToBlob = (b64, type) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};

// Browser storage is not a backup. Images go out as base64 PNG (lossless),
// alongside the full op log, the reading cache, and settings MINUS the key.
export const exportBundle = async () => {
  const [shots, readings, oplog, settings] = await Promise.all([
    allShots(),
    runTx("readings", "readonly", (store) => request(store.getAll())),
    allOps(),
    allSettings(),
  ]);
  const bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    shots: await Promise.all(
      shots.map(async (s) => ({
        hash: s.hash,
        width: s.width,
        height: s.height,
        level: s.level,
        note: s.note,
        markers: s.markers,
        solved: s.solved === true,
        createdAt: s.createdAt,
        png: s.blob ? await blobToBase64(s.blob) : null,
        thumb: s.thumb ? await blobToBase64(s.thumb) : null,
      })),
    ),
    readings,
    oplog,
    settings: settings.filter((s) => !isSecretSetting(s.name)),
  };
  return new Blob([JSON.stringify(bundle)], { type: "application/json" });
};

// The store generates `seq` from its keyPath; a value carrying one would be
// treated as an explicit key and collide with the local log.
const withoutSeq = (entry) => {
  const copy = { ...entry };
  delete copy.seq;
  return copy;
};

const opSignature = (entry) =>
  JSON.stringify([
    entry.level ?? null,
    entry.shotHash ?? null,
    entry.source ?? null,
    entry.acceptedAt ?? null,
    entry.op ?? null,
  ]);

// Merge, never clobber: an existing shot hash, reading key, or identical op
// wins over the bundle's copy. Settings only fill in names not already set.
export const importBundle = async (file) => {
  let bundle;
  try {
    bundle = JSON.parse(await file.text());
  } catch {
    throw new Error("that file is not a Deep Space bundle (unreadable JSON)");
  }
  if (!bundle || bundle.format !== BUNDLE_FORMAT) {
    throw new Error("that file is not a Deep Space bundle");
  }

  let shotCount = 0;
  for (const s of bundle.shots || []) {
    if (!s.hash || (await getShot(s.hash))) continue;
    await putShot({
      hash: s.hash,
      blob: s.png ? base64ToBlob(s.png, "image/png") : null,
      thumb: s.thumb ? base64ToBlob(s.thumb, "image/png") : null,
      width: s.width,
      height: s.height,
      level: s.level,
      note: s.note || "",
      markers: s.markers || [],
      solved: s.solved === true,
      createdAt: s.createdAt || Date.now(),
    });
    shotCount += 1;
  }

  let readingCount = 0;
  for (const r of bundle.readings || []) {
    if (!r.key) continue;
    const existing = await runTx("readings", "readonly", (store) =>
      request(store.get(r.key)),
    );
    if (existing) continue;
    await putReading(r);
    readingCount += 1;
  }

  // Ids in this log are positional, so a foreign log cannot simply be
  // concatenated — see remapOpIds in kb.js. Every import gets its own
  // namespace tag, which is why the counter is persisted: importing two
  // different bundles under the same tag would let the second one aim its
  // revise/retract ops at the first one's beliefs.
  const importSeq = Number(await getSetting("importSeq", 0)) + 1;
  await setSetting("importSeq", importSeq);
  const bundleOps = bundle.oplog || [];
  // Remap over the WHOLE bundle log, before any de-duplication: the mapping is
  // built from op positions, so filtering first would re-aim what is left.
  const remapped = remapOpIds(
    bundleOps.map((e) => e.op),
    `imp${importSeq}`,
  );

  // De-duplication compares the op as the OTHER machine wrote it: what we
  // store is rewritten, so a second import of the same bundle would otherwise
  // look brand new. `originSig` is that original identity, kept on the entry.
  const existingOps = new Set();
  for (const e of await allOps()) {
    existingOps.add(opSignature(e));
    if (e.originSig) existingOps.add(e.originSig);
  }
  const fresh = bundleOps
    .map((entry, i) => ({ entry, op: remapped[i], sig: opSignature(entry) }))
    .filter((x) => !existingOps.has(x.sig));
  // Drop the bundle's seq values; this log assigns its own.
  const added = await appendOps(
    fresh.map((x) => ({ ...withoutSeq(x.entry), op: x.op, originSig: x.sig })),
  );

  let settingCount = 0;
  for (const s of bundle.settings || []) {
    if (isSecretSetting(s.name)) continue;
    if ((await getSetting(s.name, undefined)) !== undefined) continue;
    await setSetting(s.name, s.value);
    settingCount += 1;
  }

  return {
    shots: shotCount,
    ops: added.length,
    readings: readingCount,
    settings: settingCount,
  };
};
