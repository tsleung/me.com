// data-schema.js — pure type shapes + total validators for the wta-hd2 data layer.
//
// Validators NEVER throw. They return { ok, errors } so the build script can
// surface every problem in a dataset in a single pass instead of dying on the
// first one.
//
// JSDoc typedefs below mirror the design-target shapes in
// notes/wta-hd2/architecture.md (§ data-schema.js).

/**
 * @typedef {"terminids" | "automatons" | "illuminate"} Faction
 * @typedef {"light" | "medium" | "heavy" | "boss"} ThreatTier
 * @typedef {"primary" | "secondary" | "grenade" | "support"} WeaponSlot
 * @typedef {"orbital" | "eagle" | "sentry" | "support" | "backpack" | "emplacement"} StratagemType
 * @typedef {"patrol" | "breach" | "drop"} EncounterType
 *
 * @typedef {Object} EnemyPart
 * @property {string} name
 * @property {number} ac                      armor class, 1-9
 * @property {number} hpFraction              share of total hp, sum across parts ~ 1.0
 * @property {boolean} isWeakPoint
 * @property {number} weakPointMultiplier     1.0 if not weak point
 *
 * @typedef {Object} Enemy
 * @property {string} id
 * @property {string} name
 * @property {Faction} faction
 * @property {string[]} subfactionTags
 * @property {ThreatTier} threatTier
 * @property {number} hp
 * @property {EnemyPart[]} parts
 * @property {number} speedMps
 * @property {number} attackRangeM
 * @property {number} meleeDps
 * @property {number} rangedDps
 *
 * @typedef {Object} Weapon
 * @property {string} id
 * @property {string} name
 * @property {WeaponSlot} slot
 * @property {number} damage
 * @property {number} durableDamage
 * @property {number} armorPen                1-9
 * @property {number} fireRateRpm
 * @property {number} magazine
 * @property {number} reloadSecs
 * @property {number} ammoReserve
 * @property {number} aoeRadiusM              0 if not AoE
 * @property {number} falloffStartM
 * @property {number} maxRangeM
 * @property {number} weakPointHitRateBase    0..1
 * @property {string} ammoType
 *
 * @typedef {Object} StratagemEffect
 * @property {"damage" | "spawn-weapon" | "dot"} kind
 * @property {number} [damage]
 * @property {number} [ap]
 * @property {number} [aoeRadiusM]
 * @property {number} [durationSecs]
 * @property {number} [tickRate]
 * @property {string} [weaponId]
 *
 * @typedef {Object} Stratagem
 * @property {string} id
 * @property {string} name
 * @property {StratagemType} type
 * @property {number} callInSecs
 * @property {number} cooldownSecs
 * @property {number | null} uses             null = no per-mission cap
 * @property {StratagemEffect[]} effects
 *
 * @typedef {Object} EncounterCount
 * @property {"fixed" | "poisson"} dist
 * @property {number} mean
 * @property {number} [max]
 *
 * @typedef {Object} EncounterSpawnArc
 * @property {number} minDeg
 * @property {number} maxDeg
 * @property {number} distanceM
 *
 * @typedef {Object} EncounterCompositionEntry
 * @property {string} enemyId
 * @property {EncounterCount} count
 * @property {number} spawnTimeSecs
 * @property {EncounterSpawnArc} spawnArc
 *
 * @typedef {Object} Encounter
 * @property {string} faction
 * @property {string} subfaction
 * @property {EncounterType} type
 * @property {number} difficulty              1-10
 * @property {EncounterCompositionEntry[]} composition
 * @property {number} maxConcurrent
 *
 * @typedef {Object} Armor
 * @property {string} id
 * @property {string} name
 * @property {string} effect
 *
 * @typedef {Object} Booster
 * @property {string} id
 * @property {string} name
 * @property {string} effect
 *
 * @typedef {Object} DataBundle
 * @property {object} meta
 * @property {Object<string, {name: string, subfactions: Array<{id: string, name: string}>}>} factions
 * @property {Enemy[]} enemies
 * @property {{primaries: Weapon[], secondaries: Weapon[], grenades: Weapon[]}} weapons
 * @property {Stratagem[]} stratagems
 * @property {Armor[]} armor
 * @property {Booster[]} boosters
 * @property {Encounter[]} spawnTables
 *
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {string[]} errors
 */

export const FACTIONS = ["terminids", "automatons", "illuminate"];
export const THREAT_TIERS = ["light", "medium", "heavy", "boss"];
export const WEAPON_SLOTS = ["primary", "secondary", "grenade", "support"];
export const STRATAGEM_TYPES = ["orbital", "eagle", "sentry", "support", "backpack", "emplacement"];
export const ENCOUNTER_TYPES = ["patrol", "breach", "drop"];
export const STRATAGEM_EFFECT_KINDS = ["damage", "spawn-weapon", "dot"];
export const COUNT_DISTS = ["fixed", "poisson"];

