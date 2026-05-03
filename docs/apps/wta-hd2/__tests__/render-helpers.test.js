import { test } from "node:test";
import assert from "node:assert/strict";
import {
  worldToScreen,
  pixelsPerMeter,
  radiusByTier,
  colorByTier,
  colorByFaction,
  colorBySlot,
  hpBarWidth,
  arcWedgePoints,
  PLAYER_BOTTOM_GUTTER_PX,
} from "../render-helpers.js";

const DIMS = { W: 800, H: 600 };

test("worldToScreen: origin maps to center-bottom-ish (W/2, H - gutter)", () => {
  const { sx, sy } = worldToScreen({ x: 0, y: 0 }, DIMS);
  assert.equal(sx, DIMS.W / 2);
  assert.equal(sy, DIMS.H - PLAYER_BOTTOM_GUTTER_PX);
});

test("worldToScreen: forward (+y) maps upward (smaller screen y)", () => {
  const origin = worldToScreen({ x: 0, y: 0 }, DIMS);
  const forward = worldToScreen({ x: 0, y: 20 }, DIMS);
  assert.ok(forward.sy < origin.sy, `expected forward sy < origin sy, got ${forward.sy} vs ${origin.sy}`);
  assert.equal(forward.sx, origin.sx);
});

test("worldToScreen: lateral (+x) maps rightward (larger screen x)", () => {
  const origin = worldToScreen({ x: 0, y: 0 }, DIMS);
  const right = worldToScreen({ x: 10, y: 0 }, DIMS);
  const left = worldToScreen({ x: -10, y: 0 }, DIMS);
  assert.ok(right.sx > origin.sx);
  assert.ok(left.sx < origin.sx);
  // symmetric
  assert.equal(right.sx - origin.sx, origin.sx - left.sx);
});

test("pixelsPerMeter: positive and finite for sane canvas dims", () => {
  const ppm = pixelsPerMeter(800, 600);
  assert.ok(ppm > 0);
  assert.ok(Number.isFinite(ppm));
});

test("radiusByTier: heavier tiers strictly larger", () => {
  assert.ok(radiusByTier("light") < radiusByTier("medium"));
  assert.ok(radiusByTier("medium") < radiusByTier("heavy"));
  assert.ok(radiusByTier("heavy") < radiusByTier("boss"));
  // unknown tier still returns a number
  assert.equal(typeof radiusByTier("unknown"), "number");
});

test("colorByTier: returns a string and distinguishes light vs boss", () => {
  const light = colorByTier("light");
  const boss = colorByTier("boss");
  assert.equal(typeof light, "string");
  assert.equal(typeof boss, "string");
  assert.notEqual(light, boss);
});

test("colorByFaction: known factions return distinct colors; unknown gets default", () => {
  assert.notEqual(colorByFaction("terminids"), colorByFaction("automatons"));
  assert.notEqual(colorByFaction("automatons"), colorByFaction("illuminate"));
  assert.equal(typeof colorByFaction("notafaction"), "string");
});

test("colorBySlot: strat-1 red, primary white, unknown gray default", () => {
  assert.equal(colorBySlot("strat-1"), "#ff3a3a");
  assert.equal(colorBySlot("primary"), "#ffffff");
  // alias slot1 also red
  assert.equal(colorBySlot("slot1"), "#ff3a3a");
  // unknown gets a sensible default (gray-ish)
  const unknown = colorBySlot("nope");
  assert.equal(typeof unknown, "string");
  assert.ok(unknown.startsWith("#"));
});

test("hpBarWidth: 0 when current=0; full when current=max; half at half", () => {
  assert.equal(hpBarWidth(0, 100, 40), 0);
  assert.equal(hpBarWidth(100, 100, 40), 40);
  assert.equal(hpBarWidth(50, 100, 40), 20);
});

test("hpBarWidth: clamps over-max and negative; safe on hpMax=0", () => {
  assert.equal(hpBarWidth(150, 100, 40), 40);
  assert.equal(hpBarWidth(-5, 100, 40), 0);
  assert.equal(hpBarWidth(50, 0, 40), 0);
  assert.equal(hpBarWidth(NaN, 100, 40), 0);
});

test("arcWedgePoints: symmetric around center; points up", () => {
  const halfAngle = (60 * Math.PI) / 180; // 120° cone, 60° each side
  const w = arcWedgePoints(DIMS, halfAngle, 80);
  assert.equal(w.cx, DIMS.W / 2);
  assert.equal(w.cy, DIMS.H - PLAYER_BOTTOM_GUTTER_PX);
  // left + right symmetric around cx
  assert.ok(Math.abs((w.cx - w.leftX) - (w.rightX - w.cx)) < 1e-9);
  // top is above origin
  assert.ok(w.topY < w.cy);
});
