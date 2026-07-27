// Static wiring guard.
//
// The math in this app is well covered; the DOM is not, and it is where a
// silent break actually ships — a renamed id makes `el(...)` return null and
// the whole animation loop dies on the first frame with nothing in the tests
// to catch it. These checks are cheap, need no DOM, and pin the contract
// between index.html and app.js in both directions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const read = (f) => readFileSync(join(appDir, f), "utf8");

const html = read("index.html");

// Scan EVERY module, not just app.js. Scoping this to one file made the check
// a hostage to file layout: moving the DOM bindings into their own module —
// which is exactly what a refactor does — collapsed the lookup set and failed
// both checks against correct code. The contract being pinned is
// "index.html ids ↔ the app", and the app is all of these files.
const moduleNames = readdirSync(appDir).filter((f) => f.endsWith(".js"));
const sources = Object.fromEntries(moduleNames.map((f) => [f, read(f)]));
const allJs = Object.values(sources).join("\n");

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// hud.js addresses its ids through returned maps rather than `el(...)` calls,
// so it declares them as literal arrays and we IMPORT those. Widening the regex
// to scan object-literal keys was the other option and it over-matches: every
// quoted key in the file would look like a DOM id.
const { READOUT_IDS, STATIC_IDS } = await import("../hud.js");

const looked = new Set([
  ...[...allJs.matchAll(/\bel\("([^"]+)"\)/g)].map((m) => m[1]),
  ...[...allJs.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
  ...READOUT_IDS,
  ...STATIC_IDS,
]);

test("every id the app reaches for exists in the markup", () => {
  const missing = [...looked].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], "the app looks up ids that are not in index.html");
  assert.ok(looked.size > 25, `only found ${looked.size} lookups — did the regex rot?`);
});

test("every id in the markup is actually used", () => {
  // Unused ids are usually the residue of a half-finished rename. Note this
  // forbids CSS-only and aria-only ids by design; if one is ever needed,
  // exempt it here explicitly rather than loosening the check.
  const orphans = [...htmlIds].filter((id) => !looked.has(id));
  assert.deepEqual(orphans, [], "index.html declares ids the app never reads");
});

test("every module imports only modules that exist", async () => {
  assert.ok(moduleNames.length >= 8, `only ${moduleNames.length} modules — layout changed?`);
  for (const [name, src] of Object.entries(sources)) {
    for (const spec of [...src.matchAll(/from "(\.\/[^"]+)"/g)].map((m) => m[1])) {
      const mod = await import(new URL(spec, new URL(`../${name}`, import.meta.url)));
      assert.ok(mod, `${name} imports ${spec}, which failed to load`);
    }
  }
});

test("the markup wires the module entry point and stylesheet", () => {
  assert.match(html, /<script type="module" src="\.\/app\.js">/);
  assert.match(html, /<link rel="stylesheet" href="\.\/style\.css" \/>/);
  assert.match(html, /<canvas id="stage"/);
  assert.match(html, /<canvas id="chart"/);
});

