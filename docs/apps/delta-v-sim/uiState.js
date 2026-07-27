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
// disc). We REUSE frames.frameForZoom / CASCADE_EFFSCALE for the cascade decision.

import { DAY_S } from "./sim.js";
import { frameForZoom, FRAMES, FRAME_ORDER } from "./frames.js";

// ---- frame descriptor: render facts, read from the ONE frame catalog --------
// The render facts (center / sunAs / pinned) live in frames.FRAMES now — there is
// no second table to drift from it (design R1, 2026-07-24). `frameDesc` reads them
// straight from FRAMES; an unknown id still falls back to helio, but a frame that
// EXISTS in FRAMES can never miss its facts, which is the silent-misrender bug the
// merge closed (asserted in selftest "ui-model: every frame has render facts").
export function frameDesc(frameId) {
  return FRAMES[frameId] || FRAMES.helio;
}

// The reachability enums the selftest sweeps against.
export const FRAME_IDS = FRAME_ORDER;
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

// A FRESH initial UI state, deep-cloned so no two sessions (or a reset) share a
// nested object with INITIAL. Boot calls this instead of hand-spreading each axis
// — so adding a new object-valued axis (e.g. a director) can't silently alias the
// INITIAL reference (design R5, 2026-07-24).
export function initialUi() {
  return {
    frame: INITIAL.frame,
    camera: { ...INITIAL.camera },
    workspace: INITIAL.workspace,
    playback: { ...INITIAL.playback },
  };
}

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
