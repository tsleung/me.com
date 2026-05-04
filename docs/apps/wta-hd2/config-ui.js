import { encodeHash, decodeHash } from "./url-hash.js";
import { defaultWaveCadenceSecs } from "./scenarios.js";

const STORAGE_KEY = "wta-hd2.cfg";
const SAVE_DEBOUNCE_MS = 200;

// "drop" is mechanically merged into "breach" (same spawn-event mechanic),
// but stays listed for backward-compat with stored cfg / URL hashes.
const ENCOUNTERS = ["patrol", "breach", "drop"];

// ---- Public helpers -------------------------------------------------------

// Build the per-faction subfaction map: { terminids: <first>, automatons:
// <first>, illuminate: <first> } using each faction's first declared
// subfaction. This is the source of truth — `cfg.scenario.subfaction` is a
// derived view that always equals `subfactions[faction]`.
function defaultSubfactionsMap(data) {
  const out = {};
  for (const fac of Object.keys(data.factions ?? {})) {
    out[fac] = data.factions[fac]?.subfactions?.[0]?.id ?? "standard";
  }
  return out;
}

export function defaultConfig(data) {
  // Prefer the canonical "Default Helldiver" preset for the first-time
  // experience — single sim against bugs with the starter kit. Falls back
  // to alphabetical-first picks if that preset is missing (test fixtures).
  const presets = data.presets ?? [];
  const helldiver = presets.find((p) => p.id === "default-helldiver");
  const subsMap = defaultSubfactionsMap(data);
  if (helldiver) {
    // Honor the preset's subfaction for its faction — but every other
    // faction still gets its own first-subfaction default so the "all" view
    // works without further setup.
    if (helldiver.scenario?.faction && helldiver.scenario?.subfaction) {
      subsMap[helldiver.scenario.faction] = helldiver.scenario.subfaction;
    }
    return {
      scenario: { spawnRateMultiplier: 1.0, infiniteWaves: true, waveCadenceSecs: 43, playerMovement: false, ...helldiver.scenario, subfactions: subsMap },
      loadout: {
        stratagems: [...helldiver.loadout.stratagems],
        primary: helldiver.loadout.primary,
        secondary: helldiver.loadout.secondary,
        grenade: helldiver.loadout.grenade,
        armor: helldiver.loadout.armor,
        booster: helldiver.loadout.booster,
      },
      solver: { alpha: 0.4, gamma: 0.3, skill: 1.0, reserves: {} },
      seed: 1,
    };
  }

  const firstFaction = Object.keys(data.factions)[0];
  const firstSub = subsMap[firstFaction] ?? "standard";
  const strats = listStratagems(data);
  const prims = data.weapons?.primaries ?? [];
  const secs = data.weapons?.secondaries ?? [];
  const grens = data.weapons?.grenades ?? [];
  const armor = listArmor(data);
  const boosters = listBoosters(data);
  return {
    scenario: {
      faction: firstFaction,
      subfaction: firstSub,
      subfactions: subsMap,
      encounter: "patrol",
      difficulty: 7,
    },
    loadout: {
      stratagems: [
        strats[0]?.id ?? null,
        strats[1]?.id ?? null,
        strats[2]?.id ?? null,
        strats[3]?.id ?? null,
      ],
      primary: prims[0]?.id ?? null,
      secondary: secs[0]?.id ?? null,
      grenade: grens[0]?.id ?? null,
      armor: armor[0]?.id ?? null,
      booster: boosters[0]?.id ?? null,
    },
    solver: { alpha: 0.5, reserves: {} },
    seed: 1,
  };
}

export function loadConfig(data) {
  const def = defaultConfig(data);
  // 1. localStorage
  let cfg = def;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) cfg = mergeConfig(def, JSON.parse(raw), data);
  } catch {}
  // 2. URL hash overrides localStorage
  try {
    const hashCfg = decodeHash(window.location.hash, data);
    if (hashCfg) cfg = mergeConfig(cfg, hashCfg, data);
  } catch {}
  return cfg;
}

let saveTimer = null;
export function saveConfig(cfg) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch {}
  }, SAVE_DEBOUNCE_MS);
}

// ---- Mount per L3 contract -----------------------------------------------

