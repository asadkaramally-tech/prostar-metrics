/* Tiny SVG chart renderers for the redesign mockup. Data arrays are passed in from
   each page. Charts render into [data-chart] containers at the container's REAL
   pixel width (and re-render on resize), so axis/annotation text stays ~11px at
   any viewport — no fixed-viewBox downscaling. */

function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

/* Multi-series line chart with optional volume bars and point annotations.
   cfg: { labels:[], series:[{name, vals, color, dash, width}], bars:{vals, ymax}, yfmt,
          ymin, ymax, ticks, reflines:[{v, text, anchor}],
          annotations:[{s, i, text, dy, dx, anchor}], h } */
function chartW(el) { return Math.max(el.clientWidth || 640, 240); }

function lineChart(el, cfg) {
  const W = chartW(el);
  const narrow = W < 720;
  const H = narrow ? 220 : (cfg.h || 300);
  const padL = 8, padR = narrow ? 46 : 56, padT = 26, padB = cfg.xlabels === false ? 10 : 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = cfg.labels.length;
  const x = (i) => padL + (i * iw) / (n - 1);
  const ymin = cfg.ymin ?? 0;
  const ymax = cfg.ymax;
  const y = (v) => padT + ih - ((v - ymin) / (ymax - ymin)) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${el.dataset.label || 'chart'}">`;

  // horizontal gridlines + right axis labels
  const ticks = cfg.ticks || 4;
  for (let t = 0; t <= ticks; t++) {
    const v = ymin + ((ymax - ymin) * t) / ticks;
    const yy = y(v);
    s += `<line x1="${padL}" x2="${W - padR + 6}" y1="${yy}" y2="${yy}" stroke="${css('--chart-grid')}" stroke-width="1"/>`;
    s += `<text x="${W - padR + 10}" y="${yy + 4}">${cfg.yfmt(v)}</text>`;
  }
  // volume bars
  if (cfg.bars) {
    const bmax = cfg.bars.ymax;
    const bw = Math.min(26, (iw / n) * 0.5);
    cfg.bars.vals.forEach((v, i) => {
      const bh = (v / bmax) * (ih * 0.45);
      s += `<rect x="${x(i) - bw / 2}" y="${padT + ih - bh}" width="${bw}" height="${bh}" rx="2" fill="${css('--n150')}"/>`;
    });
  }
  // text-width estimator (shared by refline labels, x labels and annotations)
  const est = (t) => t.length * 6.4;
  // horizontal reference lines: [{v, text, anchor}] — dotted 1px so a reference
  // never reads as a data series (data dashes stay 5 4). In narrow mode the label
  // keeps the fact and drops the clause after the em dash; the label's box is
  // remembered so annotations can dodge it.
  const refBoxes = [];
  let refLabels = '';
  for (const r of cfg.reflines || []) {
    const yy = y(r.v);
    const txt = narrow ? r.text.split(' — ')[0] : r.text;
    const ranchor = r.anchor || 'end';
    const rx = ranchor === 'start' ? padL + 4 : W - padR;
    const rx1 = ranchor === 'start' ? rx : rx - est(txt);
    refBoxes.push({ x1: rx1, x2: rx1 + est(txt), y: yy - 6 });
    s += `<line x1="${padL}" x2="${W - padR + 6}" y1="${yy}" y2="${yy}" stroke="${css('--n300')}" stroke-width="1" stroke-dasharray="1 3"/>`;
    // label drawn AFTER the series (see below) on a surface chip so no data
    // stroke can cross the text
    refLabels += `<rect x="${rx1 - 4}" y="${yy - 15}" width="${est(txt) + 8}" height="13" rx="3" fill="${css('--surface')}" opacity=".92"/>`;
    refLabels += `<text class="annofaint" x="${rx}" y="${yy - 6}" text-anchor="${ranchor}">${txt}</text>`;
  }
  // series
  for (const sr of cfg.series) {
    const pts = sr.vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    s += `<polyline points="${pts}" fill="none" stroke="${sr.color}" stroke-width="${sr.width || 2}" ${sr.dash ? `stroke-dasharray="${sr.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  s += refLabels;
  // x labels — drop any label that would collide at the current width (keep first + last)
  const lastI = n - 1;
  if (cfg.xlabels === false) {
    // panel above a paired small-multiple: the bottom panel carries the axis
  } else {
  const lastLeft = x(lastI) - est(cfg.labels[lastI] || '');
  let prevRight = -Infinity;
  cfg.labels.forEach((l, i) => {
    if (l === '') return;
    const anchor = i === lastI ? 'end' : i === 0 ? 'start' : 'middle';
    const left = anchor === 'start' ? x(i) : anchor === 'end' ? x(i) - est(l) : x(i) - est(l) / 2;
    if (i !== 0 && i !== lastI && (left + est(l) > lastLeft - 14 || left < prevRight + 14)) return;
    prevRight = left + est(l);
    s += `<text x="${x(i)}" y="${H - 8}" text-anchor="${anchor}" ${i === lastI ? 'font-weight="700" fill="' + css('--ink-2') + '"' : ''}>${l}</text>`;
  });
  }
  // annotations — text clamped inside the plot at any width for EVERY anchor
  // (start/end included), then nudged clear of any refline label band so no two
  // text spans can overprint at narrow widths
  for (const a of cfg.annotations || []) {
    const sr = cfg.series[a.s];
    const ax = x(a.i), ay = y(sr.vals[a.i]);
    s += `<circle cx="${ax}" cy="${ay}" r="6.5" fill="${css('--surface')}"/>`;
    s += `<circle cx="${ax}" cy="${ay}" r="4.5" fill="${sr.color}"/>`;
    const lines = a.text.split('\n');
    const tw = Math.max(...lines.map((t) => t.length)) * 6.6;
    const anchor = a.anchor || 'middle';
    let tx = ax + (a.dx || 0);
    const capR = W - padR + 2; // stay clear of the right axis-label column
    if (anchor === 'middle') tx = Math.min(Math.max(tx, tw / 2 + 4), capR - tw / 2);
    else if (anchor === 'end') tx = Math.min(Math.max(tx, tw + 4), capR);
    else tx = Math.min(Math.max(tx, 4), capR - tw);
    let ty = ay + (a.dy ?? -12);
    ty = Math.min(Math.max(ty, 14), H - padB - 4 - (lines.length - 1) * 13);
    const sx1 = anchor === 'middle' ? tx - tw / 2 : anchor === 'end' ? tx - tw : tx;
    const sx2 = sx1 + tw;
    for (let guard = 0; guard < 3; guard++) {
      const hit = refBoxes.find((b) => sx2 > b.x1 - 8 && sx1 < b.x2 + 8 &&
        lines.some((_, k) => Math.abs(ty + k * 13 - b.y) < 12));
      if (!hit) break;
      const above = hit.y - 12 - (lines.length - 1) * 13;
      ty = above >= 14 ? above : hit.y + 15;
    }
    lines.forEach((ln, k) => {
      s += `<text class="${k === 0 ? 'anno' : 'annofaint'}" x="${tx}" y="${ty + k * 13}" text-anchor="${anchor}">${ln}</text>`;
    });
  }
  // hover layer: crosshair + per-series markers, driven by mousemove
  s += `<g class="hoverlayer" style="display:none"><line y1="${padT}" y2="${padT + ih}" stroke="${css('--n300')}" stroke-width="1"/>`;
  for (const sr of cfg.series) s += `<circle r="4.5" fill="${sr.color}" stroke="${css('--surface')}" stroke-width="2"/>`;
  s += '</g></svg>';
  el.innerHTML = s;
  attachHover(el, cfg, { x, y, W, padL, iw, n });
}

/* crosshair + tooltip (dataviz interaction spec: hover layer by default;
   tooltips enhance, never gate — every value also lives in a table/labels) */
function attachHover(el, cfg, g) {
  if (!cfg.tip) return;
  el.classList.add('plot-hover');
  let tipEl = el.querySelector('.charttip');
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'charttip'; el.appendChild(tipEl); }
  const svg = el.querySelector('svg');
  const layer = svg.querySelector('.hoverlayer');
  const line = layer.querySelector('line');
  const dots = [...layer.querySelectorAll('circle')];
  function show(ev) {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * g.W;
    let i = Math.round(((px - g.padL) / g.iw) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const xx = g.x(i);
    layer.style.display = '';
    line.setAttribute('x1', xx); line.setAttribute('x2', xx);
    cfg.series.forEach((sr, k) => { dots[k].setAttribute('cx', xx); dots[k].setAttribute('cy', g.y(sr.vals[i])); });
    tipEl.innerHTML = cfg.tip(i);
    tipEl.style.display = 'block';
    const left = (xx / g.W) * r.width;
    tipEl.style.left = Math.min(Math.max(left + 14, 8), r.width - tipEl.offsetWidth - 8) + 'px';
    tipEl.style.top = Math.max(ev.clientY - r.top - tipEl.offsetHeight - 14, 4) + 'px';
  }
  svg.addEventListener('mousemove', show);
  svg.addEventListener('mouseleave', () => { layer.style.display = 'none'; tipEl.style.display = 'none'; });
}

function renderChart(el) {
  const fn = window[el.dataset.chart];
  if (typeof fn === 'function') fn(el);
}
function chartStale(el) {
  const svg = el.querySelector('svg');
  return !svg || Math.abs(svg.viewBox.baseVal.width - chartW(el)) > 1;
}
document.addEventListener('DOMContentLoaded', () => {
  const els = [...document.querySelectorAll('[data-chart]')];
  els.forEach(renderChart);
  // Re-render whenever a container's real width changes (viewport resize, scrollbar
  // appearing, column reflow) so glyphs stay at true pixel size at any width.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) if (chartStale(e.target)) renderChart(e.target);
    });
    els.forEach((el) => ro.observe(el));
  } else {
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => els.forEach((el) => { if (chartStale(el)) renderChart(el); }), 120);
    });
  }
});
