import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregatePKillByArchetype,
  archetypesById,
  aliveCountsByTier,
  historyAxisBounds,
  fmtSeconds,
  cooldownDashArray,
  foldHeatmapCredits,
  shortArchLabel,
} from "../analytics-helpers.js";

// ----- aggregatePKillByArchetype -----

test("aggregatePKillByArchetype: empty inputs → empty map", () => {
  const out = aggregatePKillByArchetype([], []);
  assert.equal(out.size, 0);
});

test("aggregatePKillByArchetype: single weapon → single archetype credit = 1.0", () => {
  const enemies = [{ id: "e1", archetypeId: "warrior", alive: true }];
  const assignments = [{ weaponId: "primary", targetId: "e1", shots: 3 }];
  const out = aggregatePKillByArchetype(assignments, enemies);
  assert.equal(out.get("primary").get("warrior"), 1);
});

test("aggregatePKillByArchetype: two weapons share a target → credits sum to 1", () => {
  const enemies = [{ id: "e1", archetypeId: "charger", alive: true }];
  const assignments = [
    { weaponId: "strat-1", targetId: "e1", shots: 1 },
    { weaponId: "primary", targetId: "e1", shots: 3 },
  ];
  const out = aggregatePKillByArchetype(assignments, enemies);
  const a = out.get("strat-1").get("charger");
  const b = out.get("primary").get("charger");
  assert.ok(Math.abs(a - 0.25) < 1e-9, `got ${a}`);
  assert.ok(Math.abs(b - 0.75) < 1e-9, `got ${b}`);
  assert.ok(Math.abs(a + b - 1) < 1e-9);
});

test("aggregatePKillByArchetype: same weapon hits two enemies of same archetype → credits add", () => {
  const enemies = [
    { id: "e1", archetypeId: "hunter", alive: true },
    { id: "e2", archetypeId: "hunter", alive: true },
  ];
  const assignments = [
    { weaponId: "primary", targetId: "e1", shots: 2 },
    { weaponId: "primary", targetId: "e2", shots: 2 },
  ];
  const out = aggregatePKillByArchetype(assignments, enemies);
  assert.equal(out.get("primary").get("hunter"), 2);
});

test("aggregatePKillByArchetype: assignment to vanished target is dropped", () => {
  const enemies = [{ id: "e1", archetypeId: "hunter", alive: true }];
  const assignments = [
    { weaponId: "primary", targetId: "e1", shots: 1 },
    { weaponId: "secondary", targetId: "ghost", shots: 4 },
  ];
  const out = aggregatePKillByArchetype(assignments, enemies);
  assert.ok(out.has("primary"));
  assert.ok(!out.has("secondary"));
});

// ----- archetypesById -----

test("archetypesById: builds id→archetype map", () => {
  const m = archetypesById({ archetypes: [{ id: "a" }, { id: "b" }] });
  assert.equal(m.size, 2);
  assert.equal(m.get("a").id, "a");
});

test("archetypesById: tolerates missing/invalid input", () => {
  assert.equal(archetypesById(null).size, 0);
  assert.equal(archetypesById({}).size, 0);
  assert.equal(archetypesById({ archetypes: [null, { id: "x" }] }).size, 1);
});

// ----- aliveCountsByTier -----

test("aliveCountsByTier: alive bucketed; dead ignored", () => {
  const enemies = [
    { alive: true, threatTier: "light" },
    { alive: true, threatTier: "light" },
    { alive: true, threatTier: "heavy" },
    { alive: false, threatTier: "boss" },
  ];
  const c = aliveCountsByTier(enemies);
  assert.deepEqual(c, { light: 2, medium: 0, heavy: 1, boss: 0 });
});

test("aliveCountsByTier: unknown tier ignored, empty input safe", () => {
  assert.deepEqual(aliveCountsByTier([]), { light: 0, medium: 0, heavy: 0, boss: 0 });
  assert.deepEqual(
    aliveCountsByTier([{ alive: true, threatTier: "elite" }]),
    { light: 0, medium: 0, heavy: 0, boss: 0 },
  );
});

// ----- historyAxisBounds -----

test("historyAxisBounds: empty history → defaults", () => {
  const b = historyAxisBounds([]);
  assert.equal(b.tMin, 0);
  assert.equal(b.tMax, 1);
  assert.equal(b.advanceMax, 1);
  assert.equal(b.survivalMax, 80);
});

test("historyAxisBounds: tracks t range; pins advance/survival ranges", () => {
  const h = [
    { t: 0,    advance: { fractionCleared: 0 },    survival: { closestEnemyM: 80 } },
    { t: 5000, advance: { fractionCleared: 0.5 },  survival: { closestEnemyM: 30 } },
  ];
  const b = historyAxisBounds(h);
  assert.equal(b.tMin, 0);
  assert.equal(b.tMax, 5000);
  assert.equal(b.advanceMin, 0);
  assert.equal(b.advanceMax, 1);
  assert.equal(b.survivalMin, 0);
  assert.equal(b.survivalMax, 80);
});