export function mountConfigUI(rootEl, controller, data) {
  let cfg = controller.getCfg();
  const cleanup = [];

  bindFactionSegment(rootEl, cfg, data, (newCfg) => commit(newCfg, "SET_SCENARIO"));
  // Subfaction picker is now a popover attached to each faction tab — see
  // `mountFactionSubfactionChips` inside bindFactionSegment.
  bindEncounterSegment(rootEl, cfg, (newCfg) => commit(newCfg, "SET_SCENARIO"));
  bindDifficulty(rootEl, cfg, (newCfg) => commit(newCfg, "SET_SCENARIO"));
  bindSpawnRate(rootEl, cfg, (newCfg) => commit(newCfg, "SET_SCENARIO"));
  bindInfiniteWaves(rootEl, cfg, (newCfg) => commit(newCfg, "SET_SCENARIO"));
  bindPlayerMovement(rootEl, cfg, (newCfg) => commit(newCfg, "SET_SCENARIO"));
  bindWaveCadence(rootEl, cfg, (newCfg) => commit(newCfg, "SET_SCENARIO"));
  bindSpawnNow(rootEl, controller);
  const unsub = controller.subscribe((snap) => {
    paintWaveTimer(rootEl, cfg, snap);
    paintWaveSpawnLog(rootEl, snap);
  });
  cleanup.push(unsub);
  bindLoadout(rootEl, cfg, data, (newCfg) => commit(newCfg, "SET_LOADOUT"));
  bindAlpha(rootEl, cfg, (newCfg) => commit(newCfg, "SET_ALPHA"));
  bindGamma(rootEl, cfg, (newCfg) => commit(newCfg, "SET_GAMMA"));
  bindSkill(rootEl, cfg, (newCfg) => commit(newCfg, "SET_SKILL"));
  bindAmmoConservation(rootEl, cfg, (newCfg) => commit(newCfg, "SET_AMMO_CONSERVATION"));
  bindRunControls(rootEl, controller);
  bindShareButton(rootEl, () => cfg);
  bindPresets(rootEl, data, (preset) => applyPreset(preset));

  function applyPreset(preset) {
    const next = structuredClone(cfg);
    if (preset.scenario) next.scenario = { ...next.scenario, ...preset.scenario };
    if (preset.loadout) next.loadout = { ...next.loadout, ...preset.loadout };
    cfg = next;
    saveConfig(cfg);
    syncUrlHash(cfg);
    applyAll(rootEl, cfg, data);
    controller.dispatch({ type: "SET_SCENARIO", scenario: cfg.scenario });
    controller.dispatch({ type: "SET_LOADOUT", loadout: cfg.loadout });
  }

  applyAll(rootEl, cfg, data);

  function commit(newCfg, kind) {
    cfg = newCfg;
    saveConfig(cfg);
    syncUrlHash(cfg);
    if (kind === "SET_SCENARIO") {
      paintWaveCadenceState(rootEl, cfg);
      paintWaveTimer(rootEl, cfg, controller.getSnapshot?.());
      controller.dispatch({ type: "SET_SCENARIO", scenario: cfg.scenario });
    }
    else if (kind === "SET_LOADOUT") controller.dispatch({ type: "SET_LOADOUT", loadout: cfg.loadout });
    else if (kind === "SET_ALPHA") controller.dispatch({ type: "SET_ALPHA", alpha: cfg.solver.alpha });
    else if (kind === "SET_GAMMA") controller.dispatch({ type: "SET_GAMMA", gamma: cfg.solver.gamma });
    else if (kind === "SET_SKILL") controller.dispatch({ type: "SET_SKILL", skill: cfg.solver.skill });
    else if (kind === "SET_AMMO_CONSERVATION") controller.dispatch({ type: "SET_AMMO_CONSERVATION", enabled: cfg.solver.ammoConservation });
  }

  return () => { cleanup.forEach((fn) => fn()); };
}

// ---- internals -----------------------------------------------------------

function listStratagems(data) {
  return Array.isArray(data.stratagems) ? data.stratagems : (data.stratagems?.stratagems ?? []);
}
function listArmor(data) {
  return Array.isArray(data.armor) ? data.armor : (data.armor?.passives ?? []);
}
function listBoosters(data) {
  return Array.isArray(data.boosters) ? data.boosters : (data.boosters?.boosters ?? []);
}