// HP-fraction sum tolerance. Floating-point noise + hand-authored data won't
// hit exactly 1.0, but anything outside ±0.01 is almost certainly a typo.
const HP_FRACTION_TOLERANCE = 0.01;

// ---------------------------------------------------------------------------
// internal helpers — all return void; they push to the supplied errors array.
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkRequired(obj, field, errors, path) {
  if (obj[field] === undefined) {
    errors.push(`${path}.${field}: missing required field`);
    return false;
  }
  return true;
}

function checkString(obj, field, errors, path, { allowEmpty = false } = {}) {
  if (!checkRequired(obj, field, errors, path)) return false;
  if (typeof obj[field] !== "string") {
    errors.push(`${path}.${field}: expected string, got ${typeof obj[field]}`);
    return false;
  }
  if (!allowEmpty && obj[field].length === 0) {
    errors.push(`${path}.${field}: must be non-empty string`);
    return false;
  }
  return true;
}

function checkNumber(obj, field, errors, path, { min, max, integer = false } = {}) {
  if (!checkRequired(obj, field, errors, path)) return false;
  const v = obj[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`${path}.${field}: expected finite number, got ${typeof v === "number" ? v : typeof v}`);
    return false;
  }
  if (integer && !Number.isInteger(v)) {
    errors.push(`${path}.${field}: expected integer, got ${v}`);
    return false;
  }
  if (min !== undefined && v < min) {
    errors.push(`${path}.${field}: ${v} < min ${min}`);
    return false;
  }
  if (max !== undefined && v > max) {
    errors.push(`${path}.${field}: ${v} > max ${max}`);
    return false;
  }
  return true;
}

function checkBool(obj, field, errors, path) {
  if (!checkRequired(obj, field, errors, path)) return false;
  if (typeof obj[field] !== "boolean") {
    errors.push(`${path}.${field}: expected boolean, got ${typeof obj[field]}`);
    return false;
  }
  return true;
}

function checkEnum(obj, field, allowed, errors, path) {
  if (!checkRequired(obj, field, errors, path)) return false;
  if (!allowed.includes(obj[field])) {
    errors.push(`${path}.${field}: ${JSON.stringify(obj[field])} not in [${allowed.join(", ")}]`);
    return false;
  }
  return true;
}

function checkArray(obj, field, errors, path, { allowEmpty = true } = {}) {
  if (!checkRequired(obj, field, errors, path)) return false;
  if (!Array.isArray(obj[field])) {
    errors.push(`${path}.${field}: expected array, got ${typeof obj[field]}`);
    return false;
  }
  if (!allowEmpty && obj[field].length === 0) {
    errors.push(`${path}.${field}: must be non-empty array`);
    return false;
  }
  return true;
}

function checkStringArray(obj, field, errors, path) {
  if (!checkArray(obj, field, errors, path)) return false;
  let ok = true;
  obj[field].forEach((v, i) => {
    if (typeof v !== "string") {
      errors.push(`${path}.${field}[${i}]: expected string, got ${typeof v}`);
      ok = false;
    }
  });
  return ok;
}

