import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement, type ComponentProps, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricHero, MetricHeroStat } from "../../src/components/ui/metric-hero";
import { Panel } from "../../src/components/ui/panel";

const globalStyles = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
const TestPanel = Panel as ComponentType<Omit<ComponentProps<typeof Panel>, "children">>;
const TestMetricHero = MetricHero as ComponentType<Omit<ComponentProps<typeof MetricHero>, "children">>;

test("shared panels keep padded and flush content modes while charts reach canonical edges", () => {
  const padded = renderToStaticMarkup(createElement(TestPanel, { title: "Form" }, createElement("form")));
  const flush = renderToStaticMarkup(createElement(TestPanel, { title: "Table", flush: true }, createElement("table")));

  assert.match(padded, /class="dashboard-panel-body dashboard-panel-body--padded"/);
  assert.match(flush, /class="dashboard-panel-body dashboard-panel-body--flush"/);
  assert.match(globalStyles, /\.dashboard-panel-header\s*\{\s*padding: 18px 20px 2px;/);
  assert.match(globalStyles, /\.dashboard-panel-body--padded\s*\{\s*padding: 8px 20px 20px;/);
  assert.match(globalStyles, /\.dashboard-panel-body--flush\s*\{\s*padding: 0;/);
  assert.match(globalStyles, /\.dashboard-panel-body--padded:has\(\.recharts-responsive-container\)\s*\{\s*padding-top: 0;/);
  assert.match(globalStyles, /width: calc\(100% \+ 40px\);[\s\S]*?margin-right: -20px;[\s\S]*?margin-left: -20px;/);
  assert.match(globalStyles, /--r-card: 8px;/);
  assert.match(globalStyles, /--r-stat: 8px;/);
  assert.match(globalStyles, /--r-hero: 8px;/);
  assert.match(globalStyles, /--r-control: 8px;/);
  assert.match(globalStyles, /\.dashboard-panel\s*\{[\s\S]*?border-radius: var\(--r-card\);/);
});

test("small neutral tokens match the canonical handoff source", () => {
  assert.equal(customPropertyHex("subtle"), "#6b7383");
  assert.equal(customPropertyHex("faint"), "#6d7585");
});

test("compact quote hero reserves its 72px sparkline region from the 521px breakpoint", () => {
  const breakpointStart = globalStyles.indexOf("@media (min-width: 521px)");
  const breakpointEnd = globalStyles.indexOf(".commission-period-controls", breakpointStart);
  const mobileStart = globalStyles.indexOf("@media (max-width: 520px)");
  const mobileEnd = globalStyles.indexOf("@media (prefers-reduced-motion: reduce)", mobileStart);
  assert.notEqual(breakpointStart, -1);
  assert.notEqual(breakpointEnd, -1);
  assert.notEqual(mobileStart, -1);
  assert.notEqual(mobileEnd, -1);
  const compactBreakpoint = globalStyles.slice(breakpointStart, breakpointEnd);
  const mobileBreakpoint = globalStyles.slice(mobileStart, mobileEnd);

  assert.match(compactBreakpoint, /\.metric-hero--route-compact \.metric-hero-sparkline\s*\{\s*height: 72px;/);
  assert.match(
    compactBreakpoint,
    /\.quotes-dashboard \.metric-hero--route-compact \.metric-hero-focal\s*\{\s*height: auto;\s*min-height: 264px;\s*padding-bottom: calc\(72px \+ 12px\);/,
  );
  assert.match(
    compactBreakpoint,
    /\.quotes-dashboard \.metric-hero--route-compact \.metric-hero-stats\s*\{\s*flex: 1;\s*height: auto;\s*min-height: 264px;/,
  );
  assert.match(
    mobileBreakpoint,
    /\.metric-hero:not\(\.metric-hero--commission\) \.metric-hero-focal\s*\{\s*padding-bottom: 92px;/,
  );
});

test("hero and stat sparklines render shape-preserving cubic paths", () => {
  const heroHtml = renderToStaticMarkup(createElement(TestMetricHero, {
    label: "Net profit",
    value: "$17,534",
    sparkline: [12, 18, 9, null, 11, 16, 14],
    testId: "net-profit-hero",
  }, createElement("div")));
  const statHtml = renderToStaticMarkup(createElement(MetricHeroStat, {
    label: "Revenue",
    value: "$72,100",
    sparkline: [12, 18, 9, 11, 16, 14],
  }));
  const heroLinePaths = strokePaths(heroHtml);
  const statLinePaths = strokePaths(statHtml);

  assert.match(heroHtml, /data-testid="net-profit-hero"/);
  assert.match(heroHtml, /viewBox="0 0 600 86"/);
  assert.match(statHtml, /viewBox="0 0 108 32"/);
  assert.equal(heroLinePaths.length, 2, "null values should retain separate contiguous series");
  assert.equal(statLinePaths.length, 1);
  for (const linePath of [...heroLinePaths, ...statLinePaths]) {
    assert.match(linePath, /\bC/, "sparkline segments should use cubic curves");
    assert.doesNotMatch(linePath, /\bL/, "sparkline strokes should not fall back to angular line segments");
  }
});

test("a hero without meaningful sparkline geometry renders a compact truthful state", () => {
  const html = renderToStaticMarkup(createElement(TestMetricHero, {
    label: "Allocated net profit · Technician",
    value: "$420",
    sparkline: [420],
    testId: "technician-hero",
  }, createElement("div")));

  assert.match(html, /class="metric-hero-focal metric-hero-focal--no-sparkline"/);
  assert.doesNotMatch(html, /metric-hero-sparkline/);
  assert.match(
    globalStyles,
    /\.metric-hero--route-compact \.metric-hero-focal--no-sparkline\s*\{\s*height: auto;\s*min-height: 0;\s*padding-bottom: 22px;/,
  );
  assert.match(
    globalStyles,
    /\.metric-hero:not\(\.metric-hero--commission\) \.metric-hero-focal--no-sparkline\s*\{\s*min-height: 0;\s*padding-bottom: 20px;/,
  );
});

function strokePaths(html: string) {
  return Array.from(html.matchAll(/<path d="([^"]+)" fill="none"/g), (match) => match[1]);
}

function customPropertyHex(name: string, resolveAlias = false) {
  const match = globalStyles.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(match, `missing --${name}`);
  const value = match[1].trim();
  if (resolveAlias) {
    const alias = value.match(/^var\(--([^)]+)\)$/);
    if (alias) return customPropertyHex(alias[1]);
  }
  assert.match(value, /^#[0-9a-f]{6}$/i, `--${name} must resolve to a six-digit hex color`);
  return value;
}