test("select options match the keys the modules actually accept", async () => {
  const { FIELD_KEYS, PALETTE_KEYS } = await import("../color.js");
  const { BLEND_KEYS } = await import("../pen.js");
  const { MODES } = await import("../director.js");

  const optionsOf = (selectId) => {
    const block = html.match(
      new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`),
    );
    assert.ok(block, `no <select id="${selectId}"> in the markup`);
    return [...block[1].matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  };

  assert.deepEqual(optionsOf("c-field").sort(), [...FIELD_KEYS].sort());
  assert.deepEqual(optionsOf("c-palette").sort(), [...PALETTE_KEYS].sort());
  assert.deepEqual(optionsOf("c-blend").sort(), [...BLEND_KEYS].sort());
  assert.deepEqual(optionsOf("c-mode").sort(), [...MODES].sort());
});

test("the in-app notes credit Lorenz and Gleick, and only those two", () => {
  // The transparency section is a stated requirement, not decoration. The
  // credits were deliberately cut from seven names to two — see the ledger,
  // R16. Both halves are pinned: the two that must stay, and the five that
  // must not creep back in as a "helpful" restoration.
  for (const name of ["Lorenz", "Gleick"]) {
    assert.ok(html.includes(name), `in-app notes no longer credit ${name}`);
  }
  for (const name of ["Saltzman", "Merilees", "Benettin", "Tucker", "Ottosson"]) {
    assert.ok(
      !html.includes(name),
      `${name} is back in the copy — the credits were cut to two on purpose`,
    );
  }
  const panels = [...html.matchAll(/<summary>/g)].length;
  assert.ok(panels >= 6, `expected the six notes panels, found ${panels}`);
});

test("the fact-checked claims stay fact-checked", () => {
  // Match against whitespace-collapsed text: the formatter reflows prose, so a
  // phrase can straddle a line break without anything having changed.
  const flat = html.replace(/\s+/g, " ");
  // Every one of these was WRONG or OVERSTATED in the first draft and was
  // corrected against primary sources. They are the claims most likely to
  // drift back toward the popular retelling, so they are pinned here.
  // The historical narrative was cut to a bare citation (ledger R25), so most
  // of the earlier corrections no longer have copy to live in. What remains is
  // the citation itself and a handful of numbers — all verified, all easy to
  // get subtly wrong, all pinned.
  const mustSay = [
    // The citation, exactly. Journal, volume, year, pages.
    "Journal of the Atmospheric Sciences",
    "(1963), 130–141",
    "Viking, 1987",
    // "The Butterfly Effect" is the OPENING chapter of Chaos, not chapter 2.
    "opening chapter",
    // Ottosson claims orthogonality, not uniformity; the W3C spec hedges too.
    "designed to be perceptually",
    // Correct threshold. Most retellings reach for 24.74 (where the equilibria
    // lose stability); below 24.06 is where trajectories actually settle.
    "ρ = 24.06",
    // Both follow from the verified λ ≈ 0.905 and the classic parameters.
    "ln(10)/λ ≈ 2.54",
    "−13.667",
  ];
  for (const claim of mustSay) {
    assert.ok(flat.includes(claim), `fact-checked wording lost: "${claim}"`);
  }

  const mustNotSay = [
    // Each of these was in the first draft and each was wrong.
    "one multiplication per second",
    "one multiplication a second",
    "chapter 2",
    "far smaller than any real instrument",
    "seagull",
    "24.74", // right number, wrong claim — the settling threshold is 24.06
  ];
  for (const claim of mustNotSay) {
    assert.ok(!flat.includes(claim), `a corrected error came back: "${claim}"`);
  }
});

test("the notes quote the constants the code actually uses", async () => {
  const { DT } = await import("../lorenz.js");
  const { SPEED_LIMITS, TRAIL_LIMITS } = await import("../director.js");
  assert.ok(html.includes(`dt = ${DT}`), "the notes quote a stale integration step");
  assert.ok(
    html.includes(`${SPEED_LIMITS.min} to ${SPEED_LIMITS.max}`),
    "the notes quote a stale speed range",
  );
  assert.ok(
    html.includes(`${TRAIL_LIMITS.min} to ${TRAIL_LIMITS.max}`) ||
      html.includes(`${TRAIL_LIMITS.min} – ${TRAIL_LIMITS.max}`),
    "the notes quote a stale trail range",
  );
});

test("the markup's defaults agree with the app's initial state", () => {
  // These are declared twice — once as `selected`/`checked`/`value` in the
  // markup, once in the `S` literal — and nothing forced them to agree. A
  // mutation audit of this app found that swapping a handler's target key
  // passes a fully green suite, so duplicated-and-unpinned defaults are
  // exactly the shape of bug that survives here.
  const block = allJs.match(/const S = \{[\s\S]*?\n\};/);
  assert.ok(block, "could not find the S literal — did the state move?");
  const stateOf = (key) => {
    const m = block[0].match(new RegExp(`\\n  ${key}: ("?)([^,"]+)\\1,`));
    assert.ok(m, `no initial state for ${key}`);
    return m[2];
  };

  const selectedOption = (selectId) => {
    const sel = html.match(
      new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`),
    );
    assert.ok(sel, `no <select id="${selectId}">`);
    const marked = [...sel[1].matchAll(/value="([^"]+)"[^>]*\sselected/g)].map((m) => m[1]);
    assert.equal(marked.length, 1, `${selectId} should mark exactly one option selected`);
    return marked[0];
  };

  assert.equal(selectedOption("c-field"), stateOf("field"), "color field default");
  assert.equal(selectedOption("c-palette"), stateOf("palette"), "palette default");
  assert.equal(selectedOption("c-blend"), stateOf("blend"), "blend default");
  assert.equal(selectedOption("c-mode"), stateOf("mode"), "director mode default");

  const isChecked = (id) =>
    new RegExp(`<input id="${id}"[^>]*\\schecked`).test(html.replace(/\s+/g, " "));
  assert.equal(isChecked("c-twin"), stateOf("showTwin") === "true", "draw-twin default");
  assert.equal(isChecked("c-refork"), stateOf("refork") === "true", "re-fork default");

  const rangeValue = (id) => {
    const m = html.replace(/\s+/g, " ").match(new RegExp(`<input id="${id}"[^>]*value="([^"]+)"`));
    assert.ok(m, `no value= on #${id}`);
    return m[1];
  };
  assert.equal(Number(rangeValue("c-period")), Number(stateOf("period")), "tour period");
  assert.equal(Number(rangeValue("c-yaw")), Number(stateOf("yaw")), "yaw default");
});