function checkObject(obj, field, errors, path) {
  if (!checkRequired(obj, field, errors, path)) return false;
  if (!isPlainObject(obj[field])) {
    errors.push(`${path}.${field}: expected object, got ${Array.isArray(obj[field]) ? "array" : typeof obj[field]}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// per-shape validators
// ---------------------------------------------------------------------------

function validateEnemyPart(part, errors, path) {
  if (!isPlainObject(part)) {
    errors.push(`${path}: expected object, got ${part === null ? "null" : Array.isArray(part) ? "array" : typeof part}`);
    return;
  }
  checkString(part, "name", errors, path);
  checkNumber(part, "ac", errors, path, { min: 1, max: 9, integer: true });
  checkNumber(part, "hpFraction", errors, path, { min: 0, max: 1 });
  checkBool(part, "isWeakPoint", errors, path);
  checkNumber(part, "weakPointMultiplier", errors, path, { min: 0 });
}

export function validateEnemy(obj) {
  const errors = [];
  const path = "enemy";
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`${path}: expected object, got ${obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj}`] };
  }
  checkString(obj, "id", errors, path);
  checkString(obj, "name", errors, path);
  checkEnum(obj, "faction", FACTIONS, errors, path);
  checkStringArray(obj, "subfactionTags", errors, path);
  checkEnum(obj, "threatTier", THREAT_TIERS, errors, path);
  checkNumber(obj, "hp", errors, path, { min: 0 });
  checkNumber(obj, "speedMps", errors, path, { min: 0 });
  checkNumber(obj, "attackRangeM", errors, path, { min: 0 });
  checkNumber(obj, "meleeDps", errors, path, { min: 0 });
  checkNumber(obj, "rangedDps", errors, path, { min: 0 });
  if (checkArray(obj, "parts", errors, path, { allowEmpty: false })) {
    obj.parts.forEach((p, i) => validateEnemyPart(p, errors, `${path}.parts[${i}]`));
    // hpFraction sum check — only meaningful if every part contributed a finite number
    const fractions = obj.parts.map((p) => (p && typeof p.hpFraction === "number" && Number.isFinite(p.hpFraction)) ? p.hpFraction : null);
    if (fractions.every((f) => f !== null)) {
      const sum = fractions.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > HP_FRACTION_TOLERANCE) {
        errors.push(`${path}.parts: hpFraction sum ${sum.toFixed(4)} outside 1.0 ± ${HP_FRACTION_TOLERANCE}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateWeapon(obj) {
  const errors = [];
  const path = "weapon";
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`${path}: expected object, got ${obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj}`] };
  }
  checkString(obj, "id", errors, path);
  checkString(obj, "name", errors, path);
  checkEnum(obj, "slot", WEAPON_SLOTS, errors, path);
  checkNumber(obj, "damage", errors, path, { min: 0 });
  checkNumber(obj, "durableDamage", errors, path, { min: 0 });
  checkNumber(obj, "armorPen", errors, path, { min: 1, max: 9, integer: true });
  checkNumber(obj, "fireRateRpm", errors, path, { min: 0 });
  checkNumber(obj, "magazine", errors, path, { min: 0, integer: true });
  checkNumber(obj, "reloadSecs", errors, path, { min: 0 });
  checkNumber(obj, "ammoReserve", errors, path, { min: 0, integer: true });
  checkNumber(obj, "aoeRadiusM", errors, path, { min: 0 });
  checkNumber(obj, "falloffStartM", errors, path, { min: 0 });
  checkNumber(obj, "maxRangeM", errors, path, { min: 0 });
  checkNumber(obj, "weakPointHitRateBase", errors, path, { min: 0, max: 1 });
  checkString(obj, "ammoType", errors, path);
  return { ok: errors.length === 0, errors };
}

function validateStratagemEffect(eff, errors, path) {
  if (!isPlainObject(eff)) {
    errors.push(`${path}: expected object, got ${eff === null ? "null" : Array.isArray(eff) ? "array" : typeof eff}`);
    return;
  }
  checkEnum(eff, "kind", STRATAGEM_EFFECT_KINDS, errors, path);
  // optional numerics — only validated if present
  for (const f of ["damage", "ap", "aoeRadiusM", "durationSecs", "tickRate"]) {
    if (eff[f] !== undefined) {
      if (typeof eff[f] !== "number" || !Number.isFinite(eff[f]) || eff[f] < 0) {
        errors.push(`${path}.${f}: expected non-negative finite number, got ${JSON.stringify(eff[f])}`);
      }
    }
  }
  if (eff.weaponId !== undefined && (typeof eff.weaponId !== "string" || eff.weaponId.length === 0)) {
    errors.push(`${path}.weaponId: expected non-empty string`);
  }
}

export function validateStratagem(obj) {
  const errors = [];
  const path = "stratagem";
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`${path}: expected object, got ${obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj}`] };
  }
  checkString(obj, "id", errors, path);
  checkString(obj, "name", errors, path);
  checkEnum(obj, "type", STRATAGEM_TYPES, errors, path);
  checkNumber(obj, "callInSecs", errors, path, { min: 0 });
  checkNumber(obj, "cooldownSecs", errors, path, { min: 0 });
  // uses: number | null. Required field but null is a valid value.
  if (!Object.prototype.hasOwnProperty.call(obj, "uses")) {
    errors.push(`${path}.uses: missing required field`);
  } else if (obj.uses !== null) {
    if (typeof obj.uses !== "number" || !Number.isInteger(obj.uses) || obj.uses < 0) {
      errors.push(`${path}.uses: expected non-negative integer or null, got ${JSON.stringify(obj.uses)}`);
    }
  }
  // effects array — required, may be empty
  if (checkArray(obj, "effects", errors, path)) {
    obj.effects.forEach((e, i) => validateStratagemEffect(e, errors, `${path}.effects[${i}]`));
  }
  return { ok: errors.length === 0, errors };
}

