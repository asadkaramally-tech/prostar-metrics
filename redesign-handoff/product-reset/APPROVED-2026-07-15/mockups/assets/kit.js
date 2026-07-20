/* Pro Star Metrics product-reset mockups — chart + interaction kit v2.
   Canonical chart language, fully realized: horizontal-only grid on nice round
   ticks, right-side axis labels, monotone lines, accent glow on the star
   series, selected-month highlight band, peak annotations, guide-line
   tooltips, and container-true sizing (1 viewBox unit ≈ 1px). */

(() => {
const NS = "http://www.w3.org/2000/svg";
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

const fmt = {
  money(v, dp = 0) {
    const a = Math.abs(v);
    const s = v < 0 ? "−$" : "$";
    if (a >= 1e6) return s + (a / 1e6).toFixed(1) + "M";
    if (a >= 1e4) return s + Math.round(a / 1e3).toLocaleString() + "K";
    if (a >= 1e3) return s + a.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return s + a.toFixed(dp);
  },
  moneyFull(v) {
    return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  },
  cents(v) {
    return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  pct(v, dp = 1) { return v.toFixed(dp) + "%"; },
  hrs(v) { return v.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "h"; },
  n(v) { return Math.round(v).toLocaleString(); },
};

function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

/* Monotone-cubic path (curveMonotoneX equivalent). */
function monotonePath(pts) {
  const n = pts.length;
  if (n < 2) return "";
  const dx = [], dy = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    m[i] = dy[i] / dx[i];
  }
  t[0] = m[0];
  for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
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

let uid = 0;

/* Nice round ticks: step ∈ {1,2,2.5,5}×10^n covering [min,max]. */
function niceTicks(min, max, n = 4) {
  const span = Math.max(max - min, 1e-9);
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = ([1, 2, 2.5, 5, 10].find(c => c * mag >= step0)) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ticks, lo, hi };
}

/* Shared white tooltip. */
let tipEl = null;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.style.cssText = "position:fixed;z-index:60;background:#fff;border:1px solid #e9ebf0;border-radius:10px;" +
      "padding:9px 12px;font-size:12px;color:#2a3140;box-shadow:0 6px 24px -8px rgba(16,24,40,.24);" +
      "pointer-events:none;opacity:0;transition:opacity .12s;font-variant-numeric:tabular-nums;line-height:1.55;min-width:130px";
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function tipShow(html, cx, cy) {
  const t = tip();
  t.innerHTML = html;
  t.style.opacity = "1";
  const w = t.offsetWidth, h = t.offsetHeight;
  let x = cx + 16, y = cy - h - 14;
  if (x + w > innerWidth - 10) x = cx - w - 16;
  if (y < 10) y = cy + 18;
  t.style.left = x + "px";
  t.style.top = y + "px";
}
function tipHide() { if (tipEl) tipEl.style.opacity = "0"; }
window.addEventListener("scroll", tipHide, true);
window.addEventListener("pointerdown", tipHide, true);
const tipRow = (color, name, val) =>
  `<div style="display:flex;align-items:center;gap:7px;white-space:nowrap"><i style="width:8px;height:8px;border-radius:3px;background:${color};flex:none"></i>` +
  `<span style="color:#5c6474">${name}</span><b style="margin-left:auto;padding-left:16px;color:#101422">${val}</b></div>`;
const tipTitle = s => `<div style="font-weight:700;color:#101422;margin-bottom:5px">${s}</div>`;

/* ───────────────────────────────────────────────────────────
   Trend chart v2.
   opts: {labels, series:[{name,color,values,star,dash,fill,endText,endLabel}],
          yFmt, h, yMax, yMin, everyX, band (x index to highlight),
          annotations:[{i, text, sub, dy}], xlFmt} */
function trendChart(container, opts) {
  const W = opts.w || container.clientWidth || 560;
  const H = opts.h || 260;
  const hasA2 = opts.series.some(s => s.axis === 2);
  const hasAnn = W >= 520 && (opts.annotations || []).length > 0;
  const L = hasA2 ? 56 : 10, R = 64, T = hasAnn ? 46 : 22, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch" });
  const defs = el("defs", {}, svg);
  const a1 = opts.series.filter(s => s.axis !== 2), a2 = opts.series.filter(s => s.axis === 2);
  const vals = ser => ser.flatMap(s => s.values).filter(v => v != null);
  const base = a1.length ? a1 : a2;
  const all = vals(base);
  const dataMax = opts.yMax != null ? opts.yMax : Math.max(...all);
  const dataMin = opts.yMin != null ? opts.yMin : Math.min(0, Math.min(...all));
  const { ticks, lo, hi } = niceTicks(dataMin, dataMax, opts.ticks || 4);
  let lo2 = 0, hi2 = 1, ticks2 = [];
  if (hasA2 && a1.length) {
    const all2 = vals(a2);
    const max2 = opts.y2Max != null ? opts.y2Max : Math.max(...all2);
    const nT = ticks.length;
    const s0 = max2 / (nT - 1);
    const mag2 = Math.pow(10, Math.floor(Math.log10(s0)));
    const step2 = ([1, 2, 2.5, 5, 10].find(c => c * mag2 >= s0)) * mag2;
    lo2 = 0; hi2 = step2 * (nT - 1);
    ticks2 = Array.from({ length: nT }, (_, i) => i * step2);
  }
  const nx = opts.labels.length;
  const X = i => L + (nx === 1 ? iw / 2 : (i / (nx - 1)) * iw);
  const Y = v => T + ih - ((v - lo) / (hi - lo)) * ih;
  const Y2 = v => T + ih - ((v - lo2) / (hi2 - lo2)) * ih;
  const yFor = s => (s.axis === 2 && a1.length) ? Y2 : Y;

  // Selected-period highlight band + optional label (replaces in-plot end labels)
  if (opts.band != null) {
    const slot = nx > 1 ? iw / (nx - 1) : iw;
    const bx = Math.max(L, X(opts.band) - slot / 2);
    const bw = Math.min(slot, L + iw - bx);
    el("rect", { x: bx, y: T - 6, width: bw, height: ih + 10, rx: 7, fill: "rgba(91,99,211,.055)" }, svg);
  }
  if (opts.bandLabel) {
    const bx0 = opts.band != null ? X(opts.band) : L + iw - 2;
    const anch = bx0 > L + iw * 0.72 ? "end" : bx0 < L + iw * 0.28 ? "start" : "middle";
    const t = el("text", { x: bx0, y: 14, "font-size": 12.5, "font-weight": 700, fill: "#5b63d3", "text-anchor": anch, class: "tnum" }, svg);
    t.textContent = opts.bandLabel;
  }
  for (const v of ticks) {
    const y = Y(v);
    el("line", { x1: L, x2: L + iw, y1: y, y2: y, stroke: "#eff1f5", "stroke-width": 1 }, svg);
    const tx = el("text", { x: W - R + 10, y: y + 3.5, "font-size": 12, fill: "#6b7383", class: "tnum" }, svg);
    tx.textContent = ((a1.length ? opts.yFmt : (opts.y2Fmt || opts.yFmt)) || fmt.money)(v);
  }
  if (hasA2 && a1.length) {
    for (const v of ticks2) {
      const tx = el("text", { x: L - 10, y: Y2(v) + 3.5, "font-size": 12, fill: "#6b7383", class: "tnum", "text-anchor": "end" }, svg);
      tx.textContent = (opts.y2Fmt || (x => x))(v);
    }
  }
  // Thin x labels to the available width (≥50px per label) and never
  // let the second-to-last drawn label crowd the always-drawn final one.
  const autoStride = Math.max(1, Math.ceil(nx / Math.max(2, Math.floor(iw / 50))));
  const everyX = Math.max(opts.everyX || 1, autoStride);
  opts.labels.forEach((lb, i) => {
    const isLast = i === nx - 1;
    const isBandIdx = opts.band === i;
    if (!isLast && !isBandIdx && (i % everyX !== 0 || (X(nx - 1) - X(i)) < 46 || (opts.band != null && Math.abs(X(opts.band) - X(i)) < 30))) return;
    const isBand = opts.band === i;
    const tx = el("text", {
      x: X(i), y: H - 9, "font-size": 12,
      fill: isBand ? "#101422" : "#6b7383", "font-weight": isBand ? 700 : 400,
      "text-anchor": i === 0 ? "start" : "middle",
    }, svg);
    tx.textContent = lb;
  });

  const glowId = "gl" + (++uid);
  const gf = el("filter", { id: glowId, x: "-20%", y: "-60%", width: "140%", height: "220%" }, defs);
  el("feDropShadow", { dx: 0, dy: 2.5, stdDeviation: 4, "flood-color": opts.series.find(s => s.star)?.color || "#5b63d3", "flood-opacity": .3 }, gf);

  const ptsBySeries = [];
  for (const s of opts.series) {
    const Ys = yFor(s);
    const pts = s.values.map((v, i) => v == null ? null : [X(i), Ys(v)]);
    ptsBySeries.push(pts);
    const draw = pts.filter(Boolean);
    if (!draw.length) continue;
    if (s.fill) {
      const gid = "g" + (++uid);
      const g = el("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      el("stop", { offset: 0, "stop-color": s.color, "stop-opacity": .16 }, g);
      el("stop", { offset: 1, "stop-color": s.color, "stop-opacity": 0 }, g);
      const area = monotonePath(draw) + `L${draw[draw.length - 1][0].toFixed(2)},${(T + ih).toFixed(2)}L${draw[0][0].toFixed(2)},${(T + ih).toFixed(2)}Z`;
      el("path", { d: area, fill: `url(#${gid})` }, svg);
    }
    const strokeAttrs = {
      fill: "none", stroke: s.color,
      "stroke-width": s.star ? 2.8 : 1.9, "stroke-linecap": "round",
      ...(s.dash ? { "stroke-dasharray": s.dash } : {}),
      ...(s.star ? { filter: `url(#${glowId})` } : {}),
    };
    if (s.reprTo != null && s.reprTo > 0) {
      // Representative span drawn dashed, verified span solid — one curve, two clips.
      const cut = X(Math.min(s.reprTo, s.values.length - 1));
      const c1 = "c" + (++uid), c2 = "c" + (++uid);
      el("rect", { x: 0, y: 0, width: cut, height: H }, el("clipPath", { id: c1 }, defs));
      el("rect", { x: cut, y: 0, width: W - cut, height: H }, el("clipPath", { id: c2 }, defs));
      el("path", { d: monotonePath(draw), ...strokeAttrs, "stroke-dasharray": "4 4.5", "clip-path": `url(#${c1})` }, svg);
      el("path", { d: monotonePath(draw), ...strokeAttrs, "clip-path": `url(#${c2})` }, svg);
    } else {
      el("path", { d: monotonePath(draw), ...strokeAttrs }, svg);
    }
    for (const di of (s.dots || [])) {
      const p = pts[di];
      if (p) el("circle", { cx: p[0], cy: p[1], r: 2.6, fill: "#fff", stroke: s.color, "stroke-width": 1.8 }, svg);
    }
    const last = draw[draw.length - 1];
    if (!s.dash) el("circle", { cx: last[0], cy: last[1], r: s.star ? 3.6 : 2.4, fill: "#fff", stroke: s.color, "stroke-width": 2 }, svg);
    if (s.star && s.endLabel !== false) {
      const ty = Math.min(Math.max(last[1] + (s.endDy ?? -10), T + 8), T + ih - 4);
      const tx = el("text", { x: last[0] - 8, y: ty, "font-size": 12.5, "font-weight": 700, fill: s.color, class: "tnum", "text-anchor": "end" }, svg);
      tx.textContent = s.endText != null ? s.endText : (opts.yFmt || fmt.money)(s.values[s.values.length - 1]);
    }
  }

  // Annotations (peaks, events); a.s picks the series to anchor to (default: star).
  // Suppressed on narrow charts — tooltips carry the values there.
  for (const a of (W >= 520 ? (opts.annotations || []) : [])) {
    const star = a.s != null ? opts.series[a.s] : (opts.series.find(s => s.star) || opts.series[0]);
    if (!star) continue;
    const v = star.values[a.i];
    if (v == null) continue;
    const px = X(a.i), py = yFor(star)(v);
    const above = a.dy == null || a.dy < 0;
    const ly = above ? py - 30 : py + 34;
    el("line", { x1: px, x2: px, y1: above ? ly + 6 : py + 6, y2: above ? py - 7 : ly - 14, stroke: "#c9cfda", "stroke-width": 1, "stroke-dasharray": "2 3" }, svg);
    const anchor = px > L + iw * 0.82 ? "end" : (px < L + iw * 0.18 ? "start" : "middle");
    const t1 = el("text", { x: px, y: ly - 6, "font-size": 12, "font-weight": 700, fill: "#2a3140", "text-anchor": anchor, class: "tnum" }, svg);
    t1.textContent = a.text;
    if (a.sub) {
      const t2 = el("text", { x: px, y: ly + 5, "font-size": 11.5, fill: "#6b7383", "text-anchor": anchor }, svg);
      t2.textContent = a.sub;
    }
  }

  // Hover: guide line + dots + tooltip
  const guide = el("line", { x1: 0, x2: 0, y1: T, y2: T + ih, stroke: "#d3dae3", "stroke-width": 1, opacity: 0 }, svg);
  const hoverDots = opts.series.map(s => el("circle", { r: 3.2, fill: "#fff", stroke: s.color, "stroke-width": 2, opacity: 0 }, svg));
  const hot = el("rect", { x: L, y: T - 6, width: iw, height: ih + 12, fill: "transparent" }, svg);
  hot.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(nx - 1, Math.round(((sx - L) / iw) * (nx - 1))));
    guide.setAttribute("x1", X(i)); guide.setAttribute("x2", X(i));
    guide.setAttribute("opacity", 1);
    let html = tipTitle(opts.tipLabel ? opts.tipLabel(i) : opts.labels[i]);
    opts.series.forEach((s, si) => {
      const v = s.values[i];
      const p = ptsBySeries[si][i];
      if (v == null || !p) { hoverDots[si].setAttribute("opacity", 0); return; }
      hoverDots[si].setAttribute("cx", p[0]); hoverDots[si].setAttribute("cy", p[1]);
      hoverDots[si].setAttribute("opacity", 1);
      html += tipRow(s.color, s.name, (s.tipFmt || opts.yFmt || fmt.money)(v));
    });
    if (opts.tipExtra) html += opts.tipExtra(i);
    tipShow(html, e.clientX, e.clientY);
  });
  hot.addEventListener("pointerleave", () => {
    guide.setAttribute("opacity", 0);
    hoverDots.forEach(d => d.setAttribute("opacity", 0));
    tipHide();
  });

  container.innerHTML = "";
  container.appendChild(svg);
}