function mergeConfig(def, stored, data) {
  const cfg = structuredClone(def);
  if (stored.scenario) {
    if (data.factions[stored.scenario.faction]) {
      cfg.scenario.faction = stored.scenario.faction;
    }
    // Per-faction subfactions map. Read the new `subfactions` field if
    // present; otherwise fall back to the legacy single `subfaction` and
    // assign it to whichever faction the stored cfg was set on.
    cfg.scenario.subfactions = cfg.scenario.subfactions ?? defaultSubfactionsMap(data);
    if (stored.scenario.subfactions && typeof stored.scenario.subfactions === "object") {
      for (const fac of Object.keys(stored.scenario.subfactions)) {
        const validSubs = (data.factions[fac]?.subfactions ?? []).map((s) => s.id);
        const v = stored.scenario.subfactions[fac];
        if (validSubs.includes(v)) cfg.scenario.subfactions[fac] = v;
      }
    } else if (stored.scenario.subfaction) {
      const fac = stored.scenario.faction ?? cfg.scenario.faction;
      const validSubs = (data.factions[fac]?.subfactions ?? []).map((s) => s.id);
      if (validSubs.includes(stored.scenario.subfaction)) {
        cfg.scenario.subfactions[fac] = stored.scenario.subfaction;
      }
    }
    // Derive the active-faction subfaction (engine reads this).
    cfg.scenario.subfaction = cfg.scenario.subfactions[cfg.scenario.faction]
      ?? data.factions[cfg.scenario.faction]?.subfactions?.[0]?.id
      ?? "standard";
    if (ENCOUNTERS.includes(stored.scenario.encounter)) cfg.scenario.encounter = stored.scenario.encounter;
    const d = Number(stored.scenario.difficulty);
    if (Number.isInteger(d) && d >= 1 && d <= 10) cfg.scenario.difficulty = d;
    const m = Number(stored.scenario.spawnRateMultiplier);
    if (Number.isFinite(m) && m >= 0.25 && m <= 4) cfg.scenario.spawnRateMultiplier = m;
    if (typeof stored.scenario.infiniteWaves === "boolean") cfg.scenario.infiniteWaves = stored.scenario.infiniteWaves;
    if (typeof stored.scenario.playerMovement === "boolean") cfg.scenario.playerMovement = stored.scenario.playerMovement;
    if (stored.scenario.waveCadenceSecs == null) {
      cfg.scenario.waveCadenceSecs = 43;
    } else {
      const wc = Number(stored.scenario.waveCadenceSecs);
      if (Number.isFinite(wc) && wc >= 5 && wc <= 600) cfg.scenario.waveCadenceSecs = wc;
    }
  }
  if (stored.loadout) {
    const strats = new Set(listStratagems(data).map((s) => s.id));
    const prims = new Set((data.weapons?.primaries ?? []).map((w) => w.id));
    const secs = new Set((data.weapons?.secondaries ?? []).map((w) => w.id));
    const grens = new Set((data.weapons?.grenades ?? []).map((w) => w.id));
    const armor = new Set(listArmor(data).map((a) => a.id));
    const boosters = new Set(listBoosters(data).map((b) => b.id));
    if (Array.isArray(stored.loadout.stratagems)) {
      for (let i = 0; i < 4; i++) {
        const s = stored.loadout.stratagems[i];
        if (s && strats.has(s)) cfg.loadout.stratagems[i] = s;
      }
    }
    if (prims.has(stored.loadout.primary)) cfg.loadout.primary = stored.loadout.primary;
    if (secs.has(stored.loadout.secondary)) cfg.loadout.secondary = stored.loadout.secondary;
    if (grens.has(stored.loadout.grenade)) cfg.loadout.grenade = stored.loadout.grenade;
    if (armor.has(stored.loadout.armor)) cfg.loadout.armor = stored.loadout.armor;
    if (boosters.has(stored.loadout.booster)) cfg.loadout.booster = stored.loadout.booster;
  }
  if (stored.solver) {
    const a = Number(stored.solver.alpha);
    if (a >= 0 && a <= 1) cfg.solver.alpha = a;
    const g = Number(stored.solver.gamma);
    if (g >= 0 && g <= 1) cfg.solver.gamma = g;
    const sk = Number(stored.solver.skill);
    if (sk >= 0.5 && sk <= 2) cfg.solver.skill = sk;
    if (typeof stored.solver.ammoConservation === "boolean") cfg.solver.ammoConservation = stored.solver.ammoConservation;
  }
  if (Number.isInteger(stored.seed)) cfg.seed = stored.seed;
  return cfg;
}

