// Pure helper math for render-battlefield.js. No DOM, no canvas.
// Extracted so the math is testable without jsdom/puppeteer.

// World is in meters. Player at world (0, 0) sits near screen bottom-center.
// Forward (+y in world) goes UP on the screen (subtract y), so the wave
// approaches from the top of the canvas.
// Lateral (+x in world) goes RIGHT on the screen.
// Scale (px/m) is sized so ~80m of forward range fills H minus the bottom
// gutter, with lateral ±40m fitting inside W.

export const PLAYER_BOTTOM_GUTTER_PX = 80;
export const FORWARD_RANGE_M = 80;
export const LATERAL_RANGE_M = 40;

export function pixelsPerMeter(W, H) {
  const usableH = Math.max(1, H - PLAYER_BOTTOM_GUTTER_PX);
  const yScale = usableH / FORWARD_RANGE_M;
  const xScale = (W / 2) / LATERAL_RANGE_M;
  // Use the smaller axis so neither dimension overflows on odd aspect ratios.
  return Math.min(yScale, xScale);
}

export function worldToScreen(p, dims) {
  const { W, H } = dims;
  const ppm = pixelsPerMeter(W, H);
  const sx = W / 2 + (p.x ?? 0) * ppm;
  const sy = (H - PLAYER_BOTTOM_GUTTER_PX) - (p.y ?? 0) * ppm;
  return { sx, sy };
}

const TIER_RADIUS_PX = {
  light: 2,
  medium: 4,
  heavy: 6,
  boss: 10,
};

export function radiusByTier(tier) {
  return TIER_RADIUS_PX[tier] ?? 3;
}

const FACTION_COLOR = {
  terminids: "#d97a2c",
  automatons: "#c0413f",
  illuminate: "#6db5ff",
};

export function colorByFaction(faction) {
  return FACTION_COLOR[faction] ?? "#b08060";
}

// Tier influences brightness: bigger threats render slightly brighter.
const TIER_TINT = {
  light: "#a0a0a4",
  medium: "#cfa060",
  heavy: "#e07050",
  boss: "#ff5050",
};

export function colorByTier(tier) {
  return TIER_TINT[tier] ?? "#888888";
}

const SLOT_COLOR = {
  primary: "#ffffff",
  secondary: "#aad4ff",
  grenade: "#ffe14a",
  "strat-1": "#ff3a3a",
  "strat-2": "#ffb13a",
  "strat-3": "#3affc8",
  "strat-4": "#ff3aff",
  // alias forms used in some weapon-id schemes
  slot1: "#ff3a3a",
  slot2: "#ffb13a",
  slot3: "#3affc8",
  slot4: "#ff3aff",
};

export function colorBySlot(slot) {
  return SLOT_COLOR[slot] ?? "#9a9a9a";
}

// Weapon family — drives tracer/impact visual style. Derived from defId so
// e.g. blitzer reads as arc, sickle as laser, scorcher as plasma. Falls back
// to "bullet" for kinetic weapons without a recognizable family token.
export function weaponFamily(defId, slot) {
  const id = String(defId || slot || "").toLowerCase();
  if (/blitzer|(^|[-_])arc([-_]|$)|tesla/.test(id)) return "arc";
  if (/sickle|scythe|dagger|(^|[-_])las([-_]|$)|laser|quasar/.test(id)) return "laser";
  if (/scorcher|purifier|(^|[-_])plas/.test(id)) return "plasma";
  if (/crisper|incendiary|flame|napalm|torcher/.test(id)) return "flame";
  if (/eruptor|crossbow|grenade-pistol|ultimatum|frag|impact|thermite|high-explosive|recoilless|spear|(^|[-_])eat([-_]|$)|autocannon|hmg|rocket|mortar/.test(id)) return "explosive";
  return "bullet";
}

// Visual style per family. Tuned for low-fidelity readability at glance.
const FAMILY_STYLE = {
  bullet:    { color: "rgba(255, 240, 196, 0.95)", lineWidth: 1.2, dotR: 2.2, kind: "line" },
  laser:     { color: "rgba(255, 70, 70, 0.95)",   lineWidth: 2.0, dotR: 2.6, kind: "line" },
  arc:       { color: "rgba(180, 220, 255, 0.95)", lineWidth: 1.4, dotR: 0,   kind: "zigzag" },
  plasma:    { color: "rgba(120, 240, 220, 0.95)", lineWidth: 1.8, dotR: 3.0, kind: "line" },
  flame:     { color: "rgba(255, 150, 60, 0.85)",  lineWidth: 2.4, dotR: 0,   kind: "line" },
  explosive: { color: "rgba(255, 200, 80, 0.95)",  lineWidth: 1.5, dotR: 3.0, kind: "line" },
};