/* Bullet strip for hero panels (Few's bullet-graph anatomy, dark theme):
   featured bar = selected month on a zero-based scale to the 12-month high;
   comparative tick = same month last year. Every mark labeled.
   opts: {cur:{m,v}, comp:{m,v}|null, high:{m,v}, fmt} */
function bullet(container, opts) {
  const f = opts.fmt || (v => v);
  const hi = opts.high.v || 1;
  const pct = v => Math.max(0, Math.min(100, v / hi * 100));
  const bx = pct(opts.cur.v);
  const cx = opts.comp ? pct(opts.comp.v) : null;
  const tx = opts.target ? pct(opts.target.v) : null;
  const isHigh = opts.cur.v >= hi * 0.999;
  const curText = `${opts.cur.m} · ${f(opts.cur.v)}${isHigh ? " — 12-mo high" : ""}`;
  const anchor = bx < 16 ? "left:0" : bx > 84 ? "right:0" : `left:${bx}%;transform:translateX(-50%)`;
  const tickSwatch = c => `<span style="display:inline-block;width:2px;height:10px;background:${c};border-radius:1px;vertical-align:-1px;margin-right:6px"></span>`;
  container.innerHTML = `
    <div style="position:relative;height:16px;margin-bottom:5px">
      <span class="tnum" style="position:absolute;${anchor};bottom:0;font-size:12px;font-weight:700;color:#aab0f0;white-space:nowrap">${curText}</span>
    </div>
    <div style="position:relative;height:14px;border-radius:5px;background:rgba(255,255,255,.08)">
      <span style="position:absolute;top:3px;bottom:3px;left:0;width:${bx}%;border-radius:4px;background:#8087ec"></span>
      <span style="position:absolute;top:50%;left:${bx}%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:#8087ec;box-shadow:0 0 0 2px rgba(255,255,255,.8)"></span>
      ${cx != null ? `<span style="position:absolute;top:-3px;bottom:-3px;left:${cx}%;width:2px;margin-left:-1px;border-radius:1px;background:rgba(255,255,255,.85)"></span>` : ""}
      ${tx != null ? `<span style="position:absolute;top:-3px;bottom:-3px;left:${tx}%;width:2px;margin-left:-1px;border-radius:1px;background:#e6c07a"></span>` : ""}
    </div>
    <div style="position:relative;height:16px;margin-top:6px;font-size:11px;color:#8b90a6">
      ${cx != null ? `<span class="tnum" style="position:absolute;${cx < 18 ? "left:0" : cx > 70 ? `right:${(100 - cx).toFixed(1)}%` : `left:${cx}%;transform:translateX(-50%)`};white-space:nowrap">${tickSwatch("rgba(255,255,255,.85)")}${opts.comp.m} · ${f(opts.comp.v)}</span>` : ""}
      ${tx != null ? `<span class="tnum" style="position:absolute;left:0;white-space:nowrap">${tickSwatch("#e6c07a")}${opts.target.m} · ${f(opts.target.v)}</span>` : ""}
      <span class="tnum" style="position:absolute;right:0;white-space:nowrap">${isHigh ? "" : `High · ${opts.high.m} · ${f(opts.high.v)}`}</span>
    </div>`;
}

