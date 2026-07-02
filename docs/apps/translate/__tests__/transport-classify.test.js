// Tests for transport-classify.js — the pure "which failure is this?"
// decision used by WorkerTransport. Captures the precedence rules
// established when the differentiated error messaging shipped on
// 2026-05-21 so that future edits can't silently degrade them.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure,
  TERMINAL_CATEGORIES,
  ERROR_CATEGORIES,
} from "../transport-classify.js";

test("server-error frame for room-full beats every other signal", () => {
  // The worker stated its intent. Even if the close code or onLine
  // state contradicts, the server-sent reason wins.
  const c = classifyFailure({
    everOpened: true,           // would otherwise → "dropped"
    closeCode: 1006,            // would otherwise → "dropped"
    serverErrorCode: "room-full",
    online: false,              // would otherwise → "offline"
  });
  assert.equal(c, "room-full");
});

test("server-error frame for server-error beats every other signal", () => {
  const c = classifyFailure({
    everOpened: false,
    closeCode: 1006,
    serverErrorCode: "server-error",
    online: true,
  });
  assert.equal(c, "server-error");
});

test("close code 4001 → room-full (when server frame absent)", () => {
  const c = classifyFailure({
    everOpened: false,
    closeCode: 4001,
    serverErrorCode: null,
    online: true,
  });
  assert.equal(c, "room-full");
});

test("close code 4002 → server-error", () => {
  const c = classifyFailure({
    everOpened: false,
    closeCode: 4002,
    serverErrorCode: null,
    online: true,
  });
  assert.equal(c, "server-error");
});

test("offline beats unreachable when navigator.onLine is false", () => {
  // If the browser knows we're offline, surface that — "couldn't reach
  // server" is misleading when the user just lost wifi.
  const c = classifyFailure({
    everOpened: false,
    closeCode: 1006,
    serverErrorCode: null,
    online: false,
  });
  assert.equal(c, "offline");
});

test("never opened + online → signaling-unreachable", () => {
  // Network is up, but the upgrade never completed. DNS, firewall,
  // worker down — user-facing message guides toward those.
  const c = classifyFailure({
    everOpened: false,
    closeCode: 1006,
    serverErrorCode: null,
    online: true,
  });
  assert.equal(c, "signaling-unreachable");
});

test("opened then closed → dropped", () => {
  // Mid-session disconnect. setPresence renders sigDown for this case;
  // the transport's onError handler intentionally skips a duplicate.
  const c = classifyFailure({
    everOpened: true,
    closeCode: 1006,
    serverErrorCode: null,
    online: true,
  });
  assert.equal(c, "dropped");
});

test("opened then 4001 → room-full (server-side kick after open)", () => {
  // Hypothetical: server kicks us after we connected (e.g., concurrent
  // 3rd connection wins, we lose). The close code still wins over the
  // dropped-mid-session inference.
  const c = classifyFailure({
    everOpened: true,
    closeCode: 4001,
    serverErrorCode: null,
    online: true,
  });
  assert.equal(c, "room-full");
});

test("TERMINAL_CATEGORIES contains exactly room-full and server-error", () => {
  // The reconnect loop reads this set to decide whether to back off
  // forever (don't hammer a doomed endpoint) or retry with backoff.
  // Adding a category here without intent would silently disable
  // reconnects for transient errors.
  assert.deepEqual([...TERMINAL_CATEGORIES].sort(), ["room-full", "server-error"]);
});

test("ERROR_CATEGORIES enumerates every classifier output", () => {
  // Anchors the contract: if a new category is added to classify,
  // ERROR_CATEGORIES must also be updated so the i18n key map and
  // any consumer that iterates can be kept in sync.
  const expected = [
    "room-full",
    "server-error",
    "offline",
    "signaling-unreachable",
    "dropped",
  ];
  assert.deepEqual([...ERROR_CATEGORIES].sort(), expected.sort());
});