// Faction tabs do double duty: clicking the tab body selects the faction
// (single mode); clicking the chevron-chip on the tab opens a popover that
// lets the user pick that faction's subfaction. The chip works in both
// single and "all" modes, so each lane in the all-view stays configurable.
function bindFactionSegment(root, cfg, data, onChange) {
  const seg = root.querySelector("#faction-seg");
  if (!seg) return;

  // Build chip + arrow inside each tab once; subsequent paints just update
  // the chip text. Click handler on the chip stops propagation so it doesn't
  // also fire the tab's faction-select click.
  const popover = ensureSubfactionPopover();

  seg.querySelectorAll(".seg-btn").forEach((btn) => {
    const facId = btn.dataset.value;
    if (!btn.querySelector(".faction-name")) {
      const name = document.createElement("span");
      name.className = "faction-name";
      name.textContent = btn.textContent.trim();
      const chip = document.createElement("span");
      chip.className = "subfaction-chip";
      chip.dataset.faction = facId;
      chip.title = "subfaction — click to change";
      chip.innerHTML = `<span class="subfaction-chip-name"></span><span class="subfaction-chip-arrow">▾</span>`;
      btn.textContent = "";
      btn.appendChild(name);
      btn.appendChild(chip);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        openSubfactionPopover({
          chip,
          faction: facId,
          data,
          getCfg: () => cfg,
          onPick: (subId) => {
            const subsMap = { ...(cfg.scenario.subfactions ?? {}) };
            subsMap[facId] = subId;
            const next = { ...cfg, scenario: { ...cfg.scenario, subfactions: subsMap } };
            // If the changed faction is the active one, update the derived
            // `subfaction` field that the engine reads.
            if (cfg.scenario.faction === facId) next.scenario.subfaction = subId;
            cfg = next;
            paintSubfactionChips(root, cfg, data);
            onChange(next);
          },
        });
      });
    }

    btn.addEventListener("click", () => {
      if (seg.classList.contains("disabled")) return;
      const v = btn.dataset.value;
      if (cfg.scenario.faction === v) return;
      const subForFac = (cfg.scenario.subfactions ?? {})[v]
        ?? data.factions[v].subfactions[0].id;
      const next = { ...cfg, scenario: { ...cfg.scenario, faction: v, subfaction: subForFac } };
      cfg = next;
      paintSegment(seg, v);
      paintSubfactionChips(root, cfg, data);
      onChange(next);
    });
  });

  paintSubfactionChips(root, cfg, data);
  // Close popover on resize / scroll / outside-click — handled by the
  // popover module itself; nothing else to wire here.
  popover; // referenced to prevent dead-code stripping in some bundlers
}

let _subfactionPop = null;
function ensureSubfactionPopover() {
  if (_subfactionPop) return _subfactionPop;
  const el = document.createElement("div");
  el.className = "subfaction-pop";
  el.hidden = true;
  document.body.appendChild(el);
  _subfactionPop = el;
  document.addEventListener("click", () => hideSubfactionPopover());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideSubfactionPopover(); });
  window.addEventListener("scroll", () => hideSubfactionPopover(), true);
  window.addEventListener("resize", () => hideSubfactionPopover());
  return el;
}

function hideSubfactionPopover() {
  if (_subfactionPop) _subfactionPop.hidden = true;
}

function openSubfactionPopover({ chip, faction, data, getCfg, onPick }) {
  const pop = ensureSubfactionPopover();
  const subs = data.factions?.[faction]?.subfactions ?? [];
  const cfg = getCfg();
  const current = (cfg.scenario.subfactions ?? {})[faction];
  pop.innerHTML = "";
  pop.dataset.faction = faction;
  const header = document.createElement("div");
  header.className = "subfaction-pop-header";
  header.textContent = `${faction} subfaction`;
  pop.appendChild(header);
  for (const sub of subs) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "subfaction-pop-item";
    if (sub.id === current) row.classList.add("active");
    row.textContent = sub.name ?? sub.id;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      hideSubfactionPopover();
      if (sub.id !== current) onPick(sub.id);
    });
    pop.appendChild(row);
  }
  pop.hidden = false;
  // Position below the chip; flip above if it would clip the viewport.
  pop.style.left = "0px";
  pop.style.top = "0px";
  const r = chip.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let x = r.left;
  let y = r.bottom + 4;
  if (y + pr.height > window.innerHeight - 8) y = r.top - pr.height - 4;
  x = Math.max(8, Math.min(window.innerWidth - pr.width - 8, x));
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
}

