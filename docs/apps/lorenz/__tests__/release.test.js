// Release-readiness guards.
//
// Every assertion here corresponds to a defect found by a cold audit before the
// first public deploy. They are pinned because each one is invisible in
// development and only bites in the deployed environment, on someone else's
// device, or for a user who is not the author.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rk4, seed, CLASSIC } from "../lorenz.js";
import { makeCamera, project, cameraExtents } from "../render.js";
import { makeSim } from "../sim.js";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(appDir, f), "utf8");
const html = read("index.html");
const css = read("style.css");
const js = readdirSync(appDir)
  .filter((f) => f.endsWith(".js"))
  .map(read)
  .join("\n");

test("the stylesheet does not @import the private _shared directory", () => {
  // `apps/_shared/` is private and does NOT ship with the docs/ deploy slice.
  // An @import there resolves to a 404 the moment this goes public, taking
  // every var() with it — an unstyled page on the brand site. Every app
  // already in docs/ inlines its tokens instead.
  assert.ok(!css.includes("_shared"), "style.css still references ../_shared");
  assert.match(css, /--bg:\s*#/, "tokens must be inlined, not imported");
  assert.match(css, /--mono:/, "the mono token must be inlined too");
});

test("no private repo paths appear in anything that would be deployed", () => {
  // These files become public verbatim. Internal paths both dangle and
  // advertise the private repo's structure.
  for (const [label, text] of [
    ["index.html", html],
    ["the JS bundle", js],
  ]) {
    for (const leak of ["notes/lorenz", "apps/next-read", "apps/_shared"]) {
      assert.ok(!text.includes(leak), `${label} leaks the private path ${leak}`);
    }
  }
});

test("the page still says something with JavaScript disabled or broken", () => {
  // All copy is gated behind an opacity class that only JS sets, so without a
  // fallback a script failure renders a permanently black page with one dead
  // button, no error, and no content.
  assert.match(html, /<noscript>/, "no <noscript> fallback");
  const noscript = html.slice(html.indexOf("<noscript>"), html.indexOf("</noscript>"));
  assert.match(noscript, /\.reveal\s*\{[^}]*opacity:\s*1/, "noscript must reveal the chrome");
});

test("no per-frame readout is an implicit live region", () => {
  // <output> carries an implicit role="status" (aria-live=polite). Any of them
  // rewritten every frame is a 60Hz announcement flood for screen readers.
  const perFrame = ["r-t", "r-fork", "r-delta", "r-dnorm", "r-v", "r-u", "r-lambda-live"];
  for (const id of perFrame) {
    assert.ok(
      !new RegExp(`<output[^>]*id="${id}"`).test(html),
      `#${id} updates every frame and must not be an <output>`,
    );
  }
});

test("the hidden attribute actually hides", () => {
  // `.row { display: grid }` is an author declaration and beats the UA's
  // `[hidden] { display: none }` regardless of specificity — so `.hidden = true`
  // on a `.row` silently did nothing.
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test("explanatory text does not use the sub-AA token", () => {
  // --ink-dim measures ~3.3:1 on --panel. It was carrying every blurb, legend
  // and stat label, so the page rendered its explanations less legibly than the
  // numbers they explain.
  for (const sel of [".blurb {", ".stat .k {"]) {
    const i = css.indexOf(sel);
    assert.ok(i > 0, `${sel} not found`);
    const rule = css.slice(i, css.indexOf("}", i));
    assert.ok(
      !rule.includes("var(--ink-dim)"),
      `${sel} uses --ink-dim, which fails WCAG AA for text`,
    );
  }
});

test("Array.prototype.at is not used in shipped code", () => {
  // Safari 15.4+. A throw inside frame() kills the rAF loop outright, so on
  // iOS 15.0–15.3 this is not a degraded page, it is a dead one.
  assert.ok(!/\.at\(-?\d/.test(js), "`.at()` found — use explicit indexing");
});

test("the camera frames the attractor across the whole slider range", () => {
  // Extents used to be hardcoded to the classic attractor while rho is a live
  // slider to 60. Past rho ~35 the attractor simply climbed out of the frame,
  // and the in-app notes explicitly invite moving rho.
  const W = 1200;
  const H = 700;
  for (const params of [
    CLASSIC,
    { sigma: 10, rho: 40, beta: 8 / 3 },
    { sigma: 20, rho: 60, beta: 6 },
    { sigma: 1, rho: 2, beta: 0.5 },
  ]) {
    const cam = makeCamera(W, H, { yaw: 0, params });
    let s = seed(CLASSIC);
    let lo = Infinity;
    let hi = -Infinity;
    let wide = 0;
    for (let i = 0; i < 40000; i++) {
      s = rk4(s, params, 0.004);
      const p = project(s, cam);
      lo = Math.min(lo, p.sy);
      hi = Math.max(hi, p.sy);
      wide = Math.max(wide, Math.abs(p.sx - W / 2));
    }
    assert.ok(lo > -H * 0.05, `rho=${params.rho}: clipped off the top (sy ${lo.toFixed(0)})`);
    assert.ok(hi < H * 1.05, `rho=${params.rho}: clipped off the bottom (sy ${hi.toFixed(0)})`);
    assert.ok(wide < W * 0.55, `rho=${params.rho}: clipped horizontally`);
  }
});

test("cameraExtents degrades sanely without params", () => {
  const d = cameraExtents(null);
  assert.ok(d.extentX > 0 && d.extentZ > 0 && Number.isFinite(d.zCenter));
  assert.deepEqual(cameraExtents({ rho: 0.5, beta: 1 }), cameraExtents(null), "rho<1 has no wings");
});

test("new seed actually produces a new trajectory", () => {
  // There is no Math.random in the math tier by design, so this button used to
  // clear the trail and redraw a bit-identical curve — a control that lied.
  const starts = new Set();
  for (let i = 0; i < 12; i++) {
    const s = makeSim(CLASSIC, 1e-4, 8 + (i * 14) / 12);
    starts.add(`${s.a.x.toFixed(6)},${s.a.z.toFixed(6)}`);
    assert.ok(s.a.z > 1 && s.a.z < 60, "every seed must land on the attractor");
  }
  assert.ok(starts.size >= 10, `only ${starts.size} distinct starts from 12 seeds`);

  // …while the underlying seed() stays deterministic, which the tests rely on.
  assert.deepEqual(seed(CLASSIC), seed(CLASSIC));
});

test("a paused app stops repainting", () => {
  // Pausing stopped the simulation but not the painting: a full clear plus
  // ~700–2000 strokes a frame, forever, redrawing an identical picture.
  assert.match(js, /needsRepaint/, "no repaint gate found");
  assert.match(
    js,
    /if \(simDt > 0 \|\| S\.needsRepaint\)/,
    "drawStage must be gated on time advancing or an explicit repaint request",
  );
});
