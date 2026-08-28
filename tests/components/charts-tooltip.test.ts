import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { tipRow, tipText, tipTitle } from "../../src/components/charts/tooltip";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const tooltipSource = read("src/components/charts/tooltip.ts");

test("shared tooltip is a fixed-position singleton hidden on scroll and pointerdown", () => {
  assert.match(tooltipSource, /position:fixed;z-index:60;background:#fff/, "kit's exact tooltip chrome");
  assert.match(tooltipSource, /window\.addEventListener\("scroll", tipHide, true\)/, "capture-phase scroll hide");
  assert.match(tooltipSource, /window\.addEventListener\("pointerdown", tipHide, true\)/, "capture-phase pointerdown hide");
  assert.match(tooltipSource, /pointer-events:none/, "tooltip never traps the pointer");
  assert.match(tooltipSource, /document\.body\.appendChild\(tipEl\)/, "single element appended once");
});

test("every chart wires tipHide on pointer leave", () => {
  const charts = [
    "src/components/charts/trend-chart.tsx",
    "src/components/charts/dev-strip.tsx",
    "src/components/charts/stacked-bars.tsx",
    "src/components/charts/waterfall.tsx",
    "src/components/charts/h-stack.tsx",
    "src/components/charts/histogram.tsx",
    "src/components/charts/heatmap.tsx",
  ];
  for (const file of charts) {
    const source = read(file);
    assert.match(source, /tipHide/, `${file} must hide the shared tooltip`);
    assert.match(source, /onPointer(Leave|Out)/, `${file} must hide on pointer leave/out`);
  }
});

test("tooltip rows and titles keep the kit's exact markup", () => {
  assert.equal(
    tipRow("#5b63d3", "Won", "$189,074"),
    `<div style="display:flex;align-items:center;gap:7px;white-space:nowrap"><i style="width:8px;height:8px;border-radius:3px;background:#5b63d3;flex:none"></i>` +
      `<span style="color:#5c6474">Won</span><b style="margin-left:auto;padding-left:16px;color:#101422">$189,074</b></div>`,
  );
  assert.equal(tipTitle("Jun"), `<div style="font-weight:700;color:#101422;margin-bottom:5px">Jun</div>`);
});

test("tooltip helpers escape source-controlled labels and reject unsafe colors", () => {
  const payload = `<img src=x onerror="globalThis.pwned=1"> & 'quoted'`;
  const title = tipTitle(payload);
  const row = tipRow(`red"></i><img src=x onerror=1`, payload, payload);
  const text = tipText(payload);

  for (const html of [title, row, text]) {
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
    assert.match(html, /&amp;/);
    assert.match(html, /&#39;quoted&#39;/);
  }
  assert.match(row, /background:#e9ebf0/);
});

test("[data-def] definition tooltips are wired document-wide by the provider", () => {
  assert.match(tooltipSource, /closest\?\.\("\[data-def\]"\)/, "delegated [data-def] targeting");
  assert.match(tooltipSource, /max-width:250px/, "kit's definition bubble width");
  assert.match(tooltipSource, /document\.addEventListener\("focusin", focus\)/);
  assert.match(tooltipSource, /element\.tabIndex = 0/);
  assert.match(tooltipSource, /aria-describedby/);
  assert.match(tooltipSource, /role", "tooltip"/);
  const provider = read("src/components/reset/def-tooltip.tsx");
  assert.match(provider, /wireDefTooltips\(\)/);
  assert.match(provider, /useEffect/);
});
