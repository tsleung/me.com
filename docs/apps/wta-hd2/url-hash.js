// Compact URL-hash codec for sharing a wta-hd2 config.
// Format: kv pairs separated by &, e.g.
//   #fac=terminids&sub=standard&enc=patrol&diff=10&strats=AC,500,EAT,EAT
//   &p=Lib&s=Sec&g=Imp&armor=Med&boost=Vit&seed=42&alpha=0.5

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
  return parts.join("&");
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
    const path = KEYS[k];
    if (!path) continue;
    let target = out;
    for (let i = 0; i < path.length - 1; i++) {
      target[path[i]] ??= {};
      target = target[path[i]];
    }
    const last = path[path.length - 1];
    if (k === "diff" || k === "seed" || k === "wc") target[last] = parseInt(v, 10);
    else if (k === "alpha" || k === "gamma" || k === "mult") target[last] = parseFloat(v);
    else if (k === "iw" || k === "pm") target[last] = v === "1" || v === "true";
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
