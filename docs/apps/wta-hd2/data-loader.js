// data-loader.js — fetches + normalizes + validates the wta-hd2 DataBundle.
//
// Two entry points share a single normalize+validate core:
//   loadData(baseUrl?, opts?)   — browser, fetch-based, parallel
//   loadDataSync(rootDir, opts?) — Node, fs-based, dynamic-imported so
//                                  this file still parses in the browser
//
// Normalization rules (the M1 stub files use wrapper shapes that the
// architecture-target bundle does not):
//   weapons.json:    {primaries, secondaries, grenades}    → kept as-is
//   stratagems.json: {stratagems: [...]}                   → unwrap to array
//   armor.json:      {passives:   [...]}                   → unwrap to array
//   boosters.json:   {boosters:   [...]}                   → unwrap to array
//   meta-level keys starting with "_" (e.g. _stub, _note)  → stripped
//
// Validation policy:
//   - non-stub data: any per-item validation error → loader rejection
//     (AggregateError) with the file path prefixed.
//   - stub data (meta.stub === true): per-item errors are downgraded to
//     warnings via opts.onWarn, because M1 stub files intentionally omit
//     fields the M2 build script will populate.
//
// Required files: meta, factions, weapons, stratagems, armor, boosters.
// Optional files: enemies, spawn-tables — missing → empty array + warn.

import {
  validateEnemy,
  validateWeapon,
  validateStratagem,
  validateEncounter,
  validateArmor,
  validateBooster,
} from "./data-schema.js";

const REQUIRED_FILES = ["meta", "factions", "weapons", "stratagems", "armor", "boosters"];
const OPTIONAL_FILES = ["enemies", "spawn-tables", "presets"];

export async function loadData(baseUrl = "./data", opts = {}) {
  const all = [...REQUIRED_FILES, ...OPTIONAL_FILES];
  const results = await Promise.all(all.map(async (name) => {
    const url = `${baseUrl}/${name}.json`;
    try {
      // Cache-bust with a timestamp param to defeat stale browser cache.
      // "no-store" forbids any caching. Combined, ensures real refresh.
      const cacheBustUrl = `${url}?v=${Date.now()}`;
      const res = await fetch(cacheBustUrl, { cache: "no-store" });
      if (!res.ok) {
        if (OPTIONAL_FILES.includes(name)) return { name, missing: true, url };
        return { name, error: new Error(`${url}: HTTP ${res.status}`) };
      }
      return { name, raw: await res.json(), url };
    } catch (err) {
      if (OPTIONAL_FILES.includes(name) && isMissingError(err)) return { name, missing: true, url };
      return { name, error: wrapErr(url, err) };
    }
  }));
  return assemble(results, opts);
}

export async function loadDataSync(rootDir, opts = {}) {
  if (typeof process === "undefined") {
    throw new Error("loadDataSync is Node-only — use loadData() in the browser");
  }
  const fs = await import("node:fs");
  const path = await import("node:path");
  const all = [...REQUIRED_FILES, ...OPTIONAL_FILES];
  const results = all.map((name) => {
    const url = path.join(rootDir, `${name}.json`);
    try {
      const text = fs.readFileSync(url, "utf8");
      return { name, raw: JSON.parse(text), url };
    } catch (err) {
      if (OPTIONAL_FILES.includes(name) && err && err.code === "ENOENT") {
        return { name, missing: true, url };
      }
      return { name, error: wrapErr(url, err) };
    }
  });
  return assemble(results, opts);
}

// ---------------------------------------------------------------------------

