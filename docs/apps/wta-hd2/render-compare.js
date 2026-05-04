// L3 — side-by-side comparison.
//
// Spawns N independent SimLanes (one per faction or per encounter type)
// and drives them from a single shared timer. Compare itself owns no
// rendering anymore — each lane is a `mountSimLane` instance with its
// own DOM, engine, diver, and analytics. Adding a fourth lane is one
// entry in the `variants` array.
//
// Two modes:
//   - "factions": one lane per faction (terminids/automatons/illuminate),
//     all on the same encounter type. Answers "should I push or run vs
//     each faction at this difficulty?"
//   - "encounters": one lane per encounter type (patrol/breach/drop) for
//     a single faction. Answers "how does playstyle shift across spawn
//     shapes?"

import { mountSimLane, injectSimLaneStyles } from "./render-sim-lane.js";

const ENCOUNTERS = ["patrol", "breach", "drop"];
const FACTIONS = ["terminids", "automatons", "illuminate"];
const TICK_MS = 100;

export function mountCompare({
  rootEl,
  engineFactory,
  getCfg,
  data,
  getActive,
  isPlaying,
  mode = "factions",
  controller = null,
}) {
  rootEl.classList.add("wta-compare-root");
  injectCompareStyles();
  injectSimLaneStyles();
  rootEl.innerHTML = "";

  const variants = mode === "encounters" ? ENCOUNTERS : FACTIONS;
  const dim = mode === "encounters" ? "encounter" : "faction";

  const lanes = variants.map((variant) => mountSimLane({
    parent: rootEl,
    cfg: makeCfg(getCfg(), dim, variant, data),
    data,
    engineFactory,
    label: variant,
    variant,
    dim,
    layout: "full",
    controller,
  }));

  let timer = null;
  let running = false;

  function loop() {
    if (!running) return;
    if (isPlaying && !isPlaying()) {
      stop();
      return;
    }
    for (const lane of lanes) lane.tick();
    timer = setTimeout(loop, TICK_MS);
  }

  function start() {
    if (running) return;
    if (isPlaying && !isPlaying()) return;
    running = true;
    loop();
  }

  function stop() {
    running = false;
    if (timer != null) { clearTimeout(timer); timer = null; }
  }

  // Reset every lane to a fresh engine on its current cfg (re-derived from
  // the current global cfg so any loadout edits made while compare was up
  // are picked up).
  function reset() {
    stop();
    for (let i = 0; i < lanes.length; i++) {
      lanes[i].reset(makeCfg(getCfg(), dim, variants[i], data));
    }
  }

  // Start/stop lifecycle keyed off the data-active attribute that app.js
  // toggles. Same wiring as before, just lives at the orchestrator layer.
  const observer = new MutationObserver(() => {
    if (getActive?.() && (!isPlaying || isPlaying())) start();
    else stop();
  });
  observer.observe(rootEl, { attributes: true, attributeFilter: ["data-active"] });
  if (getActive?.() && (!isPlaying || isPlaying())) start();

  function unmount() {
    stop();
    observer.disconnect();
    for (const lane of lanes) lane.unmount();
    rootEl.innerHTML = "";
  }

  return { start, stop, reset, unmount };
}

// Build the per-lane engine config: fork the global cfg, override scenario
// faction/encounter for this variant, and derive a distinct seed so each
// lane's RNG is independent. Subfaction defaults to the first valid one
// for the chosen faction (whatever the data bundle declares).
function makeCfg(base, dim, variant, data) {
  const next = { ...base };
  if (dim === "encounter") {
    next.scenario = { ...base.scenario, encounter: variant };
  } else {
    const subs = data.factions?.[variant]?.subfactions ?? [{ id: "standard" }];
    // Honor the per-faction subfaction map if the user picked one for this
    // lane; otherwise fall back to the faction's first declared subfaction.
    const fromMap = base.scenario?.subfactions?.[variant];
    const validIds = new Set(subs.map((s) => s.id));
    const sub = fromMap && validIds.has(fromMap) ? fromMap : subs[0].id;
    next.scenario = { ...base.scenario, faction: variant, subfaction: sub };
  }
  next.seed = (base.seed ?? 1) * 7919 + variant.length;
  return next;
}

function injectCompareStyles() {
  if (document.getElementById("wta-compare-styles")) return;
  const s = document.createElement("style");
  s.id = "wta-compare-styles";
  s.textContent = `
    .wta-compare-root { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 12px; }
    @media (max-width: 900px) { .wta-compare-root { grid-template-columns: 1fr; } }
  `;
  document.head.appendChild(s);
}
