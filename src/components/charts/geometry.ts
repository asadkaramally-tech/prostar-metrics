/* Pure geometry helpers ported line-by-line from the approved chart kit
   (redesign-handoff/product-reset/APPROVED-2026-07-15/mockups/assets/kit.js).
   Every function here reproduces the kit's math exactly; the React chart
   components consume these so unit tests can pin the invariants. */

export type Point = [number, number];

/* Monotone-cubic path (curveMonotoneX equivalent). */
export function monotonePath(pts: Point[]): string {
  const n = pts.length;
  if (n < 2) return "";
  const dx: number[] = [], dy: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    m[i] = dy[i] / dx[i];
  }
  t[0] = m[0];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  t[n - 1] = m[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = Math.hypot(a, b);
    if (h > 3) { t[i] = 3 * m[i] * a / h; t[i + 1] = 3 * m[i] * b / h; }
  }
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = pts[i][0], y0 = pts[i][1], x1 = pts[i + 1][0], y1 = pts[i + 1][1], h = dx[i] / 3;
    d += `C${(x0 + h).toFixed(2)},${(y0 + t[i] * h).toFixed(2)} ${(x1 - h).toFixed(2)},${(y1 - t[i + 1] * h).toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  return d;
}

/* Nice round ticks: step ∈ {1,2,2.5,5,10}×10^n covering [min,max]. */
export function niceTicks(min: number, max: number, n = 4): { ticks: number[]; lo: number; hi: number } {
  const span = Math.max(max - min, 1e-9);
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = ([1, 2, 2.5, 5, 10].find((c) => c * mag >= step0) as number) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ticks, lo, hi };
}

/* Secondary-axis ticks aligned tick-for-tick with the primary axis: same
   count, zero-based, nice step (kit.js trendChart dual-axis block). */
export function axis2Ticks(max2: number, nTicks: number): { lo2: number; hi2: number; ticks2: number[] } {
  const s0 = max2 / (nTicks - 1);
  const mag2 = Math.pow(10, Math.floor(Math.log10(s0)));
  const step2 = ([1, 2, 2.5, 5, 10].find((c) => c * mag2 >= s0) as number) * mag2;
  const lo2 = 0;
  const hi2 = step2 * (nTicks - 1);
  const ticks2 = Array.from({ length: nTicks }, (_, i) => i * step2);
  return { lo2, hi2, ticks2 };
}

/* Thin x labels to the available width (≥50px per label). */
export function autoStride(nx: number, iw: number): number {
  return Math.max(1, Math.ceil(nx / Math.max(2, Math.floor(iw / 50))));
}

/* Kit's x-label suppression rule: the last label and the band-index label
   are always drawn; other labels honour the stride, must not crowd the
   final label (<46px) and must not crowd the band label (<30px). */
export function shouldDrawXLabel(opts: {
  i: number;
  nx: number;
  everyX: number;
  X: (i: number) => number;
  band: number | null | undefined;
}): boolean {
  const { i, nx, everyX, X, band } = opts;
  const isLast = i === nx - 1;
  const isBandIdx = band === i;
  if (isLast || isBandIdx) return true;
  if (i % everyX !== 0) return false;
  if (X(nx - 1) - X(i) < 46) return false;
  if (band != null && Math.abs(X(band) - X(i)) < 30) return false;
  return true;
}

/* Band-label anchoring: end when the band sits in the right 28% of the
   plot, start in the left 28%, middle otherwise. */
export function bandLabelAnchor(bx0: number, L: number, iw: number): "start" | "middle" | "end" {
  return bx0 > L + iw * 0.72 ? "end" : bx0 < L + iw * 0.28 ? "start" : "middle";
}

/* Annotation anchoring (kit uses an 18%/82% split for callout text). */
export function annotationAnchor(px: number, L: number, iw: number): "start" | "middle" | "end" {
  return px > L + iw * 0.82 ? "end" : px < L + iw * 0.18 ? "start" : "middle";
}

/* Deviation-bar domain: expands to cover the reference, every row value and
   the optional min/max, padded by opts.pad on both sides. */
export function devBarsDomain(
  rows: { v: number | null }[],
  opts: { ref?: number; min?: number; max?: number; pad?: number },
): { ref: number; lo: number; hi: number } {
  const ref = opts.ref ?? 0;
  const lo = Math.min(opts.min ?? ref, ref, ...rows.map((r) => r.v ?? ref)) - (opts.pad ?? 0);
  const hi = Math.max(opts.max ?? ref, ref, ...rows.map((r) => r.v ?? ref)) + (opts.pad ?? 0);
  return { ref, lo, hi };
}

/* Histogram slots: small bucket counts (n ≤ 3) cap the slot at 150px and
   centre the group; otherwise slots fill the inner width. */
export function histogramLayout(n: number, iw: number, L: number): { slot: number; xoff: number; bw: number } {
  const slot = n <= 3 ? Math.min(iw / n, 150) : iw / n;
  const xoff = L + (iw - slot * n) / 2;
  const bw = Math.min(52, slot * 0.62);
  return { slot, xoff, bw };
}

/* Heatmap ramp — single-hue indigo; red is reserved for cells below the
   stated 15% threshold. Returns [background, text] colors. */
export function heatCellStyle(v: number): [string, string] {
  return v < 15
    ? ["#b8453a", "#fff"]
    : v >= 45
      ? ["#4b52c0", "#fff"]
      : v >= 35
        ? ["#5a63c8", "#fff"]
        : v >= 25
          ? ["#a3a9ef", "#2a3140"]
          : ["#d4d8f9", "#2a3140"];
}

export const heatRamp = (v: number): string => heatCellStyle(v)[0];
export const heatTextFor = (v: number): string => heatCellStyle(v)[1];

/* Representative-cell hatch overlay, contrast-matched to the cell text. */
export function heatReprOverlay(v: number): string {
  return heatTextFor(v) === "#fff"
    ? "background-image:repeating-linear-gradient(45deg,transparent 0 5px,rgba(255,255,255,.26) 5px 8px)"
    : "background-image:repeating-linear-gradient(45deg,transparent 0 5px,rgba(16,20,34,.10) 5px 8px)";
}