function validateEncounterComposition(c, errors, path) {
  if (!isPlainObject(c)) {
    errors.push(`${path}: expected object, got ${c === null ? "null" : Array.isArray(c) ? "array" : typeof c}`);
    return;
  }
  checkString(c, "enemyId", errors, path);
  checkNumber(c, "spawnTimeSecs", errors, path, { min: 0 });
  if (checkObject(c, "count", errors, path)) {
    checkEnum(c.count, "dist", COUNT_DISTS, errors, `${path}.count`);
    checkNumber(c.count, "mean", errors, `${path}.count`, { min: 0 });
    if (c.count.max !== undefined) {
      if (typeof c.count.max !== "number" || !Number.isFinite(c.count.max) || c.count.max < 0) {
        errors.push(`${path}.count.max: expected non-negative finite number`);
      }
    }
  }
  if (checkObject(c, "spawnArc", errors, path)) {
    checkNumber(c.spawnArc, "minDeg", errors, `${path}.spawnArc`);
    checkNumber(c.spawnArc, "maxDeg", errors, `${path}.spawnArc`);
    checkNumber(c.spawnArc, "distanceM", errors, `${path}.spawnArc`, { min: 0 });
  }
}

export function validateEncounter(obj) {
  const errors = [];
  const path = "encounter";
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`${path}: expected object, got ${obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj}`] };
  }
  checkString(obj, "faction", errors, path);
  checkString(obj, "subfaction", errors, path);
  checkEnum(obj, "type", ENCOUNTER_TYPES, errors, path);
  checkNumber(obj, "difficulty", errors, path, { min: 1, max: 10, integer: true });
  checkNumber(obj, "maxConcurrent", errors, path, { min: 0, integer: true });
  if (checkArray(obj, "composition", errors, path)) {
    obj.composition.forEach((c, i) => validateEncounterComposition(c, errors, `${path}.composition[${i}]`));
  }
  return { ok: errors.length === 0, errors };
}

export function validateArmor(obj) {
  const errors = [];
  const path = "armor";
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`${path}: expected object, got ${obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj}`] };
  }
  checkString(obj, "id", errors, path);
  checkString(obj, "name", errors, path);
  checkString(obj, "effect", errors, path, { allowEmpty: true });
  return { ok: errors.length === 0, errors };
}

export function validateBooster(obj) {
  const errors = [];
  const path = "booster";
  if (!isPlainObject(obj)) {
    return { ok: false, errors: [`${path}: expected object, got ${obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj}`] };
  }
  checkString(obj, "id", errors, path);
  checkString(obj, "name", errors, path);
  checkString(obj, "effect", errors, path, { allowEmpty: true });
  return { ok: errors.length === 0, errors };
}

// Run a per-item validator across an array. Errors are namespaced with
// the array path + index + (when present) item id, so a single bad enemy
// in a 200-item file is identifiable at a glance.
function validateList(items, validator, label, errors) {
  if (!Array.isArray(items)) {
    errors.push(`${label}: expected array, got ${items === null ? "null" : typeof items}`);
    return;
  }
  items.forEach((item, i) => {
    const r = validator(item);
    if (!r.ok) {
      const id = isPlainObject(item) && typeof item.id === "string" ? item.id : "?";
      for (const e of r.errors) errors.push(`${label}[${i}](${id}): ${e}`);
    }
  });
}

export function validateDataBundle(bundle) {
  const errors = [];
  if (!isPlainObject(bundle)) {
    return { ok: false, errors: [`bundle: expected object, got ${bundle === null ? "null" : Array.isArray(bundle) ? "array" : typeof bundle}`] };
  }
  if (!isPlainObject(bundle.meta)) errors.push(`bundle.meta: expected object`);
  if (!isPlainObject(bundle.factions)) errors.push(`bundle.factions: expected object`);

  validateList(bundle.enemies, validateEnemy, "bundle.enemies", errors);
  validateList(bundle.stratagems, validateStratagem, "bundle.stratagems", errors);
  validateList(bundle.armor, validateArmor, "bundle.armor", errors);
  validateList(bundle.boosters, validateBooster, "bundle.boosters", errors);
  validateList(bundle.spawnTables, validateEncounter, "bundle.spawnTables", errors);

  if (!isPlainObject(bundle.weapons)) {
    errors.push(`bundle.weapons: expected object with primaries/secondaries/grenades`);
  } else {
    validateList(bundle.weapons.primaries, validateWeapon, "bundle.weapons.primaries", errors);
    validateList(bundle.weapons.secondaries, validateWeapon, "bundle.weapons.secondaries", errors);
    validateList(bundle.weapons.grenades, validateWeapon, "bundle.weapons.grenades", errors);
  }

  return { ok: errors.length === 0, errors };
}
