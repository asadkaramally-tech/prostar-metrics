import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Bullet } from "../../src/components/charts/bullet";
import { DevBars } from "../../src/components/charts/dev-bars";
import { DevStrip } from "../../src/components/charts/dev-strip";
import { fmt } from "../../src/components/charts/fmt";
import { HStack } from "../../src/components/charts/h-stack";
import { Heatmap } from "../../src/components/charts/heatmap";
import { Histogram } from "../../src/components/charts/histogram";
import { RatioBars } from "../../src/components/charts/ratio-bars";
import { StackedBars } from "../../src/components/charts/stacked-bars";
import { TrendChart } from "../../src/components/charts/trend-chart";
import { Waterfall } from "../../src/components/charts/waterfall";

const M12 = ["Jul 25", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan 26", "Feb", "Mar", "Apr", "May", "Jun"];

test("TrendChart dual axis renders tick-count-aligned labels on both gutters", () => {
  const html = renderToStaticMarkup(createElement(TrendChart, {
    w: 560,
    labels: M12,
    ticks: 5,
    yMin: 0,
    yMax: 500000,
    yFmt: fmt.money,
    y2Fmt: (v: number) => String(Math.round(v)),
    series: [
      { name: "Revenue", color: "#5b63d3", star: true, endLabel: false, values: M12.map((_, i) => 100000 + i * 30000) },
      { name: "Jobs", color: "#9aa2b2", axis: 2 as const, values: M12.map((_, i) => 40 + i * 4) },
    ],
  }));
  // Dual axis: left gutter L=56, right labels at W-R+10=506, left at L-10=46.
  const rightTicks = html.match(/<text x="506"/g) ?? [];
  const leftTicks = html.match(/<text x="46"/g) ?? [];
  assert.ok(rightTicks.length > 0, "primary tick labels render on the right");
  assert.equal(leftTicks.length, rightTicks.length, "secondary axis label count matches the primary tick count");
  assert.match(html, /viewBox="0 0 560 260"/);
  assert.match(html, /class="ch"/);
});

test("TrendChart band, anchored band label, and band-forced x label", () => {
  const base = {
    w: 560,
    labels: M12,
    everyX: 100,
    yMin: 0,
    series: [{ name: "Rate", color: "#5b63d3", star: true, endLabel: false, values: M12.map((_, i) => 20 + i) }],
  };
  const atEnd = renderToStaticMarkup(createElement(TrendChart, { ...base, band: 11, bandLabel: "Jun · 22.8%" }));
  assert.match(atEnd, /rgba\(91,99,211,\.055\)/, "selected-period band rect present");
  assert.match(atEnd, /<text[^>]*y="14"[^>]*text-anchor="end"[^>]*>Jun · 22\.8%<\/text>/, "right-edge band label anchors end");
  // The band index label renders bold ink even though everyX=100 would skip it.
  assert.match(atEnd, /<text[^>]*fill="#101422" font-weight="700"[^>]*>Jun<\/text>/);
  const atStart = renderToStaticMarkup(createElement(TrendChart, { ...base, band: 0, bandLabel: "Jul" }));
  assert.match(atStart, /<text[^>]*y="14"[^>]*text-anchor="start"[^>]*>Jul<\/text>/, "left-edge band label anchors start");
  const atMid = renderToStaticMarkup(createElement(TrendChart, { ...base, band: 5, bandLabel: "Dec" }));
  assert.match(atMid, /<text[^>]*y="14"[^>]*text-anchor="middle"[^>]*>Dec<\/text>/, "central band label anchors middle");
});

test("TrendChart series grammar: star glow, dashed context, repr clips, dots, hover dots for every series", () => {
  const html = renderToStaticMarkup(createElement(TrendChart, {
    w: 560,
    labels: M12,
    yMin: 0,
    series: [
      { name: "Trailing-12", color: "#c9cede", dash: "3 4", values: M12.map(() => 28), dots: [5] },
      { name: "Net", color: "#5b63d3", star: true, fill: true, reprTo: 4, endLabel: false, values: M12.map((_, i) => 10 + i) },
    ],
  }));
  assert.match(html, /feDropShadow[^>]*flood-color="#5b63d3"/, "glow filter takes the star series colour");
  assert.match(html, /stroke-dasharray="3 4"/, "dashed context series keeps its dash");
  assert.match(html, /stroke-dasharray="4 4\.5"[^>]*clip-path/, "representative span renders dashed under a clip");
  const clips = html.match(/clip-path="url\(#/g) ?? [];
  assert.equal(clips.length, 2, "one curve, two clips (repr + verified)");
  assert.match(html, /linearGradient/, "star fill gradient present");
  assert.match(html, /r="2\.6"/, "marked dot present");
  const hoverDots = html.match(/r="3\.2"/g) ?? [];
  assert.equal(hoverDots.length, 2, "hover dots exist for every series, dashed included");
  // Dashed series draws no end-point circle; star does (r=3.6).
  assert.match(html, /r="3\.6"/);
  assert.doesNotMatch(html, /r="2\.4"/);
});

test("TrendChart annotations render at ≥520px and are suppressed below", () => {
  const props = {
    labels: M12,
    yMin: 0,
    annotations: [{ i: 5, text: "50.0%", sub: "best month" }],
    series: [{ name: "Rate", color: "#5b63d3", star: true, endLabel: false, values: M12.map((_, i) => 20 + i) }],
  };
  const wide = renderToStaticMarkup(createElement(TrendChart, { ...props, w: 560 }));
  assert.match(wide, />50\.0%<\/text>/);
  assert.match(wide, />best month<\/text>/);
  const narrow = renderToStaticMarkup(createElement(TrendChart, { ...props, w: 480 }));
  assert.doesNotMatch(narrow, />best month<\/text>/, "annotations move into tooltips on narrow charts");
});

test("TrendChart treats non-finite values as missing data", () => {
  const html = renderToStaticMarkup(createElement(TrendChart, {
    w: 560,
    labels: ["Jan", "Feb", "Mar"],
    annotations: [{ i: 1, text: "bad point" }],
    series: [
      { name: "Net", color: "#5b63d3", star: true, endLabel: false, values: [10, Number.NaN, 30] },
      { name: "Margin", color: "#9aa2b2", axis: 2 as const, values: [null, Number.POSITIVE_INFINITY, null] },
    ],
  }));

  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.doesNotMatch(html, /bad point/);
});

test("TrendChart expands flat zero domains instead of rendering invalid SVG", () => {
  const html = renderToStaticMarkup(createElement(TrendChart, {
    w: 560,
    labels: ["Jan", "Feb", "Mar"],
    series: [
      { name: "Net", color: "#5b63d3", star: true, endLabel: false, values: [0, 0, 0] },
      { name: "Margin", color: "#9aa2b2", axis: 2 as const, values: [null, null, null] },
    ],
  }));

  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.match(html, />\$0<\/text>/);
});

test("Bullet anchors the featured label by bar position and flags the 12-month high", () => {
  const low = renderToStaticMarkup(createElement(Bullet, {
    cur: { m: "Jun", v: 10 }, comp: { m: "Jun ’25", v: 31.4 }, high: { m: "Dec ’25", v: 100 },
    fmt: (v: number) => v.toFixed(1) + "%",
  }));
  assert.match(low, /position:absolute;left:0;bottom:0/, "bar <16% pins the label left");
  assert.match(low, /High · Dec ’25/, "the 12-month high is always labelled");
  const high = renderToStaticMarkup(createElement(Bullet, {
    cur: { m: "Jun", v: 99 }, comp: null, high: { m: "Dec ’25", v: 100 },
  }));
  assert.match(high, /position:absolute;right:0;bottom:0/, "bar >84% pins the label right");
  const isHigh = renderToStaticMarkup(createElement(Bullet, {
    cur: { m: "Jun", v: 100 }, comp: null, high: { m: "Jun", v: 100 },
  }));
  assert.match(isHigh, /— 12-mo high/);
  assert.doesNotMatch(isHigh, /High · /, "no duplicate High label when the current month is the high");
  const mid = renderToStaticMarkup(createElement(Bullet, {
    cur: { m: "Jun", v: 50 }, comp: null, high: { m: "Dec", v: 100 },
  }));
  assert.match(mid, /left:50%;transform:translateX\(-50%\)/, "central label is centre-anchored");
});

test("DevBars encode deviation from the reference with domain expansion and tone", () => {
  const html = renderToStaticMarkup(createElement(DevBars, {
    w: 560,
    rows: [
      { name: "Above", v: 1.2, cov: "12 jobs" },
      { name: "Below", v: 0.8 },
      { name: "None", v: null },
    ],
    refValue: 1,
    min: 0.5,
    max: 1.5,
    refLabel: "1.00× — met exactly",
    fmt: (v: number) => v.toFixed(2) + "×",
  }));
  assert.match(html, /fill="#1a8a5a"/, "above-reference bar is green");
  assert.match(html, /fill="#d0463a"/, "below-reference bar is red");
  assert.match(html, />no covered jobs<\/text>/);
  assert.match(html, />1\.00× — met exactly<\/text>/);
  assert.match(html, />1\.20× · 12 jobs<\/text>/, "coverage suffix joins the value at desktop width");
  // Domain [0.5,1.5]: ref line sits exactly mid-plot. L=126, R=128 → iw=306, X(1)=279.
  assert.match(html, /<line x1="279" x2="279"/);
});

test("DevStrip diverges around zero with red overruns and green savings", () => {
  const html = renderToStaticMarkup(createElement(DevStrip, {
    w: 560,
    items: [{ v: 4, label: "Job A" }, { v: -3, label: "Job B" }, { v: 0, label: "Job C" }],
    fmt: (v: number) => v + "h",
  }));
  assert.match(html, /fill="#d0463a"/, "positive variance (overrun) is red");
  assert.match(html, /fill="#1a8a5a"/, "negative variance is green");
  assert.match(html, /fill="#d8dce6"/, "zero variance is neutral");
  assert.match(html, />\+4h<\/text>/, "axis maximum is printed with sign");
  assert.match(html, />0<\/text>/);
});

test("Waterfall prints compact checkpoint labels, dashed connectors and a glowing net bar", () => {
  const html = renderToStaticMarkup(createElement(Waterfall, {
    w: 520,
    steps: [
      { label: "Billed", value: 57000, kind: "base" as const },
      { label: "Labour", value: 12000, kind: "minus" as const },
      { label: "Net", value: 45000, kind: "net" as const },
    ],
  }));
  assert.match(html, />\$57K<\/text>/, "compact money labels via fmt.money");
  assert.match(html, />−\$12K<\/text>/, "minus steps carry the true minus sign");
  assert.match(html, /fill="#5b63d3" filter="url\(#gl/, "net bar takes the glow filter");
  assert.match(html, /stroke-dasharray="2 3"/, "running-total connectors are dashed");
  assert.match(html, /fill="#101422"/, "base bar is ink");
  assert.match(html, /fill="#c9cfda"/, "cost bars are neutral");
});

test("Histogram centres small-n buckets and rounds only the bar tops", () => {
  const html = renderToStaticMarkup(createElement(Histogram, {
    w: 560,
    buckets: [
      { label: "Under $750", count: 13, accent: true },
      { label: "$750–$2K", count: 44 },
    ],
  }));
  // iw=504, 2 buckets → slot capped at 150, xoff=112; first bar left edge = 112+75-26 = 161.
  assert.match(html, /d="M161\.0,/, "small-n group is centred, not left-pinned");
  assert.match(html, /Q/, "top corners are rounded with quadratic segments");
  assert.match(html, /fill="#5b63d3"/, "accent bucket is indigo");
  assert.match(html, /fill="#8a92a4"/, "default bucket is neutral (≥3:1 graphics contrast)");
  const neg = renderToStaticMarkup(createElement(Histogram, {
    w: 560,
    buckets: [{ label: "Losses", count: 7, neg: true }],
  }));
  assert.match(neg, /fill="#d0463a"/);
});

test("Heatmap applies the contrast-safe ramp, hatches representative cells and marks gaps", () => {
  const html = renderToStaticMarkup(createElement(Heatmap, {
    months: ["May", "Jun"],
    highlightLast: true,
    rows: [
      { name: "$10K+", cells: [{ v: 9.8, repr: true }, { v: 50 }] },
      { name: "Under $750", cells: [{ v: null }, { v: 20, repr: true }] },
    ],
  }));
  assert.match(html, /background-color:#b8453a;color:#fff/, "below-threshold cell is red with white text");
  assert.match(html, /background-color:#4b52c0;color:#fff/, "45%+ cell takes the deepest indigo");
  assert.match(html, /background-color:#d4d8f9;color:#2a3140/, "15–25 cell takes the lightest indigo with ink text");
  assert.match(html, /repeating-linear-gradient\(45deg,transparent 0 5px,rgba\(255,255,255,\.26\) 5px 8px\)/, "white hatch on dark repr cell");
  assert.match(html, /repeating-linear-gradient\(45deg,transparent 0 5px,rgba\(16,20,34,\.10\) 5px 8px\)/, "ink hatch on light repr cell");
  assert.match(html, /class="hcell na"[^>]*>—</, "empty cells show — (never 0%)");
  assert.match(html, /class="hcell now"/, "last column highlights when highlightLast is set");
  assert.match(html, /--hm-cols:2/, "grid column count follows the month count");
  assert.match(html, /class="hcol">May</);
});

test("HStack draws capacity ticks and over-capacity notes", () => {
  const html = renderToStaticMarkup(createElement(HStack, {
    w: 560,
    rows: [
      { name: "Tech A", segs: [{ v: 80, color: "#8087ec" }], cap: 100, note: "80h of 100h" },
      { name: "Tech B", segs: [{ v: 120, color: "#8087ec" }], cap: 100, note: "120h · +20 over", over: true },
    ],
  }));
  assert.match(html, /fill="#1c2230"/, "capacity tick present");
  assert.match(html, /fill="#d0463a"[^>]*>120h · \+20 over</, "over-capacity note turns red");
  assert.match(html, /fill="#5c6474"[^>]*>80h of 100h</);
});

test("RatioBars colour by threshold around the dashed 1.00× reference", () => {
  const html = renderToStaticMarkup(createElement(RatioBars, {
    w: 560,
    rows: [
      { name: "Met", v: 1.1 },
      { name: "Near", v: 0.95 },
      { name: "Under", v: 0.7 },
      { name: "None", v: null },
    ],
  }));
  assert.match(html, /stroke-dasharray="3 3"/, "reference line is dashed");
  assert.match(html, />1\.00× — estimate met exactly<\/text>/);
  assert.match(html, /fill="#1a8a5a"/);
  assert.match(html, /fill="#9aa2b2"/);
  assert.match(html, /fill="#d0463a"/);
  assert.match(html, />no covered jobs<\/text>/);
});

test("StackedBars print totals above stacks and honour the selected-period band", () => {
  const html = renderToStaticMarkup(createElement(StackedBars, {
    w: 560,
    labels: ["May", "Jun"],
    band: 1,
    series: [
      { name: "Sent", color: "#404a60", values: [168, 189] },
      { name: "Won", color: "#5b63d3", values: [56, 43] },
    ],
  }));
  assert.match(html, />224<\/text>/, "stack totals are printed");
  assert.match(html, />232<\/text>/);
  assert.match(html, /rgba\(91,99,211,\.055\)/, "band rect present");
  assert.match(html, /rx="3"/, "stack top is rounded");
  assert.match(html, /fill="#101422" font-weight="700"[^>]*>Jun<\/text>/, "band month label is emphasised");
});
