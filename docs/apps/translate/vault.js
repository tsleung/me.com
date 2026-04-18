// vault.js — opt-in encrypted message history stored in IndexedDB.
//
// Crypto:
//   AES-GCM 256, key derived from a user passphrase via
//   PBKDF2-SHA256 (200k iterations, 16-byte salt).
//   Key is held in JS memory only during a session; passphrase is never
//   stored. Wrong passphrase => GCM auth failure, surfaced cleanly.
//
// Schema:
//   DB: translate-vault
//     store meta     (keyPath singleton) — {singleton: "singleton", salt: Uint8Array(16)}
//     store messages (autoincrement id)  — {id, ts, direction, iv, ciphertext}

const DB_NAME = "translate-vault";
const DB_VERSION = 2;
const PBKDF2_ITERS = 200_000;

let _key = null;
let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "singleton" });
      }
      let messagesStore;
      if (!db.objectStoreNames.contains("messages")) {
        messagesStore = db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
      } else {
        messagesStore = req.transaction.objectStore("messages");
      }
      if (!messagesStore.indexNames.contains("byRoom")) {
        messagesStore.createIndex("byRoom", "room", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

function awaitReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSalt(db) {
  const rec = await awaitReq(tx(db, ["meta"], "readonly").objectStore("meta").get("singleton"));
  return rec ? rec.salt : null;
}

async function setSalt(db, salt) {
  await awaitReq(
    tx(db, ["meta"], "readwrite").objectStore("meta").put({ singleton: "singleton", salt, created_at: Date.now() })
  );
}

async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Unlock the vault with a passphrase. If salt is missing, create one.
// Returns true if unlock succeeded (or we just initialized).
// If there are existing messages and the passphrase is wrong, returns false.
export async function unlock(passphrase) {
  if (!passphrase) throw new Error("passphrase required");
  const db = await openDb();
  let salt = await getSalt(db);
  const freshInit = !salt;
  if (freshInit) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    await setSalt(db, salt);
  }
  const key = await deriveKey(passphrase, salt);

  if (!freshInit) {
    // Verify by trying to decrypt the most recent message, if any.
    const store = tx(db, ["messages"], "readonly").objectStore("messages");
    const curReq = store.openCursor(null, "prev");
    const latest = await new Promise((resolve, reject) => {
      curReq.onsuccess = () => resolve(curReq.result ? curReq.result.value : null);
      curReq.onerror = () => reject(curReq.error);
    });
    if (latest) {
      try {
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: latest.iv }, key, latest.ciphertext);
      } catch {
        return false;
      }
    }
  }

  _key = key;
  return true;
}

export function isUnlocked() { return !!_key; }

export function lock() { _key = null; }

export async function append(msg, direction, room) {
  if (!_key) throw new Error("vault locked");
  if (!room) throw new Error("room required");
  const db = await openDb();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(msg));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, _key, plaintext)
  );
  await awaitReq(
    tx(db, ["messages"], "readwrite")
      .objectStore("messages")
      .add({ ts: msg.ts ?? Date.now(), direction, room, iv, ciphertext })
  );
}

// Read the most recent `limit` messages for a specific room, oldest first.
export async function readRecent(room, limit = 200) {
  if (!_key) throw new Error("vault locked");
  if (!room) throw new Error("room required");
  const db = await openDb();
  const index = tx(db, ["messages"], "readonly").objectStore("messages").index("byRoom");
  const out = [];
  await new Promise((resolve, reject) => {
    const cur = index.openCursor(IDBKeyRange.only(room), "prev");
    cur.onsuccess = async () => {
      const c = cur.result;
      if (!c || out.length >= limit) return resolve();
      try {
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: c.value.iv }, _key, c.value.ciphertext);
        const msg = JSON.parse(new TextDecoder().decode(pt));
        out.push({ direction: c.value.direction, msg });
      } catch {
        // skip undecryptable record
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  return out.reverse();
}

// List all room codes that have stored messages in the vault.
export async function listRooms() {
  const db = await openDb();
  const index = tx(db, ["messages"], "readonly").objectStore("messages").index("byRoom");
  const seen = new Set();
  await new Promise((resolve, reject) => {
    const cur = index.openKeyCursor(null, "nextunique");
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      seen.add(c.key);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  return Array.from(seen);
}

export async function clearAll() {
  lock();
  _dbPromise = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
