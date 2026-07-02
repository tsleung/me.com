// Regression test for the stale-socket → room-full failure flow that
// motivated the 2026-05-21 work. Documents the contract that prevents
// the original bad UX ("WebSocket connection failed: " with no signal)
// from sneaking back.
//
// The scenario, in production terms:
//
//   1. User opens translate. WorkerTransport opens a WS to the signaling
//      worker.
//   2. The DO for that room still holds 2 socket references from a
//      previous session whose close events never fired.
//   3. Worker completes the WS upgrade (so the close code can be heard),
//      sends a JSON `{type:"error", code:"room-full"}` frame, and
//      closes with code 4001.
//   4. The browser fires the message handler, then the close handler.
//      WorkerTransport's _onWsDown calls classifyFailure with the
//      captured state.
//   5. The resulting category must be "room-full"; it must be in the
//      terminal set (so we don't hammer-reconnect a doomed endpoint);
//      and the i18n key the app maps it to must exist.
//
// If any link in this chain breaks (server sends a different code, the
// classifier reorders precedence, the terminal set forgets an entry),
// the user is back to the original generic-browser-error UX.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  classifyFailure,
  TERMINAL_CATEGORIES,
} from "../transport-classify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const i18nSrc = readFileSync(resolve(__dirname, "../i18n.js"), "utf8");
const workerSrc = readFileSync(
  resolve(__dirname, "../../../../signaling/src/index.ts"),
  "utf8",
);

// --- The scenario itself --------------------------------------------------

test("stale-socket scenario: server rejects with code 4001 → classifier says room-full", () => {
  // State WorkerTransport accumulates between the `open`, `message`, and
  // `close` events fired by the browser in the stale-socket flow:
  const state = {
    everOpened: true,          // 101 upgrade succeeded
    serverErrorCode: "room-full",  // JSON frame from worker
    closeCode: 4001,           // server.close(4001, "room-full")
    online: true,              // user has wifi; the failure isn't network
  };
  assert.equal(classifyFailure(state), "room-full");
});

test("stale-socket scenario: room-full is terminal — no reconnect loop", () => {
  // The transport's reconnect path reads TERMINAL_CATEGORIES to decide
  // whether to back off forever or retry. If "room-full" ever falls out
  // of this set, the user gets infinite reconnect attempts against a
  // doomed endpoint — exactly the pre-fix behavior.
  assert.ok(TERMINAL_CATEGORIES.has("room-full"));
});

test("stale-socket scenario: classifier survives a no-server-frame fallback", () => {
  // Defensive: if the worker is updated and stops sending the JSON error
  // frame but still closes with 4001, the close-code branch must still
  // produce "room-full" so the user gets the right message.
  assert.equal(
    classifyFailure({
      everOpened: true,
      serverErrorCode: null,
      closeCode: 4001,
      online: true,
    }),
    "room-full",
  );
});

// --- Cross-file contract checks -------------------------------------------

test("worker close code 4001 is still the room-full code", () => {
  // Snapshot-style check: if anyone changes the worker's room-full code
  // without updating the client's classifier and this test, we want a
  // loud failure.
  assert.match(workerSrc, /CLOSE_ROOM_FULL\s*=\s*4001/);
  assert.match(workerSrc, /rejectWithCode\(CLOSE_ROOM_FULL,\s*"room-full"\)/);
});

test("worker server-error close code is still 4002", () => {
  assert.match(workerSrc, /CLOSE_SERVER_ERROR\s*=\s*4002/);
});

test("worker still completes the upgrade before closing (no HTTP 4xx rejection)", () => {
  // The whole reason for the 101-then-close pattern is that the browser
  // only exposes the close code when the upgrade completed. If anyone
  // reverts to `new Response("room full", { status: 409 })` the user
  // is back to opaque 1006 errors.
  assert.match(workerSrc, /status:\s*101,\s*webSocket:\s*client/);
  assert.doesNotMatch(
    workerSrc,
    /new Response\("room full",\s*\{\s*status:\s*409/,
    "worker must not bypass WS upgrade for room-full",
  );
});

test("every error category resolves to an i18n key in en", () => {
  // The onError handler in app.js maps categories to system.error* keys.
  // If a category is added without its i18n string, the user sees the
  // raw key.
  const expectedKeys = [
    "system.errorRoomFull",
    "system.errorServerError",
    "system.errorOffline",
    "system.errorUnreachable",
  ];
  for (const k of expectedKeys) {
    assert.match(
      i18nSrc,
      new RegExp(`"${k.replace(".", "\\.")}"\\s*:`),
      `i18n.js must define ${k}`,
    );
  }
});
