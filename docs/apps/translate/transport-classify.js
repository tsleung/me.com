// transport-classify.js — pure failure classification for the
// signaling WebSocket. Extracted from WorkerTransport so the
// "which error is this?" decision can be unit-tested without a
// browser or a real WebSocket.
//
// Inputs come from the transport's own state at the moment the
// close/error event fires:
//   - everOpened:     did the WS reach the `open` event on this attempt?
//   - closeCode:      CloseEvent.code from the browser, or undefined
//                     when the firing event was `error`, not `close`.
//   - serverErrorCode: the most recent `{type:"error", code}` JSON
//                     frame the server sent before closing, or null.
//                     Strongest signal because it states intent.
//   - online:         navigator.onLine at the moment of failure.
//
// Output categories:
//   "room-full"             — the signaling worker rejected: room is full
//   "server-error"          — the worker rejected for some other reason
//   "offline"               — the browser reports no network
//   "signaling-unreachable" — network is up but the upgrade never
//                             completed (DNS, firewall, worker down)
//   "dropped"               — connection was up, then lost mid-session

export const ERROR_CATEGORIES = [
  "room-full",
  "server-error",
  "offline",
  "signaling-unreachable",
  "dropped",
];

export const TERMINAL_CATEGORIES = new Set(["room-full", "server-error"]);

export function classifyFailure({ everOpened, closeCode, serverErrorCode, online }) {
  // Server-sent reasons are the strongest signal — the worker
  // explicitly told us why it's rejecting. Prefer them over inferring
  // from close codes (which the browser may surface late or merge
  // with TCP-level info).
  if (serverErrorCode === "room-full")    return "room-full";
  if (serverErrorCode === "server-error") return "server-error";
  if (closeCode === 4001) return "room-full";
  if (closeCode === 4002) return "server-error";
  if (online === false) return "offline";
  // 1006 with no prior `open` means the upgrade never completed —
  // DNS failure, firewall, worker down, or local network outage
  // that didn't flip navigator.onLine. After `open`, it's a
  // mid-session drop.
  if (!everOpened) return "signaling-unreachable";
  return "dropped";
}