function paintSubfactionChips(root, cfg, data) {
  const seg = root.querySelector("#faction-seg");
  if (!seg) return;
  const subsMap = cfg.scenario.subfactions ?? {};
  seg.querySelectorAll(".seg-btn").forEach((btn) => {
    const facId = btn.dataset.value;
    const chipName = btn.querySelector(".subfaction-chip-name");
    if (!chipName) return;
    const subId = subsMap[facId] ?? data.factions?.[facId]?.subfactions?.[0]?.id ?? "";
    const subDef = (data.factions?.[facId]?.subfactions ?? []).find((s) => s.id === subId);
    chipName.textContent = subDef?.name ?? subId;
  });
}

function bindEncounterSegment(root, cfg, onChange) {
  const seg = root.querySelector("#encounter-seg");
  if (!seg) return;
  seg.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.value;
      if (cfg.scenario.encounter === v) return;
      const next = { ...cfg, scenario: { ...cfg.scenario, encounter: v } };
      paintSegment(seg, v);
      onChange(next);
    });
  });
}

function bindDifficulty(root, cfg, onChange) {
  const input = root.querySelector("#difficulty");
  if (!input) return;
  const commit = () => {
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) { input.value = String(cfg.scenario.difficulty); return; }
    const v = Math.max(1, Math.min(10, Math.round(raw)));
    if (String(v) !== input.value) input.value = String(v);
    const next = { ...cfg, scenario: { ...cfg.scenario, difficulty: v } };
    onChange(next);
  };
  input.addEventListener("change", commit);
}

function bindSpawnRate(root, cfg, onChange) {
  const slider = root.querySelector("#spawn-rate");
  const label = root.querySelector("#spawn-rate-val");
  if (!slider) return;
  const paint = (v) => { if (label) label.textContent = `${v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×`; };
  paint(Number(slider.value));
  slider.addEventListener("input", () => {
    const v = Math.max(0.25, Math.min(4, Number(slider.value)));
    paint(v);
    const next = { ...cfg, scenario: { ...cfg.scenario, spawnRateMultiplier: v } };
    onChange(next);
  });
}

function bindInfiniteWaves(root, cfg, onChange) {
  const cb = root.querySelector("#infinite-waves");
  if (!cb) return;
  cb.checked = cfg.scenario.infiniteWaves !== false;
  cb.addEventListener("change", () => {
    const next = { ...cfg, scenario: { ...cfg.scenario, infiniteWaves: !!cb.checked } };
    onChange(next);
  });
}

function bindPlayerMovement(root, cfg, onChange) {
  const cb = root.querySelector("#player-movement");
  if (!cb) return;
  cb.checked = cfg.scenario.playerMovement === true;
  cb.addEventListener("change", () => {
    const next = { ...cfg, scenario: { ...cfg.scenario, playerMovement: !!cb.checked } };
    onChange(next);
  });
}

function bindAmmoConservation(root, cfg, onChange) {
  const cb = root.querySelector("#ammo-conservation");
  if (!cb) return;
  cb.checked = cfg.solver?.ammoConservation === true;
  cb.addEventListener("change", () => {
    const next = { ...cfg, solver: { ...(cfg.solver ?? {}), ammoConservation: !!cb.checked } };
    onChange(next);
  });
}

function bindSpawnNow(root, controller) {
  const btn = root.querySelector("#wave-spawn-now");
  if (!btn) return;
  btn.addEventListener("click", () => {
    controller.dispatch({ type: "TRIGGER_WAVE" });
  });
}

function bindWaveCadence(root, cfg, onChange) {
  const input = root.querySelector("#wave-cadence");
  if (!input) return;
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    const v = raw === ""
      ? defaultWaveCadenceSecs(cfg.scenario.difficulty)
      : Math.max(5, Math.min(600, Math.round(Number(raw))));
    if (!Number.isFinite(v)) return;
    input.value = String(v);
    onChange({ ...cfg, scenario: { ...cfg.scenario, waveCadenceSecs: v } });
  });
}