/* Deviation bars anchored at a reference (Few/Cleveland: encode the difference,
   not two lengths). rows=[{name, v, cov}]; opts {ref, min, max, fmt, labelW,
   refLabel, pos/neg colors}. Bars extend left (below ref, red) or right (above, green). */
function devBars(container, rows, opts = {}) {
  const W = opts.w || container.clientWidth || 560;
  const compact = W < 520;
  const rowH = compact ? 46 : 34;
  const L = compact ? 0 : (opts.labelW || 126);
  const R = compact ? 68 : 128;
  const T = 8, B = 24;
  const H = T + rows.length * rowH + B;
  const iw = W - L - R;
  const ref = opts.ref ?? 0;
  const lo = Math.min(opts.min ?? ref, ref, ...rows.map(r => r.v ?? ref)) - (opts.pad ?? 0);
  const hiV = Math.max(opts.max ?? ref, ref, ...rows.map(r => r.v ?? ref)) + (opts.pad ?? 0);
  const X = v => L + ((v - lo) / (hiV - lo)) * iw;
  const f = opts.fmt || (v => v.toFixed(2));
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch" });
  el("line", { x1: X(ref), x2: X(ref), y1: T - 2, y2: T + rows.length * rowH, stroke: "#c9cfda", "stroke-width": 1.2 }, svg);
  const rl = el("text", { x: X(ref), y: T + rows.length * rowH + 15, "font-size": 12, fill: "#6b7383", "text-anchor": "middle" }, svg);
  rl.textContent = opts.refLabel || String(ref);
  rows.forEach((r, ri) => {
    const y = T + ri * rowH + (compact ? 22 : (rowH - 14) / 2), bh = 14;
    const name = el("text", { x: 0, y: compact ? y - 7 : y + bh / 2 + 4, "font-size": 13.5, "font-weight": 600, fill: "#2a3140",
      stroke: "#fff", "stroke-width": 3, "paint-order": "stroke" }, svg);
    name.textContent = r.name;
    if (r.v == null) {
      const t = el("text", { x: X(ref) + 9, y: y + bh / 2 + 4, "font-size": 12.5, fill: "#6b7383" }, svg);
      t.textContent = "no covered jobs";
      return;
    }
    const up = r.v >= ref;
    const x0 = Math.min(X(ref), X(r.v)), w = Math.max(2, Math.abs(X(r.v) - X(ref)));
    el("rect", { x: x0, y, width: w, height: bh, rx: 4, fill: up ? (opts.pos || "#1a8a5a") : (opts.neg || "#d0463a") }, svg);
    const lab = el("text", {
      x: up ? X(r.v) + 9 : X(r.v) - 9, y: y + bh / 2 + 4, class: "tnum",
      "font-size": compact ? 11 : 12, "font-weight": 700, fill: "#2a3140",
      stroke: "#fff", "stroke-width": 3, "paint-order": "stroke",
      "text-anchor": up ? "start" : "end",
    }, svg);
    lab.textContent = f(r.v) + (r.cov && !compact ? ` · ${r.cov}` : "");
  });
  container.innerHTML = "";
  container.appendChild(svg);
}

