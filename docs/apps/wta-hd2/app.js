import { loadData } from "./data-loader.js";
import { createEngine } from "./engine.js";
import { createController } from "./controller.js";
import { mountConfigUI, loadConfig } from "./config-ui.js";

async function main() {
  const status = document.getElementById("run-status");
  try {
    const data = await loadData("./data");

    // Diagnostic: confirm weapons have damage values. The "nothing fires"
    // bug was caused by stub data shipping with damage=0; if you see a
    // weapon listed here with damage=0, the data load is stale.
    const sampleWeapon = data.weapons?.primaries?.find((w) => w.id === "liberator");
    if (sampleWeapon && (sampleWeapon.damage ?? 0) === 0) {
      console.warn("wta-hd2: weapons.json has damage=0 — solver will not fire. Check browser cache.", sampleWeapon);
    } else if (sampleWeapon) {
      console.log(`wta-hd2: data loaded (Liberator damage=${sampleWeapon.damage}, ${data.weapons.primaries.length} primaries, ${data.stratagems.length} stratagems)`);
    }

    const cfg = loadConfig(data);

    // Diagnostic: log the resolved cfg so we can see what loadout actually loaded.
    console.log("wta-hd2: resolved cfg:", {
      faction: cfg.scenario.faction,
      subfaction: cfg.scenario.subfaction,
      encounter: cfg.scenario.encounter,
      difficulty: cfg.scenario.difficulty,
      loadout: cfg.loadout,
      alpha: cfg.solver.alpha,
      seed: cfg.seed,
    });

    // Sanity check: every loadout slot should resolve to a real def.
    const primDef = data.weapons.primaries.find((w) => w.id === cfg.loadout.primary);
    if (!primDef) {
      console.warn(`wta-hd2: primary "${cfg.loadout.primary}" not found in data — solver will not fire that slot. Try clicking RESET.`);
    } else if (!primDef.damage) {
      console.warn(`wta-hd2: primary "${cfg.loadout.primary}" has damage=${primDef.damage} — solver will not fire. Hard-refresh + RESET.`, primDef);
    }

    const controller = createController({
      engineFactory: createEngine,
      initialCfg: cfg,
      data,
    });

    mountConfigUI(document.body, controller, data);

    // Idle overlay: big PLAY button on the canvas while sim isn't running.
    const playOverlay = document.getElementById("play-overlay");
    const playBtn = document.getElementById("ctrl-play");
    const refreshIdleOverlay = () => {
      const playing = controller.isPlaying?.() ?? false;
      if (playOverlay) playOverlay.hidden = playing;
      if (playBtn) playBtn.classList.toggle("is-playing", playing);
    };
    if (playOverlay) {
      playOverlay.addEventListener("click", () => {
        controller.dispatch({ type: "PLAY" });
        refreshIdleOverlay();
      });
    }
    // Wrap dispatch so the overlay reflects PLAY/PAUSE/RESTART immediately,
    // not only after the next tick.
    const _origDispatch = controller.dispatch;
    controller.dispatch = (action) => {
      _origDispatch.call(controller, action);
      refreshIdleOverlay();
    };
    controller.subscribe(() => refreshIdleOverlay());
    refreshIdleOverlay();

    const canvas = document.getElementById("battlefield");
    const battlefieldPlaceholder = document.getElementById("battlefield-placeholder");
    if (canvas) {
      try {
        const { mountBattlefield } = await import("./render-battlefield.js");
        mountBattlefield(canvas, controller);
        if (battlefieldPlaceholder) battlefieldPlaceholder.remove();
      } catch (e) {
        console.warn("battlefield render unavailable:", e?.message ?? e);
      }
    }

    const analyticsRoot = document.querySelector(".analytics");
    if (analyticsRoot) {
      try {
        const { mountAnalytics } = await import("./render-analytics.js");
        analyticsRoot.innerHTML = "";
        mountAnalytics(analyticsRoot, controller);
      } catch (e) {
        console.warn("analytics render unavailable:", e?.message ?? e);
      }
    }

    // Compare mode: parallel lanes (one per faction by default) for the same loadout.
    const modeSeg = document.getElementById("mode-seg");
    const factionSeg = document.getElementById("faction-seg");
    const comparePane = document.getElementById("compare-pane");
    const hasStoredCfg = !!localStorage.getItem("wta-hd2.cfg") || !!window.location.hash;
    let active = !hasStoredCfg; // default ON for first-time visitors
    if (modeSeg && comparePane) {
      try {
        const { mountCompare } = await import("./render-compare.js");
        const compare = mountCompare({
          rootEl: comparePane,
          engineFactory: createEngine,
          getCfg: () => controller.getCfg(),
          data,
          getActive: () => active,
          mode: "factions",
        });
        const refresh = () => {
          comparePane.hidden = !active;
          comparePane.dataset.active = active ? "1" : "";
          if (canvas) canvas.style.display = active ? "none" : "";
          modeSeg.querySelectorAll(".seg-btn").forEach((b) => {
            b.classList.toggle("active", b.dataset.value === (active ? "all" : "single"));
          });
          if (factionSeg) {
            factionSeg.classList.toggle("disabled", active);
            factionSeg.setAttribute("aria-disabled", active ? "true" : "false");
          }
          if (active) compare.reset();
        };
        refresh();
        modeSeg.querySelectorAll(".seg-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const next = btn.dataset.value === "all";
            if (next === active) return;
            active = next;
            refresh();
          });
        });
      } catch (e) {
        console.warn("compare mode unavailable:", e?.message ?? e);
        modeSeg.querySelectorAll(".seg-btn").forEach((b) => (b.disabled = true));
      }
    }

    // Reset button — clear localStorage + URL hash, reload with default loadout.
    const resetBtn = document.getElementById("ctrl-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        try { localStorage.removeItem("wta-hd2.cfg"); } catch {}
        window.location.hash = "";
        window.location.reload();
      });
    }

    // Speed control — sim runs in real time at speed=1×. The L2 controller
    // multiplies real-time elapsed by speed, so 4× collapses 4 seconds of
    // sim into 1 wall-clock second (catch-up capped at 10 ticks/frame).
    const speedButtons = document.querySelectorAll(".speed-btn");
    speedButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const speed = Number(btn.dataset.speed);
        if (![0.5, 1, 2, 4].includes(speed)) return;
        controller.dispatch({ type: "SET_SPEED", speed });
        speedButtons.forEach((b) => b.classList.toggle("active", b === btn));
      });
    });

    if (status) status.textContent = "ready";

    // Runtime diagnostic: if play is on but no assignments after 5s, dump state.
    let firstTickT = null;
    let totalAssignments = 0;
    let warned = false;
    controller.subscribe((snap) => {
      if (firstTickT === null && snap.t > 0) firstTickT = snap.t;
      totalAssignments += (snap.assignments ?? []).length;
      if (!warned && firstTickT !== null && snap.t - firstTickT >= 5000) {
        warned = true;
        if (totalAssignments === 0) {
          const enemyCount = (snap.enemies ?? []).filter((e) => e.alive).length;
          const weaponCount = (snap.weapons ?? []).length + (snap.stratagems ?? []).length;
          console.warn(
            `wta-hd2: 0 assignments after 5s of play. enemies=${enemyCount} weapons=${weaponCount}`,
            "snapshot:", snap,
            "cfg:", controller.getCfg(),
          );
        } else {
          console.log(`wta-hd2: ${totalAssignments} assignments fired in first 5s of play.`);
        }
      }
    });
  } catch (err) {
    if (status) status.textContent = `load failed: ${err.message}`;
    console.error(err);
  }
}

main();
