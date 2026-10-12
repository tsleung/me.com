import { test } from "node:test";
import assert from "node:assert/strict";
import { runHeadless, makeWorld, advance, tide, score, T_CLOSE, KINDS } from "../sim.js";

// Each headless run takes a few seconds; every test uses as few as proves its point.
const SEEDS = [7919, 15838, 23757];

test("every run of both sides reaches an end before the window and its exfil run out", () => {
  for (const mode of ["burning", "mind"]) {
    for (const seed of SEEDS.slice(0, 2)) {
      const w = runHeadless(seed, mode);
      assert.ok(w.end, `${mode} seed ${seed} never ended`);
      assert.ok(w.t <= T_CLOSE + 61, `${mode} seed ${seed} ran to ${w.t}`);
    }
  }
});

test("a seed replays exactly: same decisions, same end, same score", () => {
  for (const mode of ["mind"]) {
    const a = runHeadless(SEEDS[2], mode);
    const b = runHeadless(SEEDS[2], mode);
    assert.deepEqual(
      a.decisions.map((d) => [d.t, d.kind, d.pick]),
      b.decisions.map((d) => [d.t, d.kind, d.pick]),
    );
    assert.deepEqual(a.end, b.end);
  }
});

test("replaying a run's own answers reproduces it; flipping one answer changes what follows", () => {
  const base = runHeadless(SEEDS[0], "burning");
  const same = runHeadless(SEEDS[0], "burning", base.decisions.map((d) => d.pick));
  assert.deepEqual(same.end, base.end);
  const commit = base.decisions.find((d) => d.kind === "commit" && d.pick === "go");
  assert.ok(commit, "the pilot commits");
  const answers = base.decisions.slice(0, commit.i).map((d) => d.pick).concat(["wait"]);
  const later = runHeadless(SEEDS[0], "burning", answers);
  assert.ok(later.commitT > base.commitT, "waiting one more decision commits later");
});

test("the harness stops at an unanswered decision without applying the pilot's answer", () => {
  const w = runHeadless(SEEDS[1], "burning", [], { stop: true });
  assert.ok(w.halt, "it halts");
  assert.equal(w.halt.kind, "commit");
  assert.equal(w.phase, "stage", "nothing was committed on the player's behalf");
  assert.equal(w.decisions.length, 0);
});

test("the score never counts kills", () => {
  const w = runHeadless(SEEDS[0], "burning");
  const kills = Object.values(w.m.kills).reduce((a, b) => a + b, 0);
  assert.ok(kills > 0);
  const before = score(w, w.end.win);
  w.m.kills = { drone: 0, loiterer: 0, humanoid: 0, heavy: 0, frame: 0 };
  w.actors.forEach((a) => (a.kills = 0));
  assert.equal(score(w, w.end.win), before);
});

test("the tide rises to a peak and falls before the window closes", () => {
  assert.ok(tide(0) < tide(120));
  assert.ok(tide(170) >= tide(120) && tide(170) >= tide(T_CLOSE));
  assert.ok(tide(T_CLOSE) < 0.75);
});

test("advance never mutates the world it is given", () => {
  const w0 = makeWorld(SEEDS[1], "mind");
  const snapshot = JSON.stringify(w0);
  advance(w0, 0.25, 4);
  assert.equal(JSON.stringify(w0), snapshot);
});

test("proportions are real: a person is under 2 m, a heavy frame is over three people tall", () => {
  assert.ok(KINDS.blade.H < 2 && KINDS.blade.H > 1.5);
  assert.ok(KINDS.heavy.H > 3 * KINDS.blade.H);
});