/* Per-item diverging strip: one thin column per item around a zero axis.
   items=[{v, label}] sorted by caller; opts {fmt, unit, h}. */
function devStrip(container, items, opts = {}) {
  const W = opts.w || container.clientWidth || 560, H = opts.h || 150;
  const L = 8, R = 64, T = 16, B = 20;
  const iw = W - L - R, ih = H - T - B;
  const maxAbs = Math.max(...items.map(d => Math.abs(d.v))) || 1;
  const Y = v => T + ih / 2 - (v / maxAbs) * (ih / 2);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch" });
  el("line", { x1: L, x2: L + iw, y1: Y(0), y2: Y(0), stroke: "#e2e6ec", "stroke-width": 1.2 }, svg);
  const slot = iw / items.length, bw = Math.max(2, Math.min(10, slot * 0.7));
  const f = opts.fmt || (v => v);
  items.forEach((d, i) => {
    const cx = L + slot * i + slot / 2;
    const up = d.v > 0;
    const bar = el("rect", {
      x: cx - bw / 2, y: Math.min(Y(0), Y(d.v)), width: bw,
      height: Math.max(1.5, Math.abs(Y(d.v) - Y(0))), rx: 1.5,
      fill: d.v === 0 ? "#d8dce6" : up ? "#d0463a" : "#1a8a5a",
    }, svg);
    bar.addEventListener("pointerenter", e => tipShow(tipTitle(d.label || "") + tipRow(up ? "#d0463a" : "#1a8a5a", opts.unit || "Variance", f(d.v)), e.clientX, e.clientY));
    bar.addEventListener("pointerleave", tipHide);
  });
  const t1 = el("text", { x: W - R + 8, y: Y(maxAbs) + 4, "font-size": 12, fill: "#6b7383", class: "tnum" }, svg);
  t1.textContent = "+" + f(maxAbs);
  const t0 = el("text", { x: W - R + 8, y: Y(0) + 4, "font-size": 12, fill: "#6b7383" }, svg);
  t0.textContent = "0";
  container.innerHTML = "";
  container.appendChild(svg);
}

