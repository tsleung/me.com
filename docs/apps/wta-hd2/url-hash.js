// Compact URL-hash codec for sharing a wta-hd2 config.
// Format: kv pairs separated by &, e.g.
//   #fac=terminids&sub=standard&enc=patrol&diff=10&strats=AC,500,EAT,EAT
//   &p=Lib&s=Sec&g=Imp&armor=Med&boost=Vit&seed=42&alpha=0.5

// `sub` (the active faction's subfaction) is kept for backward compatibility
// with existing share-links; new links also emit `subs` (per-faction map,
// e.g. `terminids:hunters,automatons:standard`) so the "all" view round-trips
// every lane's subfaction selection.
const KEYS = {
  fac: ["scenario", "faction"],
  sub: ["scenario", "subfaction"],
  enc: ["scenario", "encounter"],
  diff: ["scenario", "difficulty"],
  p: ["loadout", "primary"],
  s: ["loadout", "secondary"],
  g: ["loadout", "grenade"],
  armor: ["loadout", "armor"],
  boost: ["loadout", "booster"],
  alpha: ["solver", "alpha"],
  gamma: ["solver", "gamma"],
  skill: ["solver", "skill"],
  ammoc: ["solver", "ammoConservation"],
  mult: ["scenario", "spawnRateMultiplier"],
  iw: ["scenario", "infiniteWaves"],
  pm: ["scenario", "playerMovement"],
  wc: ["scenario", "waveCadenceSecs"],
  seed: ["seed"],
};

export function encodeHash(cfg) {
  const parts = [];
  for (const [k, path] of Object.entries(KEYS)) {
    const v = readPath(cfg, path);
    if (v == null) continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  if (Array.isArray(cfg.loadout?.stratagems)) {
    parts.push(`strats=${cfg.loadout.stratagems.map((s) => encodeURIComponent(s ?? "")).join(",")}`);
  }
  const subsMap = cfg.scenario?.subfactions;
  if (subsMap && typeof subsMap === "object") {
    const pairs = [];
    for (const fac of Object.keys(subsMap).sort()) {
      const v = subsMap[fac];
      if (v) pairs.push(`${fac}:${v}`);
    }
    if (pairs.length > 0) parts.push(`subs=${encodeURIComponent(pairs.join(","))}`);
  }
  const policyStr = encodePolicy(cfg.solver?.policy);
  if (policyStr) parts.push(`policy=${encodeURIComponent(policyStr)}`);
  return parts.join("&");
}

const ALLOWED_TIERS = new Set(["light", "medium", "heavy", "boss"]);

// Compact policy codec: "wid:tier1,tier2;wid2:tier3". Only deny cells are
// encoded — the absence of a (wid, tier) pair means "allow" (the default).
// Empty rows and missing weapon ids are dropped on round-trip.
export function encodePolicy(policy) {
  if (!policy) return "";
  const groups = [];
  for (const wid of Object.keys(policy).sort()) {
    const row = policy[wid];
    if (!row) continue;
    const tiers = [];
    for (const tier of ["light", "medium", "heavy", "boss"]) {
      if (row[tier] === "deny") tiers.push(tier);
    }
    if (tiers.length > 0) groups.push(`${wid}:${tiers.join(",")}`);
  }
  return groups.join(";");
}

export function decodePolicy(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  const out = {};
  for (const group of s.split(";")) {
    if (!group) continue;
    const [wid, tierList] = group.split(":");
    if (!wid || !tierList) continue;
    const row = {};
    for (const tier of tierList.split(",")) {
      if (ALLOWED_TIERS.has(tier)) row[tier] = "deny";
    }
    if (Object.keys(row).length > 0) out[wid] = row;
  }
  return Object.keys(out).length === 0 ? null : out;
}

export function decodeHash(hash, _data) {
  if (!hash) return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const out = { scenario: {}, loadout: { stratagems: [null, null, null, null] }, solver: {} };
  for (const seg of raw.split("&")) {
    const [k, vRaw] = seg.split("=");
    if (!k || vRaw == null) continue;
    const v = decodeURIComponent(vRaw);
    if (k === "strats") {
      const ids = v.split(",").map((x) => x || null);
      for (let i = 0; i < 4; i++) out.loadout.stratagems[i] = ids[i] ?? null;
      continue;
    }
    if (k === "policy") {
      const decoded = decodePolicy(v);
      if (decoded) out.solver.policy = decoded;
      continue;
    }
    if (k === "subs") {
      const map = {};
      for (const pair of v.split(",")) {
        const [fac, sub] = pair.split(":");
        if (fac && sub) map[fac] = sub;
      }
      if (Object.keys(map).length > 0) out.scenario.subfactions = map;
      continue;
    }
    const path = KEYS[k];
    if (!path) continue;
    let target = out;
    for (let i = 0; i < path.length - 1; i++) {
      target[path[i]] ??= {};
      target = target[path[i]];
    }
    const last = path[path.length - 1];
    if (k === "diff" || k === "seed" || k === "wc") target[last] = parseInt(v, 10);
    else if (k === "alpha" || k === "gamma" || k === "skill" || k === "mult") target[last] = parseFloat(v);
    else if (k === "iw" || k === "pm" || k === "ammoc") target[last] = v === "1" || v === "true";
    else target[last] = v;
  }
  return out;
}

function readPath(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}