// Live countdown bar next to the wave-interval input. Reads snapshot.nextWaveT
// (the scheduled start of the next wave, set when the engine queues one) and
// counts down cadence → 0 as that moment approaches. While a wave is firing
// its own spawn intents, nextWaveT is null and the bar shows "incoming"
// (enemies alive) or "—" (idle).
function paintWaveTimer(root, cfg, snap) {
  const timer = root.querySelector("#wave-cadence-timer");
  if (!timer) return;
  const fill = timer.querySelector(".wave-cadence-fill");
  const label = timer.querySelector(".wave-cadence-secs");
  if (!fill || !label) return;

  const enabled = cfg.scenario.infiniteWaves !== false;
  if (!enabled) {
    timer.dataset.state = "off";
    fill.style.width = "0%";
    label.textContent = "off";
    return;
  }

  const cadence = cfg.scenario.waveCadenceSecs ?? defaultWaveCadenceSecs(cfg.scenario.difficulty);
  const next = snap?.nextWaveT;
  const t = snap?.t ?? 0;

  if (next == null || !Number.isFinite(next) || next <= t) {
    const aliveCount = (snap?.enemies ?? []).filter((e) => e.alive).length;
    timer.dataset.state = aliveCount > 0 ? "active" : "idle";
    fill.style.width = aliveCount > 0 ? "100%" : "0%";
    label.textContent = aliveCount > 0 ? "incoming" : "—";
    return;
  }

  const remainingSecs = (next - t) / 1000;
  const pct = Math.max(0, Math.min(1, 1 - remainingSecs / cadence));
  timer.dataset.state = "active";
  fill.style.width = `${(pct * 100).toFixed(1)}%`;
  label.textContent = remainingSecs >= 1
    ? `${remainingSecs.toFixed(1)}s`
    : `${Math.round(remainingSecs * 1000)}ms`;
}

// Inline log of the most-recently-spawned wave: "wave 4 — 12× hunter, 4×
// warrior". Reads `snapshot.lastSpawnedWave` (set by engine pushWaveAtT for
// both auto and manual spawns) and tints accent on manual triggers so the user
// sees confirmation that the button did something.
function paintWaveSpawnLog(root, snap) {
  const el = root.querySelector("#wave-spawn-log");
  if (!el) return;
  const w = snap?.lastSpawnedWave;
  if (!w) {
    el.dataset.state = "empty";
    el.textContent = "no waves yet";
    return;
  }
  const parts = [];
  for (const [enemyId, n] of Object.entries(w.counts)) {
    parts.push(`${n}× ${enemyId}`);
  }
  parts.sort();
  el.dataset.state = w.manual ? "manual" : "auto";
  el.textContent = `wave ${w.waveN} — ${parts.join(", ")}`;
}

function paintWaveCadenceState(root, cfg) {
  const input = root.querySelector("#wave-cadence");
  const hint = root.querySelector("#wave-cadence-hint");
  if (!input) return;
  const fallback = defaultWaveCadenceSecs(cfg.scenario.difficulty);
  const explicit = cfg.scenario.waveCadenceSecs;
  const enabled = cfg.scenario.infiniteWaves !== false;
  input.disabled = !enabled;
  input.placeholder = String(fallback);
  input.value = explicit == null ? String(fallback) : String(explicit);
  if (hint) hint.textContent = enabled ? "" : "off";
  const btn = root.querySelector("#wave-spawn-now");
  if (btn) btn.disabled = !enabled;
}

function bindLoadout(root, cfg, data, onChange) {
  const items = [
    ["strat-1", listStratagems(data),   (l, id) => (l.stratagems[0] = id)],
    ["strat-2", listStratagems(data),   (l, id) => (l.stratagems[1] = id)],
    ["strat-3", listStratagems(data),   (l, id) => (l.stratagems[2] = id)],
    ["strat-4", listStratagems(data),   (l, id) => (l.stratagems[3] = id)],
    ["primary", data.weapons.primaries, (l, id) => (l.primary = id)],
    ["secondary", data.weapons.secondaries, (l, id) => (l.secondary = id)],
    ["grenade", data.weapons.grenades,  (l, id) => (l.grenade = id)],
    ["armor",   listArmor(data),        (l, id) => (l.armor = id)],
    ["booster", listBoosters(data),     (l, id) => (l.booster = id)],
  ];
  for (const [id, list, setter] of items) {
    const sel = root.querySelector(`#${id}`);
    if (!sel) continue;
    fillOptions(sel, list);
    sel.addEventListener("change", () => {
      const newLoadout = structuredClone(cfg.loadout);
      setter(newLoadout, sel.value);
      const next = { ...cfg, loadout: newLoadout };
      paintDetail(root, id, list, sel.value);
      onChange(next);
    });
  }
}