/* Stacked bars (or single series): printed totals above every stack,
   selected-period band, tooltip with per-series breakdown + extras.
   opts: {labels, series:[{name,color,values}], band, yFmt, h, totalFmt, tipExtra(i)} */
function stackedBars(container, opts) {
  const W = opts.w || container.clientWidth || 560, H = opts.h || 300;
  const L = 10, R = 52, T = 26, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch" });
  const nx = opts.labels.length;
  const totals = opts.labels.map((_, i) => opts.series.reduce((s, sr) => s + (sr.values[i] || 0), 0));
  const { ticks, hi } = niceTicks(0, Math.max(...totals), opts.ticks || 4);
  const Y = v => T + ih - (v / hi) * ih;
  const slot = iw / nx, bw = Math.min(38, slot * 0.62);
  if (opts.band != null) {
    el("rect", { x: L + slot * opts.band + slot * 0.08, y: T - 6, width: slot * 0.84, height: ih + 10, rx: 7, fill: "rgba(91,99,211,.055)" }, svg);
  }
  for (const v of ticks) {
    el("line", { x1: L, x2: L + iw, y1: Y(v), y2: Y(v), stroke: "#eff1f5" }, svg);
    const tx = el("text", { x: W - R + 10, y: Y(v) + 3.5, "font-size": 12, fill: "#6b7383", class: "tnum" }, svg);
    tx.textContent = (opts.yFmt || fmt.n)(v);
  }
  const autoStride = Math.max(1, Math.ceil(nx / Math.max(2, Math.floor(iw / 50))));
  opts.labels.forEach((lb, i) => {
    const isLast = i === nx - 1;
    const cx = L + slot * i + slot / 2;
    let run = 0;
    opts.series.forEach(sr => {
      const v = sr.values[i] || 0;
      if (v <= 0) return;
      const y0 = Y(run), y1 = Y(run + v);
      el("rect", { x: cx - bw / 2, y: y1, width: bw, height: Math.max(1.5, y0 - y1), rx: run === 0 ? 0 : 0, fill: sr.color }, svg);
      run += v;
    });
    // rounded top on the stack
    el("rect", { x: cx - bw / 2, y: Y(run), width: bw, height: Math.min(6, (Y(0) - Y(run))), rx: 3, fill: opts.series[opts.series.length - 1].color }, svg);
    const vt = el("text", { x: cx, y: Y(run) - 7, "font-size": 11.5, "font-weight": 700, fill: opts.band === i ? "#101422" : "#5c6474", class: "tnum", "text-anchor": "middle" }, svg);
    vt.textContent = (opts.totalFmt || fmt.n)(totals[i]);
    if (isLast || (i % autoStride === 0 && (nx - 1 - i) >= autoStride * 0.7)) {
      const lt = el("text", { x: cx, y: H - 9, "font-size": 12, fill: opts.band === i ? "#101422" : "#6b7383", "font-weight": opts.band === i ? 700 : 400, "text-anchor": "middle" }, svg);
      lt.textContent = lb;
    }
    const hot = el("rect", { x: L + slot * i, y: T - 6, width: slot, height: ih + 12, fill: "transparent" }, svg);
    hot.addEventListener("pointerenter", e => {
      let html = tipTitle(opts.tipLabel ? opts.tipLabel(i) : lb);
      [...opts.series].reverse().forEach(sr => { html += tipRow(sr.color, sr.name, (opts.valFmt || fmt.n)(sr.values[i] || 0)); });
      if (opts.tipExtra) html += opts.tipExtra(i);
      tipShow(html, e.clientX, e.clientY);
    });
    hot.addEventListener("pointermove", e => { const t = tip(); t.style.left = Math.min(innerWidth - t.offsetWidth - 10, e.clientX + 16) + "px"; t.style.top = Math.max(10, e.clientY - t.offsetHeight - 14) + "px"; });
    hot.addEventListener("pointerleave", tipHide);
  });
  container.innerHTML = "";
  container.appendChild(svg);
}

