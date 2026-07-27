import test from "node:test";
import assert from "node:assert/strict";

import { markerLegend } from "../image.js";

// The legend is the text half of the marker mechanism; burnMarkers draws the
// number half. They agree only because both derive the label the same way —
// `String(marker.label ?? index + 1)`. If they ever diverge the model is told
// about "marker 3" while the pixels say 4, and the reading silently describes
// the wrong part of the screen. burnMarkers needs a canvas so it cannot be
// tested here; this pins the rule on the side that can be.

test("no markers means no legend at all", () => {
  assert.equal(markerLegend(), "");
  assert.equal(markerLegend([]), "");
});

test("a non-array is treated as no markers, not as a crash", () => {
  assert.equal(markerLegend("nope"), "");
  assert.equal(markerLegend(null), "");
  assert.equal(markerLegend({ label: 1 }), "");
});

test("labels default to the 1-based index, matching what burnMarkers draws", () => {
  const legend = markerLegend([{ text: "the left dial" }, { text: "the readout" }]);
  assert.equal(legend, "1) the left dial\n2) the readout");
});

test("an explicit label wins over the index, on both sides of the mechanism", () => {
  // app.js renumbers markers on add/remove, so labels normally equal index+1;
  // a stored shot from before a renumber can carry its own.
  assert.equal(markerLegend([{ label: 7, text: "z" }]), "7) z");
});

test("a marker with no note still gets a line, so the numbering never shifts", () => {
  // Dropping the empty one would renumber every marker after it relative to
  // the burned-in circles.
  assert.equal(
    markerLegend([{ text: "a" }, { text: "   " }, {}, { text: "d" }]),
    "1) a\n2) (no note)\n3) (no note)\n4) d",
  );
});

test("notes are trimmed but otherwise verbatim", () => {
  assert.equal(markerLegend([{ text: "  count the bars  " }]), "1) count the bars");
});

test("a non-string note is coerced rather than dropped", () => {
  assert.equal(markerLegend([{ text: 3 }]), "1) 3");
  assert.equal(markerLegend([{ text: null }]), "1) (no note)");
});