function bindAlpha(root, cfg, onChange) {
  const slider = root.querySelector("#alpha");
  const label = root.querySelector("#alpha-val");
  if (!slider) return;
  slider.disabled = false;
  const paint = (v) => { if (label) label.textContent = v < 0.34 ? "clear" : v > 0.66 ? "survival" : "balanced"; };
  paint(Number(slider.value));
  slider.addEventListener("input", () => {
    const v = Number(slider.value);
    paint(v);
    const next = { ...cfg, solver: { ...cfg.solver, alpha: v } };
    onChange(next);
  });
}

function bindGamma(root, cfg, onChange) {
  const slider = root.querySelector("#gamma");
  const label = root.querySelector("#gamma-val");
  if (!slider) return;
  slider.disabled = false;
  const paint = (v) => { if (label) label.textContent = v < 0.15 ? "off" : v > 0.6 ? "right-tool" : "moderate"; };
  paint(Number(slider.value));
  slider.addEventListener("input", () => {
    const v = Number(slider.value);
    paint(v);
    const next = { ...cfg, solver: { ...cfg.solver, gamma: v } };
    onChange(next);
  });
}

function bindSkill(root, cfg, onChange) {
  const slider = root.querySelector("#skill");
  const label = root.querySelector("#skill-val");
  if (!slider) return;
  slider.disabled = false;
  // Player skill divides effective dispersion: 1.0 baseline, >1 tightens cone.
  const paint = (v) => {
    if (!label) return;
    label.textContent = v < 0.85 ? "shaky" : v > 1.4 ? "expert" : v > 1.05 ? "skilled" : "average";
  };
  paint(Number(slider.value));
  slider.addEventListener("input", () => {
    const v = Number(slider.value);
    paint(v);
    const next = { ...cfg, solver: { ...cfg.solver, skill: v } };
    onChange(next);
  });
}

function bindRunControls(root, controller) {
  const map = [
    ["#ctrl-play",    () => controller.dispatch({ type: "PLAY" })],
    ["#ctrl-pause",   () => controller.dispatch({ type: "PAUSE" })],
    ["#ctrl-step",    () => controller.dispatch({ type: "STEP" })],
    ["#ctrl-restart", () => controller.dispatch({ type: "RESTART" })],
  ];
  for (const [sel, fn] of map) {
    const btn = root.querySelector(sel);
    if (!btn) continue;
    btn.disabled = false;
    btn.addEventListener("click", fn);
  }
}

function bindPresets(root, data, onPick) {
  const row = root.querySelector("#presets-row");
  if (!row) return;
  const presets = data.presets ?? [];
  if (presets.length === 0) {
    row.innerHTML = `<span class="muted small">no presets loaded</span>`;
    return;
  }
  row.innerHTML = "";
  for (const p of presets) {
    const btn = document.createElement("button");
    btn.className = "preset-btn";
    btn.dataset.presetId = p.id;
    btn.textContent = p.name;
    btn.title = p.blurb ?? "";
    btn.addEventListener("click", () => onPick(p));
    row.appendChild(btn);
  }
}

function bindShareButton(root, getCfg) {
  let btn = root.querySelector("#ctrl-share");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "ctrl-share";
    btn.className = "ctrl-btn";
    btn.textContent = "share";
    const runRow = root.querySelector(".run-controls") ?? root.querySelector("header");
    if (runRow) runRow.appendChild(btn);
  }
  btn.addEventListener("click", async () => {
    const cfg = getCfg();
    const hash = encodeHash(cfg);
    const url = `${window.location.origin}${window.location.pathname}#${hash}`;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "copied!";
      setTimeout(() => (btn.textContent = "share"), 1200);
    } catch {
      window.prompt("Share URL:", url);
    }
  });
}