/* Waterfall v2: glow on the net bar, refined connectors, hover. */
function waterfall(container, steps, opts = {}) {
  const W = opts.w || container.clientWidth || 520, H = opts.h || 300;
  const L = 12, R = 12, T = 34, B = 32;
  const iw = W - L - R, ih = H - T - B;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch" });
  const defs = el("defs", {}, svg);
  const glowId = "gl" + (++uid);
  const gf = el("filter", { id: glowId, x: "-30%", y: "-30%", width: "160%", height: "160%" }, defs);
  el("feDropShadow", { dx: 0, dy: 6, stdDeviation: 7, "flood-color": "#5b63d3", "flood-opacity": .35 }, gf);
  const max = steps[0].value;
  const Y = v => T + ih - (v / max) * ih;
  const n = steps.length, slot = iw / n, bw = Math.min(64, slot * 0.6);
  let run = 0;
  el("line", { x1: L, x2: L + iw, y1: Y(0), y2: Y(0), stroke: "#e2e6ec", "stroke-width": 1.2 }, svg);
  steps.forEach((s, i) => {
    const cx = L + slot * i + slot / 2;
    let y0, y1;
    if (s.kind === "base") { y0 = Y(s.value); y1 = Y(0); run = s.value; }
    else if (s.kind === "minus") { y0 = Y(run); y1 = Y(run - s.value); run -= s.value; }
    else { y0 = Y(s.value); y1 = Y(0); }
    const top = Math.min(y0, y1), hgt = Math.max(2, Math.abs(y1 - y0));
    const fill = s.kind === "base" ? "#101422" : s.kind === "minus" ? "#c9cfda" : "#5b63d3";
    const bar = el("rect", {
      x: cx - bw / 2, y: top, width: bw, height: hgt, rx: 5, fill,
      ...(s.kind === "net" ? { filter: `url(#${glowId})` } : {}),
    }, svg);
    bar.addEventListener("pointerenter", e => tipShow(tipTitle(s.label) + tipRow(fill, s.kind === "minus" ? "Cost" : "Amount", (s.kind === "minus" ? "−" : "") + fmt.moneyFull(s.value)), e.clientX, e.clientY));
    bar.addEventListener("pointerleave", tipHide);
    if (i < n - 1) {
      el("line", { x1: cx + bw / 2 + 3, x2: L + slot * (i + 1) + slot / 2 - bw / 2 - 3, y1: Y(run), y2: Y(run), stroke: "#d3dae3", "stroke-width": 1.2, "stroke-dasharray": "2 3" }, svg);
    }
    const vt = el("text", { x: cx, y: top - 9, "font-size": 12.5, "font-weight": 700, fill: s.kind === "minus" ? "#5c6474" : "#101422", class: "tnum", "text-anchor": "middle" }, svg);
    vt.textContent = (s.kind === "minus" ? "−" : "") + fmt.money(s.value);
    const lt = el("text", { x: cx, y: H - 9, "font-size": 12, fill: "#6b7383", "text-anchor": "middle" }, svg);
    lt.textContent = s.label;
  });
  container.innerHTML = "";
  container.appendChild(svg);
}

/* Horizontal stacked bars (capacity): container-true width, hover, compact mode. */
function hStack(container, rows, opts = {}) {
  const W = opts.w || container.clientWidth || 560;
  const compact = W < 520;
  const rowH = compact ? 54 : (opts.rowH || 38);
  const L = compact ? 0 : (opts.labelW || 126);
  const R = compact ? 54 : (opts.noteW || 124);
  const T = 6;
  const H = T + rows.length * rowH + 6;
  const iw = W - L - R;
  const maxV = Math.max(...rows.map(r => Math.max(r.cap || 0, r.segs.reduce((s, x) => s + x.v, 0)))) * 1.04;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch" });
  rows.forEach((r, ri) => {
    const y = T + ri * rowH + (compact ? 26 : (rowH - 16) / 2), bh = 16;
    const name = el("text", {
      x: 0, y: compact ? y - 9 : y + bh / 2 + 4,
      "font-size": 13.5, "font-weight": 600, fill: "#2a3140",
    }, svg);
    name.textContent = r.name;
    el("rect", { x: L, y, width: iw, height: bh, rx: 5, fill: "#f3f4f8" }, svg);
    let x = L;
    r.segs.forEach(sg => {
      const w = (sg.v / maxV) * iw;
      if (w > 0.5) el("rect", { x, y, width: w, height: bh, fill: sg.color }, svg);
      x += w;
    });
    el("rect", { x: L, y, width: iw, height: bh, rx: 5, fill: "none", stroke: "#e9ebf0" }, svg);
    if (r.cap) {
      const cx = L + (r.cap / maxV) * iw;
      el("rect", { x: cx - 1, y: y - 4, width: 2, height: bh + 8, rx: 1, fill: "#1c2230" }, svg);
    }
    const lab = el("text", {
      x: L + iw + 12, y: y + bh / 2 + 4, class: "tnum",
      "font-size": compact ? 11 : 12, "font-weight": 700,
      fill: r.noteColor || (r.over ? "#d0463a" : "#5c6474"),
    }, svg);
    lab.textContent = (compact ? (r.noteShort ?? r.note) : r.note) || "";
    const hot = el("rect", { x: L, y: y - 6, width: iw + R, height: bh + 12, fill: "transparent" }, svg);
    if (r.tip) {
      hot.addEventListener("pointerenter", e => tipShow(tipTitle(r.name) + r.tip, e.clientX, e.clientY));
      hot.addEventListener("pointerleave", tipHide);
    }
  });
  container.innerHTML = "";
  container.appendChild(svg);
}

