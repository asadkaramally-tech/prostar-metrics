import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationAnchor,
  autoStride,
  axis2Ticks,
  bandLabelAnchor,
  devBarsDomain,
  heatCellStyle,
  heatReprOverlay,
  histogramLayout,
  monotonePath,
  niceTicks,
  shouldDrawXLabel,
} from "../../src/components/charts/geometry";

test("niceTicks picks steps from the {1,2,2.5,5,10} ladder and covers the domain", () => {
  const { ticks, lo, hi } = niceTicks(0, 500000, 5);
  assert.equal(lo, 0);
  assert.ok(hi >= 500000);
  const step = ticks[1] - ticks[0];
  const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)));
  assert.ok([1, 2, 2.5, 5, 10].some((c) => Math.abs(c - mantissa) < 1e-9), `step ${step} must be nice`);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(Math.abs(ticks[i] - ticks[i - 1] - step) < 1e-6, "ticks must be evenly spaced");
  }
});

test("dual-axis ticks align tick-for-tick with the primary axis", () => {
  const primary = niceTicks(0, 500000, 5);
  const { lo2, hi2, ticks2 } = axis2Ticks(87, primary.ticks.length);
  assert.equal(ticks2.length, primary.ticks.length, "secondary axis must have the same tick count");
  assert.equal(lo2, 0);
  assert.equal(hi2, ticks2[ticks2.length - 1]);
  assert.ok(hi2 >= 87, "secondary domain must cover its data max");
  const step2 = ticks2[1] - ticks2[0];
  const mantissa = step2 / Math.pow(10, Math.floor(Math.log10(step2)));
  assert.ok([1, 2, 2.5, 5, 10].some((c) => Math.abs(c - mantissa) < 1e-9), "secondary step must be nice");
});

test("band label anchors end/start/middle by horizontal position", () => {
  const L = 10, iw = 486;
  assert.equal(bandLabelAnchor(L + iw, L, iw), "end");
  assert.equal(bandLabelAnchor(L, L, iw), "start");
  assert.equal(bandLabelAnchor(L + iw / 2, L, iw), "middle");
  // Threshold edges: 72% and 28% of the inner width.
  assert.equal(bandLabelAnchor(L + iw * 0.73, L, iw), "end");
  assert.equal(bandLabelAnchor(L + iw * 0.27, L, iw), "start");
  assert.equal(annotationAnchor(L + iw * 0.83, L, iw), "end");
  assert.equal(annotationAnchor(L + iw * 0.17, L, iw), "start");
});

test("x-label stride thins to ≥50px per label and the band index is always forced", () => {
  const nx = 31, iw = 486;
  const stride = autoStride(nx, iw);
  assert.equal(stride, Math.max(1, Math.ceil(nx / Math.max(2, Math.floor(iw / 50)))));
  const L = 10;
  const X = (i: number) => L + (i / (nx - 1)) * iw;
  // Band index drawn even when the stride would skip it.
  assert.equal(shouldDrawXLabel({ i: 13, nx, everyX: 100, X, band: 13 }), true);
  // Last label always drawn.
  assert.equal(shouldDrawXLabel({ i: nx - 1, nx, everyX: 100, X, band: null }), true);
  // A stride-skipped index is not drawn.
  assert.equal(shouldDrawXLabel({ i: 3, nx, everyX: 100, X, band: 13 }), false);
  // Labels within 30px of the band are suppressed.
  assert.equal(shouldDrawXLabel({ i: 14, nx, everyX: 1, X, band: 13 }), false);
  // Labels within 46px of the final label are suppressed.
  assert.equal(shouldDrawXLabel({ i: nx - 2, nx, everyX: 1, X, band: null }), false);
});

test("devBars domain expands to cover reference, values, min/max and pad", () => {
  const rows = [{ v: 1.2 }, { v: 0.8 }, { v: null }];
  const d1 = devBarsDomain(rows, { ref: 1 });
  assert.equal(d1.ref, 1);
  assert.equal(d1.lo, 0.8);
  assert.equal(d1.hi, 1.2);
  const d2 = devBarsDomain(rows, { ref: 1, min: -2, max: 3, pad: 0.5 });
  assert.equal(d2.lo, -2.5);
  assert.equal(d2.hi, 3.5);
  // Null-only rows collapse to the reference.
  const d3 = devBarsDomain([{ v: null }], { ref: 0 });
  assert.equal(d3.lo, 0);
  assert.equal(d3.hi, 0);
});

test("histogram centres small bucket counts on a capped slot", () => {
  const L = 10, iw = 504;
  const small = histogramLayout(2, iw, L);
  assert.equal(small.slot, 150, "n ≤ 3 caps the slot at 150");
  assert.equal(small.xoff, L + (iw - 150 * 2) / 2, "small-n group is centred");
  const large = histogramLayout(12, iw, L);
  assert.equal(large.slot, iw / 12);
  assert.equal(large.xoff, L, "large-n slots fill the width from the left gutter");
  assert.equal(small.bw, Math.min(52, small.slot * 0.62));
});

test("heatmap ramp is the approved validated ordinal ramp (color-mix over --acc, red band from --down)", () => {
  assert.deepEqual(heatCellStyle(9.8), ["color-mix(in srgb,#d0463a,#fff 30%)", "#101422"]);
  assert.deepEqual(heatCellStyle(20), ["color-mix(in srgb,#5b63d3,#fff 46%)", "#101422"]);
  assert.deepEqual(heatCellStyle(30), ["color-mix(in srgb,#5b63d3,#fff 23%)", "#101422"]);
  assert.deepEqual(heatCellStyle(40), ["#5b63d3", "#fff"]);
  assert.deepEqual(heatCellStyle(50), ["color-mix(in srgb,#5b63d3,#000 22%)", "#fff"]);
  // Hatch overlay: dark bands stripe #00000024, light bands #ffffff1f.
  assert.match(heatReprOverlay(50), /#00000024/);
  assert.match(heatReprOverlay(20), /#ffffff1f/);
});

test("monotone path is cubic and starts at the first point", () => {
  const d = monotonePath([[0, 10], [50, 40], [100, 20]]);
  assert.match(d, /^M0\.00,10\.00C/);
  assert.doesNotMatch(d, /L/, "monotone segments never fall back to line commands");
  assert.equal(monotonePath([[0, 0]]), "", "single points draw nothing");
});
