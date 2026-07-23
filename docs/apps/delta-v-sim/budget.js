// budget.js — the SINGLE SOURCE OF TRUTH for a course's Δv accounting + craft
// feasibility. Pure/DOM-free. Both the mission feasibility (mission.js) and the
// propellant mass ratios (plan.js) derive from ONE model here, so they cannot
// drift apart again — the drift they HAD (mass-ratio credited refuel-in-orbit,
// feasibility didn't) was the bug this module exists to prevent.
//
// The refuel model (a documented toy-model simplification, shared with plan.js):
//   refuel-in-orbit ON  → the craft tanks up at each orbit-stop, so it only ever
//     carries ONE leg's Δv at a time ⇒ the binding Δv is the WORST single leg
//     (max), and the propellant mass ratio is that leg's ratio.
//   refuel-in-orbit OFF → the craft carries all propellant from the start ⇒ Δv is
//     the SUM of every leg, and the mass ratio COMPOUNDS (e^Σ, the carry-all tax).
// SIMPLIFICATIONS (true of the mass-ratio too, called out so they don't surprise):
//   • Each leg is treated as its own refuel segment. A FLYBY waypoint can't
//     physically refuel (the craft doesn't stop), so a real flyby segment spans
//     legs; the toy model refuels per-leg regardless. Fine while courses are
//     orbit-stops; revisit if flyby chains become load-bearing.
//   • Feasibility's per-leg Δv INCLUDES surface→orbit (launchCost) — the craft
//     must produce it if it launches itself (chemical-from-surface). The mass
//     ratio EXCLUDES it (surface→LEO is shown as a separate launch-vehicle line).
//     So `perLegTotal` (feasibility) and `perLegInSpace` (mass ratio) differ by
//     launchCost — deliberately, and both are returned.

export const G0 = 9.80665e-3; // km/s²

// Δv a full tank delivers, from the rocket equation: Isp·g0·ln(1/(1−propFraction)).
// Guards junk (isp≤0, propFraction∉(0,1)) → 0 (an infeasible craft, never a throw).
export function craftBudget(isp, propFraction) {
  if (!(isp > 0) || !(propFraction > 0) || propFraction >= 1) return 0;
  return isp * G0 * Math.log(1 / (1 - propFraction));
}

// The in-space Δv the craft produces on a leg (heliocentric transfer + capture) —
// surface→orbit is separate (see legTotalDv).
export function legInSpaceDv(leg) {
  return (leg.transferDv || 0) + (leg.captureDv || 0);
}
// The TOTAL Δv the craft produces on a leg, from the tank it departs that leg with:
// surface→orbit (after infra; leg 0 typically) + in-space.
export function legTotalDv(leg) {
  return (leg.launchCost || 0) + legInSpaceDv(leg);
}

// courseDvAccounting — the one function both plan.js + mission.js call.
//   legs: [{ transferDv, captureDv, launchCost? }]  (launchCost defaults 0)
//   refuelInOrbit: bool · budget: craft Δv budget (km/s) · ve: exhaust velocity
// Returns the full accounting; callers read the fields they need (plan.js the mass
// ratios, mission.js the feasibility) — computed from ONE per-leg breakdown.
export function courseDvAccounting({ legs = [], refuelInOrbit = true, budget = 0, ve = 3.5 }) {
  const perLegInSpace = legs.map(legInSpaceDv);
  const perLegTotal = legs.map(legTotalDv);
  const inSpaceDv = perLegInSpace.reduce((a, b) => a + b, 0);
  const launchCost = legs.reduce((s, l) => s + (l.launchCost || 0), 0);
  const sumTotal = inSpaceDv + launchCost; // = Σ perLegTotal
  const maxLegTotal = perLegTotal.length ? Math.max(...perLegTotal) : 0;

  // FEASIBILITY (the fix): refuel ⇒ the worst single leg must fit the tank;
  // no-refuel ⇒ the whole course must fit one tank.
  const requiredDv = refuelInOrbit ? maxLegTotal : sumTotal;
  const feasible = budget >= requiredDv;
  // where the tank runs dry — the FIRST leg the craft can't afford:
  //   refuel  → the first leg whose OWN Δv exceeds budget (each leg from a full tank)
  //   no-refuel → the first leg where the CUMULATIVE Δv exceeds budget (one tank)
  let runsDryLeg = -1;
  if (refuelInOrbit) {
    runsDryLeg = perLegTotal.findIndex((dv) => dv > budget);
  } else {
    let cum = 0;
    for (let i = 0; i < perLegTotal.length; i++) {
      cum += perLegTotal[i];
      if (cum > budget) {
        runsDryLeg = i;
        break;
      }
    }
  }

  // PROPELLANT MASS RATIOS (rocket equation), IN-SPACE per-leg (surface→orbit is a
  // separate launch line) — same refuel model, so feasibility + mass ratio agree.
  const massRatioRefuelOff = perLegInSpace.length ? Math.exp(inSpaceDv / ve) : 1;
  const massRatioRefuelOn = perLegInSpace.length
    ? Math.max(...perLegInSpace.map((dv) => Math.exp(dv / ve)))
    : 1;

  return {
    perLegInSpace,
    perLegTotal,
    inSpaceDv,
    launchCost,
    sumTotal,
    maxLegTotal,
    requiredDv,
    feasible,
    runsDryLeg,
    massRatioRefuelOn,
    massRatioRefuelOff,
  };
}
