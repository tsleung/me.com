// hud.js — the readouts, as strings.
//
// Pure: takes a plain view object, returns id→text maps plus the handful of
// non-text values (a gradient, three booleans). `app.js` keeps a small applier
// that writes them to the DOM, because `classList.toggle` and `.hidden` are
// effects and effects belong to the shell.
//
// This is deliberately NOT a generic declarative DOM-patch format. It is two
// functions returning records of strings. The moment it grows a mini-language
// for "set this attribute on that node" it has become a framework, and the
// reason this app has no framework is that it does not need one.
//
// `READOUT_IDS` and `STATIC_IDS` are exported as literals so `wiring.test.js`
// can pin them against the markup by importing rather than by regex-scanning
// for quoted keys — a regex over object literals over-matches and rots.

import { horizon, horizonGainPerDecade } from "./fork.js";
import { contraction } from "./lorenz.js";
import { ramp, cssRgb, FIELDS, PALETTES } from "./color.js";
import { MODE_BLURB } from "./director.js";
import { BLENDS } from "./pen.js";

/** Null, undefined and non-finite all read as an em dash, never as "NaN". */
export const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));

export const READOUT_IDS = Object.freeze([
  "r-t",
  "r-fork",
  "r-delta",
  "r-dnorm",
  "r-v",
  "r-speed",
  "r-trail",
  "r-u",
  "r-lambda-live",
  "r-expired",
]);

export const STATIC_IDS = Object.freeze([
  "r-lambda",
  "r-contract",
  "r-horizon",
  "r-decade",
  "r-eps",
  "f-blurb",
  "m-blurb",
  "b-blurb",
  "legend-label",
  "v-speed",
  "v-trail",
  "v-period",
  "v-yaw",
  "v-sigma",
  "v-rho",
  "v-beta",
]);

/**
 * The per-frame readouts.
 *
 * `expired` is the three-way one: the measured horizon for this fork once it
 * has died, the previous fork's in parentheses if this one is still alive, and
 * "still good" before anything has died at all. It reads as a live number, a
 * memory, or a promise — in that order.
 */
export function readoutText(view) {
  const { t, sinceFork, delta, dNorm, v, effSpeed, effTrail, u, lambdaLive } = view;
  return {
    "r-t": fmt(t, 1),
    "r-fork": fmt(sinceFork, 1),
    "r-delta": delta > 0 ? delta.toExponential(2) : "0",
    "r-dnorm": `${Math.round((Number.isFinite(dNorm) ? dNorm : 0) * 100)}%`,
    "r-v": fmt(v, 1),
    "r-speed": fmt(effSpeed, 2),
    "r-trail": fmt(effTrail, 2),
    "r-u": u == null ? "—" : fmt(u, 2),
    "r-lambda-live": fmt(lambdaLive, 3),
    "r-expired":
      view.expiredAt != null
        ? fmt(view.expiredAt, 1)
        : view.prevExpiredAt != null
          ? `(last: ${fmt(view.prevExpiredAt, 1)})`
          : "still good",
  };
}

/** Whether the measured-horizon readout should read as live. */
export const expiredIsLive = (view) => view.expiredAt != null;

/**
 * Everything that only changes when a control does. Returns the text map plus
 * the values `app.js` needs for the non-text writes, so that the decisions live
 * here and only the effects live there.
 */
export function staticText(view) {
  const { lambda, eps, params, field, palette, blend, mode, tolerance } = view;
  return {
    text: {
      "r-lambda": fmt(lambda, 3),
      "r-contract": fmt(contraction(params), 3),
      "r-horizon": fmt(horizon(lambda, eps, tolerance), 1),
      "r-decade": fmt(horizonGainPerDecade(lambda), 2),
      "r-eps": eps.toExponential(2),
      "f-blurb": FIELDS[field].blurb,
      "m-blurb": MODE_BLURB[mode],
      "b-blurb": BLENDS[blend].blurb,
      "legend-label": FIELDS[field].label,
      "v-speed": `${view.manualSpeed.toFixed(2)}×`,
      "v-trail": `${view.manualTrail.toFixed(1)}`,
      "v-period": `${view.period.toFixed(0)}`,
      "v-yaw": `${Math.round((view.yaw * 180) / Math.PI)}°`,
      "v-sigma": params.sigma.toFixed(1),
      "v-rho": params.rho.toFixed(1),
      "v-beta": params.beta.toFixed(3),
    },
    legendGradient: `linear-gradient(90deg, ${ramp(palette, 20).map(cssRgb).join(",")})`,
    paletteIsLoud: Boolean(PALETTES[palette].loud),
    showTourRow: mode === "tour",
    manualOverridden: mode !== "off",
  };
}