test("historyAxisBounds: Infinity closest distance is capped", () => {
  const h = [{ t: 100, advance: { fractionCleared: 0 }, survival: { closestEnemyM: Infinity } }];
  const b = historyAxisBounds(h);
  // No NaN/Infinity should leak into bounds.
  assert.ok(Number.isFinite(b.tMin));
  assert.ok(Number.isFinite(b.tMax));
  assert.ok(Number.isFinite(b.survivalMax));
});

// ----- fmtSeconds -----

test("fmtSeconds: rounds to one decimal with 's' suffix", () => {
  assert.equal(fmtSeconds(0), "0.0s");
  assert.equal(fmtSeconds(1234), "1.2s");
  assert.equal(fmtSeconds(12345), "12.3s");
});

test("fmtSeconds: invalid input → '0.0s'", () => {
  assert.equal(fmtSeconds(NaN), "0.0s");
  assert.equal(fmtSeconds(Infinity), "0.0s");
  assert.equal(fmtSeconds(undefined), "0.0s");
});

// ----- cooldownDashArray -----

test("cooldownDashArray: pct=1 → fully filled", () => {
  const r = 10;
  const { dashArray, filled, gap, circumference } = cooldownDashArray(1, r);
  assert.ok(Math.abs(filled - 2 * Math.PI * r) < 1e-9);
  assert.ok(Math.abs(gap) < 1e-9);
  assert.ok(circumference > 0);
  assert.equal(typeof dashArray, "string");
});

test("cooldownDashArray: pct=0 → empty", () => {
  const { filled, gap, circumference } = cooldownDashArray(0, 10);
  assert.equal(filled, 0);
  assert.ok(Math.abs(gap - circumference) < 1e-9);
});

test("cooldownDashArray: clamps pct to [0,1]; tolerates bad inputs", () => {
  const a = cooldownDashArray(2, 10);
  const b = cooldownDashArray(1, 10);
  assert.ok(Math.abs(a.filled - b.filled) < 1e-9);
  const c = cooldownDashArray(-0.5, 10);
  assert.equal(c.filled, 0);
  const d = cooldownDashArray(NaN, 10);
  assert.equal(d.filled, 0);
});

// ----- foldHeatmapCredits -----

test("foldHeatmapCredits: empty snapshots leave cum empty", () => {
  const s = { cum: new Map(), lastTickN: -1 };
  foldHeatmapCredits(s, { tickN: 0, assignments: [], enemies: [] });
  foldHeatmapCredits(s, { tickN: 1, assignments: [], enemies: [] });
  assert.equal(s.cum.size, 0);
});

test("foldHeatmapCredits: accumulates across ticks", () => {
  const s = { cum: new Map(), lastTickN: -1 };
  const enemies = [{ id: "e1", archetypeId: "warrior", alive: true }];
  foldHeatmapCredits(s, {
    tickN: 1,
    enemies,
    assignments: [{ weaponId: "primary", targetId: "e1", shots: 1 }],
  });
  foldHeatmapCredits(s, {
    tickN: 2,
    enemies,
    assignments: [{ weaponId: "primary", targetId: "e1", shots: 1 }],
  });
  assert.equal(s.cum.get("primary").get("warrior"), 2);
});

test("foldHeatmapCredits: resets when tickN drops (run restart)", () => {
  const s = { cum: new Map(), lastTickN: -1 };
  const enemies = [{ id: "e1", archetypeId: "warrior", alive: true }];
  foldHeatmapCredits(s, {
    tickN: 5, enemies,
    assignments: [{ weaponId: "primary", targetId: "e1", shots: 1 }],
  });
  assert.equal(s.cum.get("primary").get("warrior"), 1);
  // Restart: tickN goes back to 0 → cumulative wiped.
  foldHeatmapCredits(s, { tickN: 0, enemies: [], assignments: [] });
  assert.equal(s.cum.size, 0);
});

// ----- shortArchLabel -----

test("shortArchLabel: strips faction prefix", () => {
  assert.equal(shortArchLabel("terminid-warrior"), "warrior");
  assert.equal(shortArchLabel("automaton-devastator"), "devastator");
  assert.equal(shortArchLabel("automaton-heavy-devastator"), "heavy-dev…");
  assert.equal(shortArchLabel("illuminate-overseer"), "overseer");
});

test("shortArchLabel: distinct ids produce distinct labels", () => {
  const ids = ["terminid-warrior", "terminid-hunter", "terminid-charger", "terminid-bile-spewer"];
  const labels = ids.map(shortArchLabel);
  assert.equal(new Set(labels).size, labels.length);
});

test("shortArchLabel: tolerates bad input", () => {
  assert.equal(shortArchLabel(""), "");
  assert.equal(shortArchLabel(null), "");
  assert.equal(shortArchLabel("plain"), "plain");
});
