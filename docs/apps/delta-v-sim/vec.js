// vec.js — 2D vector + angle primitives. Zero dependencies; the shared math
// leaf every other pure module builds on. Vectors are [x, y].

export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const scale = (a, s) => [a[0] * s, a[1] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const mag = (a) => Math.hypot(a[0], a[1]);
// scalar cross (z of a×b) — signed area / angular-momentum sign in 2D.
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
// rotate vector by angle φ (radians, CCW).
export function rot(a, phi) {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
}
// wrap an angle into (-π, π].
export function wrapPi(x) {
  let a = x % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}