export function familyStyle(family) {
  return FAMILY_STYLE[family] ?? FAMILY_STYLE.bullet;
}

export function hpBarWidth(currentHp, hpMax, maxWidthPx) {
  if (!Number.isFinite(currentHp) || !Number.isFinite(hpMax) || hpMax <= 0) return 0;
  const pct = Math.max(0, Math.min(1, currentHp / hpMax));
  return pct * maxWidthPx;
}

// Forward arc cone wedge math. Cone is symmetric around +y axis.
// Returns the two endpoint screen coords, given the cone half-angle.
export function arcWedgePoints(dims, halfAngleRad, rangeM) {
  const { W, H } = dims;
  const ppm = pixelsPerMeter(W, H);
  const cx = W / 2;
  const cy = H - PLAYER_BOTTOM_GUTTER_PX;
  const r = rangeM * ppm;
  // World +y is screen up; angle measured from +y axis.
  const leftX = cx - Math.sin(halfAngleRad) * r;
  const rightX = cx + Math.sin(halfAngleRad) * r;
  const topY = cy - Math.cos(halfAngleRad) * r;
  return { cx, cy, leftX, rightX, topY };
}

// ---- Glyphs (per archetype visual distinction) ----

export const GLYPHS = ["wedge", "tri", "hex", "bar", "ring", "star"];

// Path a glyph centred at (sx, sy) with size r (px). Caller does fill/stroke.
// Glyphs are SHAPES, not sprites — six choices keep the renderer batched
// and force the data author to think about visual distinction.
export function drawGlyphPath(ctx, glyph, sx, sy, r) {
  ctx.beginPath();
  switch (glyph) {
    case "wedge": {
      // Inverted small triangle (▽)
      ctx.moveTo(sx,        sy + r * 0.9);
      ctx.lineTo(sx - r,    sy - r * 0.6);
      ctx.lineTo(sx + r,    sy - r * 0.6);
      ctx.closePath();
      return;
    }
    case "tri": {
      // Sharper upright triangle (△)
      ctx.moveTo(sx,        sy - r * 1.0);
      ctx.lineTo(sx - r * 0.85, sy + r * 0.7);
      ctx.lineTo(sx + r * 0.85, sy + r * 0.7);
      ctx.closePath();
      return;
    }
    case "hex": {
      // Regular hexagon
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const px = sx + Math.cos(a) * r;
        const py = sy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      return;
    }
    case "bar": {
      // Fat horizontal bar
      ctx.rect(sx - r * 1.1, sy - r * 0.55, r * 2.2, r * 1.1);
      return;
    }
    case "ring": {
      // Circle (caller can stroke for armored look)
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      return;
    }
    case "star": {
      // 5-point star, boss-only
      const outer = r * 1.1;
      const inner = r * 0.45;
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const radius = (i % 2 === 0) ? outer : inner;
        const px = sx + Math.cos(a) * radius;
        const py = sy + Math.sin(a) * radius;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      return;
    }
    default: {
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      return;
    }
  }
}

// Mix the faction base colour with a per-archetype hue/lightness shift.
// paletteShift in [-1, +1]: negative = darker/cooler, positive = lighter/warmer.
export function paletteForArchetype(faction, archetype) {
  const base = colorByFaction(faction);
  const shift = (archetype && typeof archetype.paletteShift === "number")
    ? archetype.paletteShift : 0;
  if (shift === 0) return base;
  return mixColor(base, shift);
}

function mixColor(hex, shift) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  // Simple lightness shift: positive lightens toward white, negative darkens.
  const t = Math.max(-1, Math.min(1, shift));
  const dr = t > 0 ? r + (255 - r) * t : r * (1 + t);
  const dg = t > 0 ? g + (255 - g) * t : g * (1 + t);
  const db = t > 0 ? b + (255 - b) * t : b * (1 + t);
  const toHex = (n) => {
    const v = Math.max(0, Math.min(255, Math.round(n)));
    return v.toString(16).padStart(2, "0");
  };
  return `#${toHex(dr)}${toHex(dg)}${toHex(db)}`;
}