/* Ratio bars with 1.00× reference. */
function ratioBars(container, rows, opts = {}) {
  const W = opts.w || container.clientWidth || 560;
  const compact = W < 520;
  const rowH = compact ? 48 : 36;
  const L = compact ? 0 : (opts.labelW || 126);
  const R = compact ? 60 : 76;
  const T = 8, B = 24;
  const H = T + rows.length * rowH + B;
  const iw = W - L - R;
  const maxV = opts.max || Math.max(1.25, ...rows.map(r => r.v || 0)) * 1.08;
  const X = v => L + (v / maxV) * iw;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch" });
  el("line", { x1: X(1), x2: X(1), y1: T - 2, y2: T + rows.length * rowH, stroke: "#c9cfda", "stroke-width": 1.2, "stroke-dasharray": "3 3" }, svg);
  const reflab = el("text", { x: X(1), y: T + rows.length * rowH + 15, "font-size": 12, fill: "#6b7383", "text-anchor": "middle" }, svg);
  reflab.textContent = "1.00× — estimate met exactly";
  rows.forEach((r, ri) => {
    const y = T + ri * rowH + (compact ? 22 : (rowH - 14) / 2), bh = 14;
    const name = el("text", { x: 0, y: compact ? y - 8 : y + bh / 2 + 4, "font-size": 13.5, "font-weight": 600, fill: "#2a3140" }, svg);
    name.textContent = r.name;
    if (r.v == null) {
      const t = el("text", { x: L, y: y + bh / 2 + 4, "font-size": 12.5, fill: "#6b7383" }, svg);
      t.textContent = "no covered jobs";
      return;
    }
    const color = r.v >= 1 ? "#1a8a5a" : (r.v >= 0.9 ? "#9aa2b2" : "#d0463a");
    el("rect", { x: L, y, width: Math.max(2, X(r.v) - L), height: bh, rx: 5, fill: color }, svg);
    const lab = el("text", { x: X(r.v) + 9, y: y + bh / 2 + 4, class: "tnum", "font-size": compact ? 11 : 12, "font-weight": 700, fill: "#2a3140" }, svg);
    lab.textContent = r.v.toFixed(2) + "×";
    if (r.cov && !compact) {
      const c = el("text", { x: L + iw + 12, y: y + bh / 2 + 4, "font-size": 12, fill: "#6b7383", class: "tnum" }, svg);
      c.textContent = r.cov;
    }
  });
  container.innerHTML = "";
  container.appendChild(svg);
}

/* Histogram with hover. */
function histogram(container, buckets, opts = {}) {
  const W = opts.w || container.clientWidth || 560, H = opts.h || 220;
  const L = 10, R = 46, T = 22, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ch" });
  const { ticks, hi } = niceTicks(0, Math.max(...buckets.map(b => b.count)), 3);
  const Y = v => T + ih - (v / hi) * ih;
  for (const v of ticks) {
    el("line", { x1: L, x2: L + iw, y1: Y(v), y2: Y(v), stroke: "#eff1f5" }, svg);
    const tx = el("text", { x: W - R + 10, y: Y(v) + 3.5, "font-size": 12, fill: "#6b7383", class: "tnum" }, svg);
    tx.textContent = (opts.yFmt || (x => Math.round(x)))(v);
  }
  const n = buckets.length;
  const slot = n <= 3 ? Math.min(iw / n, 150) : iw / n;
  const xoff = L + (iw - slot * n) / 2;
  const bw = Math.min(52, slot * 0.62);
  const vf = opts.valFmt || String;
  const stride = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 50))));
  buckets.forEach((b, i) => {
    const cx = xoff + slot * i + slot / 2;
    const fill = b.neg ? "#d0463a" : (b.accent ? "#5b63d3" : "#9aa2b2");
    const by = Y(b.count), bhh = Math.max(1.5, T + ih - by), r0 = Math.min(5, bw / 2, bhh);
    const bar = el("path", { d: `M${(cx - bw / 2).toFixed(1)},${(by + bhh).toFixed(1)}V${(by + r0).toFixed(1)}Q${(cx - bw / 2).toFixed(1)},${by.toFixed(1)} ${(cx - bw / 2 + r0).toFixed(1)},${by.toFixed(1)}H${(cx + bw / 2 - r0).toFixed(1)}Q${(cx + bw / 2).toFixed(1)},${by.toFixed(1)} ${(cx + bw / 2).toFixed(1)},${(by + r0).toFixed(1)}V${(by + bhh).toFixed(1)}Z`, fill }, svg);
    bar.addEventListener("pointerenter", e => tipShow(tipTitle(b.tipLabel || b.label) + tipRow(fill, opts.seriesName || "Jobs", vf(b.count)) + (b.extra || ""), e.clientX, e.clientY));
    bar.addEventListener("pointerleave", tipHide);
    if (n <= 8 || b.accent || i % stride === 0) {
      const vt = el("text", { x: cx, y: Y(b.count) - 7, "font-size": 12.5, "font-weight": 700, fill: b.neg ? "#d0463a" : "#2a3140", class: "tnum", "text-anchor": "middle" }, svg);
      vt.textContent = vf(b.count);
    }
    const isLast = i === n - 1;
    if (n <= 8 || isLast || (i % stride === 0 && (n - 1 - i) >= stride * 0.7)) {
      const lt = el("text", { x: cx, y: H - 9, "font-size": 12, fill: b.accent ? "#101422" : "#6b7383", "font-weight": b.accent ? 700 : 400, "text-anchor": "middle" }, svg);
      lt.textContent = b.label;
    }
  });
  container.innerHTML = "";
  container.appendChild(svg);
}

