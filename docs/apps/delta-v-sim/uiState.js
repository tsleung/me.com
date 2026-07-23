// uiState.js — the UI VIEW/INTERACTION-MODE state as ONE pure reducer over a few
// ORTHOGONAL axes, so every reachable UI state is named and every transition lands
// in a known state. Pure/DOM-free (selftest asserts it directly).
//
// It governs MODE only — the frame id, who owns the camera target, which workspace
// panel is open, and playback. It does NOT touch DOMAIN DATA (definitions, missions,
// the sandbox craft, elevator, porkchop/plan/chart DATA) nor the imperative `Camera`
// (scale/center/ease) — those stay where they are. See
// notes/2026_07_21_delta_v_sim_ui_state_model.md for the design.
//
// The bug this closes is a CLASS: reachable states nobody named. The headline case
// is "Sun stranded in a zoomed-out compare view" — a missing transition, now defined
// (ZOOM in a pinned frame past threshold cascades to heliocentric, where the Sun is a
// disc). We REUSE frames.frameForZoom / CASCADE_EFFSCALE for the cascade decision —
// the frame descriptor here only adds the render facts (center / sunAs / pinned) that
// used to live as scattered `isCompare` branches in render.js.

import { DAY_S } from "./sim.js";
import { frameForZoom, FRAMES } from "./frames.js";

// ---- frame descriptors: render + zoom facts AS DATA -------------------------
// sunAs: 'disc' (the Sun is a drawn body) | 'arrow' (off-screen; a bearing arrow).
// pinned: the pair is anchored/normalized (compare) → compare extras, no scale bar.
export const FRAME_DESC = {
  helio: { id: "helio", center: "sun", sunAs: "disc", pinned: false },
  geo: { id: "geo", center: "earth", sunAs: "disc", pinned: false },
  areo: { id: "areo", center: "mars", sunAs: "disc", pinned: false },
  "em-syn": { id: "em-syn", center: "earth", sunAs: "disc", pinned: false },
  "se-syn": { id: "se-syn", center: "sun", sunAs: "disc", pinned: false },
  "earth-mars": { id: "earth-mars", center: "earth", sunAs: "arrow", pinned: true },
};
export function frameDesc(frameId) {
  return FRAME_DESC[frameId] || FRAME_DESC.helio;
}

// The reachability enums the selftest sweeps against.
export const FRAME_IDS = Object.keys(FRAME_DESC);
export const CAMERA_KINDS = ["fit", "body", "follow", "manual"];
export const WORKSPACES = ["none", "define", "fleet", "sandbox"];

// ---- the initial known state ------------------------------------------------
export const INITIAL = {
  frame: "helio",
  // camera axis — ONE owner of the camera target:
  //   fit    → the frame's fit centre (frame-tracking)
  //   body   → a body key (focus)
  //   follow → a craft id (frame-agnostic; zoom stays user-controlled)
  //   manual → released to the user (pan/zoom own it)
  camera: { kind: "fit", target: null },
  // workspace axis — at most ONE primary panel open. (Elevator is a sub-tool inside
  // 'define'; the analysis overlays are DERIVED from workspace === 'define'.)
  workspace: "none",
  // playback axis — the MODE (playing/rate); the clock VALUE `t` is domain data.
  playback: { playing: true, rate: 20 * DAY_S }, // effective default comes from the rate slider (index.html value=680)
};

const cam = (kind, target = null) => ({ kind, target });

// ---- the reducer: reduce(ui, action) → ui (pure, total) ---------------------
// Every branch returns a fully-defined known state; unknown actions are identity.
export function reduce(ui, action) {
  switch (action && action.type) {
    // --- frame ---
    case "SELECT_FRAME": {
      // a deliberate frame pick reframes: fit-track it, releasing follow/focus.
      if (!FRAMES[action.frame]) return ui;
      return { ...ui, frame: action.frame, camera: cam("fit") };
    }

    // --- camera ---
    case "ZOOM": {
      // THE FIX: zoom is a DEFINED transition. In a pinned/rotating frame, past its
      // CASCADE_EFFSCALE threshold `frameForZoom` cascades UP to the heliocentric
      // container → the Sun becomes a disc; the "zoomed-out compare, no Sun" state is
      // unreachable. Following is frame-agnostic + zoom stays user-controlled, so a
      // craft-follow SURVIVES both a cascade and an ordinary zoom (only PAN drops it).
      const next = frameForZoom(ui.frame, action.effScale);
      if (next !== ui.frame) {
        return { ...ui, frame: next, camera: ui.camera.kind === "follow" ? ui.camera : cam("fit") };
      }
      return ui.camera.kind === "follow" ? ui : { ...ui, camera: cam("manual") };
    }
    case "PAN":
      // a manual pan releases the camera to the user (drops fit-track AND follow).
      return { ...ui, camera: cam("manual") };
    case "FIT":
      return { ...ui, camera: cam("fit") };
    case "FOCUS_BODY":
      return action.key ? { ...ui, camera: cam("body", action.key) } : ui;
    case "FOLLOW_CRAFT":
      return action.id ? { ...ui, camera: cam("follow", action.id) } : ui;
    case "UNFOLLOW":
      return ui.camera.kind === "follow" ? { ...ui, camera: cam("fit") } : ui;

    // --- workspace (≤1 open, so a single enum enforces it structurally) ---
    case "OPEN_WORKSPACE":
      return WORKSPACES.includes(action.workspace) ? { ...ui, workspace: action.workspace } : ui;
    case "CLOSE_WORKSPACE":
      return { ...ui, workspace: "none" };
    case "TOGGLE_WORKSPACE":
      if (!WORKSPACES.includes(action.workspace)) return ui;
      return { ...ui, workspace: ui.workspace === action.workspace ? "none" : action.workspace };

    // --- playback (MODE; the clock value t is domain data, mutated elsewhere) ---
    case "PLAY":
      return { ...ui, playback: { ...ui.playback, playing: true } };
    case "PAUSE":
      return { ...ui, playback: { ...ui.playback, playing: false } };
    case "SET_RATE":
      return action.rate > 0 ? { ...ui, playback: { ...ui.playback, rate: action.rate } } : ui;
    case "RESET_T":
      return ui; // the clock is domain data — no UI-mode change

    default:
      return ui;
  }
}

// ---- derived selectors (pure) — read by app.js + render.js ------------------
export function analysisVisible(ui) {
  return ui.workspace === "define"; // porkchop/plan/chart are derived from this
}
export function sunModeFor(ui) {
  return frameDesc(ui.frame).sunAs; // 'disc' | 'arrow'
}
export function isPinned(ui) {
  return frameDesc(ui.frame).pinned;
}
export function frameCenter(ui) {
  return frameDesc(ui.frame).center;
}