function syncUrlHash(cfg) {
  try {
    const hash = encodeHash(cfg);
    history.replaceState(null, "", `#${hash}`);
  } catch {}
}

function fillOptions(sel, list) {
  sel.innerHTML = "";
  for (const item of list) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.name;
    sel.appendChild(opt);
  }
}

function paintSegment(seg, value) {
  seg.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

function paintDetail(root, slotId, list, valueId) {
  const el = root.querySelector(`#${slotId}-detail`);
  if (!el) return;
  const item = list.find((x) => x.id === valueId);
  if (!item) { el.textContent = ""; return; }
  const bits = [];
  if (item.type) bits.push(item.type);
  if (item.cooldownSecs != null) bits.push(`cd ${item.cooldownSecs}s`);
  if (item.uses != null) bits.push(`${item.uses} uses`);
  if (item.armorPen != null) bits.push(`AP${item.armorPen}`);
  else if (item.ap != null) bits.push(`AP${item.ap}`);
  if (item.effect) bits.push(item.effect);
  el.textContent = bits.join(" · ");
}

function applyAll(root, cfg, data) {
  paintSegment(root.querySelector("#faction-seg"), cfg.scenario.faction);
  paintSegment(root.querySelector("#encounter-seg"), cfg.scenario.encounter);
  paintSubfactionChips(root, cfg, data);

  const diffInput = root.querySelector("#difficulty");
  if (diffInput) diffInput.value = String(cfg.scenario.difficulty);

  const spawnRateSlider = root.querySelector("#spawn-rate");
  const spawnRateLabel = root.querySelector("#spawn-rate-val");
  const m = cfg.scenario.spawnRateMultiplier ?? 1.0;
  if (spawnRateSlider) spawnRateSlider.value = String(m);
  if (spawnRateLabel) spawnRateLabel.textContent = `${m.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×`;

  const infCb = root.querySelector("#infinite-waves");
  if (infCb) infCb.checked = cfg.scenario.infiniteWaves !== false;

  const moveCb = root.querySelector("#player-movement");
  if (moveCb) moveCb.checked = cfg.scenario.playerMovement === true;

  paintWaveCadenceState(root, cfg);

  const alphaSlider = root.querySelector("#alpha");
  if (alphaSlider) alphaSlider.value = String(cfg.solver.alpha ?? 0.5);

  const gammaSlider = root.querySelector("#gamma");
  if (gammaSlider) gammaSlider.value = String(cfg.solver.gamma ?? 0.3);

  const skillSlider = root.querySelector("#skill");
  if (skillSlider) skillSlider.value = String(cfg.solver.skill ?? 1.0);

  const ammoCb = root.querySelector("#ammo-conservation");
  if (ammoCb) ammoCb.checked = cfg.solver?.ammoConservation === true;

  setSel(root, "strat-1", cfg.loadout.stratagems[0]);
  setSel(root, "strat-2", cfg.loadout.stratagems[1]);
  setSel(root, "strat-3", cfg.loadout.stratagems[2]);
  setSel(root, "strat-4", cfg.loadout.stratagems[3]);
  setSel(root, "primary", cfg.loadout.primary);
  setSel(root, "secondary", cfg.loadout.secondary);
  setSel(root, "grenade", cfg.loadout.grenade);
  setSel(root, "armor", cfg.loadout.armor);
  setSel(root, "booster", cfg.loadout.booster);

  paintDetail(root, "strat-1", listStratagems(data), cfg.loadout.stratagems[0]);
  paintDetail(root, "strat-2", listStratagems(data), cfg.loadout.stratagems[1]);
  paintDetail(root, "strat-3", listStratagems(data), cfg.loadout.stratagems[2]);
  paintDetail(root, "strat-4", listStratagems(data), cfg.loadout.stratagems[3]);
  paintDetail(root, "primary", data.weapons.primaries, cfg.loadout.primary);
  paintDetail(root, "secondary", data.weapons.secondaries, cfg.loadout.secondary);
  paintDetail(root, "grenade", data.weapons.grenades, cfg.loadout.grenade);
  paintDetail(root, "armor", listArmor(data), cfg.loadout.armor);
  paintDetail(root, "booster", listBoosters(data), cfg.loadout.booster);
}

function setSel(root, id, value) {
  const sel = root.querySelector(`#${id}`);
  if (sel && value != null) sel.value = value;
}