/* Heatmap with hover tooltips. rows=[{name, cells:[{v,repr}]}] */
function heatmap(container, months, rows, opts = {}) {
  container.innerHTML = "";
  const head = document.createElement("div");
  head.className = "hrow";
  head.innerHTML = `<div></div>` + months.map(m => `<div class="hcol">${m}</div>`).join("");
  container.appendChild(head);
  // Single-hue indigo ramp keeps the system palette; red is reserved for
  // cells below the stated 15% threshold. Representative cells render faded.
  const cellStyle = v => v < 15 ? ["#b8453a", "#fff"] : v >= 45 ? ["#4b52c0", "#fff"] : v >= 35 ? ["#5a63c8", "#fff"] : v >= 25 ? ["#a3a9ef", "#2a3140"] : ["#d4d8f9", "#2a3140"];
  const ramp = v => cellStyle(v)[0];
  const txtFor = v => cellStyle(v)[1];
  const reprOverlay = v => txtFor(v) === "#fff"
    ? "background-image:repeating-linear-gradient(45deg,transparent 0 5px,rgba(255,255,255,.26) 5px 8px)"
    : "background-image:repeating-linear-gradient(45deg,transparent 0 5px,rgba(16,20,34,.10) 5px 8px)";
  rows.forEach(r => {
    const row = document.createElement("div");
    row.className = "hrow";
    row.innerHTML = `<div class="hlab">${r.name}</div>` + r.cells.map((c, i) => {
      if (c.v == null) return `<div class="hcell na" data-m="${months[i]}" data-t="${r.name}">—</div>`;
      const cls = "hcell" + (i === months.length - 1 && opts.highlightLast ? " now" : "");
      return `<div class="${cls}" data-m="${months[i]}" data-t="${r.name}" data-v="${c.v.toFixed(1)}" data-r="${c.repr ? 1 : ""}" style="background-color:${ramp(c.v)};color:${txtFor(c.v)}${c.repr ? ";" + reprOverlay(c.v) : ""}"><span class="tnum">${Math.round(c.v)}%</span></div>`;
    }).join("");
    container.appendChild(row);
  });
  container.addEventListener("pointerover", e => {
    const c = e.target.closest(".hcell");
    if (!c) return;
    const v = c.dataset.v;
    tipShow(tipTitle(`${c.dataset.t} · ${c.dataset.m}`) +
      (v ? tipRow(c.style.backgroundColor || "#e9ebf0", "Acceptance", v + "%") : `<span style="color:#6b7383">No quotes in this tier</span>`) +
      (c.dataset.r ? `<div style="color:#8a5f14;font-size:11px;margin-top:4px">Representative — pending per-month reconciliation</div>` : ""),
      e.clientX, e.clientY);
  });
  container.addEventListener("pointerout", e => { if (e.target.closest(".hcell")) tipHide(); });
}

/* ── interactions ── */
function segInit(root, onChange) {
  $$(".seg", root === undefined ? document : root).forEach(seg => {
    seg.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      $$("button", seg).forEach(x => x.classList.toggle("on", x === b));
      (onChange || (() => {}))(seg.dataset.seg, b.dataset.val);
      seg.dispatchEvent(new CustomEvent("segchange", { detail: b.dataset.val, bubbles: true }));
    });
  });
}

function drawerInit() {
  const scrim = $(".scrim"), drawer = $(".drawer");
  if (!scrim || !drawer) return;
  const close = () => { scrim.classList.remove("open"); drawer.classList.remove("open"); };
  scrim.addEventListener("click", close);
  $(".drawer .x").addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  window.openDrawer = (title, sub, bodyHtml) => {
    $(".drawer .dh .ti").textContent = title;
    $(".drawer .dh .st").textContent = sub;
    $(".drawer .db").innerHTML = bodyHtml;
    scrim.classList.add("open");
    drawer.classList.add("open");
  };
}

function tabsInit(cb) {
  $$(".tabs").forEach(tabs => {
    tabs.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      $$("button", tabs).forEach(x => x.classList.toggle("on", x === b));
      (cb || (() => {}))(b.dataset.tab);
    });
  });
}

window.PSKit = { fmt, trendChart, bullet, devBars, devStrip, stackedBars, waterfall, hStack, ratioBars, histogram, heatmap, segInit, drawerInit, tabsInit, tipShow, tipHide, tipTitle, tipRow, $, $$ };

// Definition tooltips: any element with [data-def] shows its formula/date-anchor on hover.
document.addEventListener("pointerover", e => {
  const d = e.target.closest("[data-def]");
  if (d) tipShow(`<div style="max-width:250px;line-height:1.55;color:#2a3140">${d.dataset.def}</div>`, e.clientX, e.clientY);
});
document.addEventListener("pointerout", e => { if (e.target.closest("[data-def]")) tipHide(); });

// Keep the active nav item visible when the rail becomes a horizontal bar.
try { document.querySelector(".nav a.active")?.scrollIntoView({ inline: "nearest", block: "nearest" }); } catch {}
// State-treatment reference strips render only when explicitly requested.
if (location.search.includes("states=1")) document.body.classList.add("show-states");
})();