function assemble(results, opts) {
  const errors = [];
  const byName = {};
  const urlByName = {};
  for (const r of results) {
    urlByName[r.name] = r.url;
    if (r.error) {
      errors.push(r.error);
      continue;
    }
    if (r.missing) {
      opts.onWarn?.(`${r.url}: optional file missing — defaulting to []`);
      byName[r.name] = OPTIONAL_FILES.includes(r.name) ? [] : null;
      continue;
    }
    byName[r.name] = stripUnderscoreKeys(r.raw);
  }
  if (errors.length > 0) throw aggregate(errors, "data-loader: failed to load required files");

  const meta = byName.meta ?? {};
  const isStub = meta.stub === true;

  const bundle = {
    meta,
    factions: byName.factions ?? {},
    enemies: asArray(byName.enemies, "enemies"),
    weapons: normalizeWeapons(byName.weapons),
    stratagems: unwrapArray(byName.stratagems, "stratagems"),
    armor: unwrapArray(byName.armor, "passives"),
    boosters: unwrapArray(byName.boosters, "boosters"),
    spawnTables: asArray(byName["spawn-tables"], "spawn-tables"),
    presets: unwrapArray(byName.presets, "presets"),
  };

  const validationErrors = [];
  validateList(bundle.enemies, validateEnemy, urlByName.enemies ?? "enemies.json", validationErrors);
  validateList(bundle.weapons.primaries, validateWeapon, `${urlByName.weapons ?? "weapons.json"}#primaries`, validationErrors);
  validateList(bundle.weapons.secondaries, validateWeapon, `${urlByName.weapons ?? "weapons.json"}#secondaries`, validationErrors);
  validateList(bundle.weapons.grenades, validateWeapon, `${urlByName.weapons ?? "weapons.json"}#grenades`, validationErrors);
  validateList(bundle.stratagems, validateStratagem, urlByName.stratagems ?? "stratagems.json", validationErrors);
  validateList(bundle.armor, validateArmor, urlByName.armor ?? "armor.json", validationErrors);
  validateList(bundle.boosters, validateBooster, urlByName.boosters ?? "boosters.json", validationErrors);
  validateList(bundle.spawnTables, validateEncounter, urlByName["spawn-tables"] ?? "spawn-tables.json", validationErrors);

  if (validationErrors.length > 0) {
    if (isStub) {
      for (const e of validationErrors) opts.onWarn?.(`stub data: ${e.message}`);
    } else {
      throw aggregate(validationErrors, "data-loader: validation failed");
    }
  }
  return bundle;
}

function stripUnderscoreKeys(v) {
  if (!isPlainObject(v)) return v;
  const out = {};
  for (const k of Object.keys(v)) {
    if (k.startsWith("_")) continue;
    out[k] = v[k];
  }
  return out;
}

function unwrapArray(v, innerKey) {
  if (Array.isArray(v)) return v;
  if (isPlainObject(v) && Array.isArray(v[innerKey])) return v[innerKey];
  return [];
}

function asArray(v, _label) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [];
}

function normalizeWeapons(v) {
  if (!isPlainObject(v)) return { primaries: [], secondaries: [], grenades: [] };
  return {
    primaries: Array.isArray(v.primaries) ? v.primaries : [],
    secondaries: Array.isArray(v.secondaries) ? v.secondaries : [],
    grenades: Array.isArray(v.grenades) ? v.grenades : [],
  };
}

function validateList(items, validator, label, errors) {
  if (!Array.isArray(items)) return;
  items.forEach((item, i) => {
    const r = validator(item);
    if (!r.ok) {
      const id = isPlainObject(item) && typeof item.id === "string" ? item.id : "?";
      for (const msg of r.errors) errors.push(new Error(`${label}[${i}](${id}): ${msg}`));
    }
  });
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isMissingError(err) {
  if (!err) return false;
  const msg = String(err.message ?? "");
  return msg.includes("404") || msg.includes("ENOENT") || err.code === "ENOENT";
}

function wrapErr(url, err) {
  const msg = err && err.message ? err.message : String(err);
  return new Error(`${url}: ${msg}`);
}

// AggregateError is in modern Node + browsers; fall back to a plain Error
// whose message lists every cause if for some reason it isn't.
function aggregate(errors, header) {
  if (typeof AggregateError === "function") return new AggregateError(errors, header);
  const e = new Error(`${header}: ${errors.map((x) => x.message).join("; ")}`);
  e.errors = errors;
  return e;
}
