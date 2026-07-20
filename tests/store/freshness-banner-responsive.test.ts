import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FreshnessBanner } from "../../src/components/freshness-banner";
import type { FreshnessStatus } from "../../src/lib/metrics/freshness";

const base: FreshnessStatus = {
  pageKey: "jobs",
  state: "current",
  label: "Data current",
  detail: "Data-through 2026-07-14.",
  dataThrough: "2026-07-14T00:00:00.000Z",
  lastSuccessfulRunAt: "2026-07-15T10:00:00.000Z",
  lastFailedRunAt: null,
};

test("freshness pill is truthful relative time, green only when current", () => {
  const now = new Date("2026-07-15T10:02:00.000Z");
  const current = renderToStaticMarkup(createElement(FreshnessBanner, { freshness: base, now }));
  assert.match(current, /class="pill"/);
  assert.match(current, /Updated 2 min ago/);
  assert.doesNotMatch(current, />Live</);

  const stale = renderToStaticMarkup(createElement(FreshnessBanner, {
    freshness: { ...base, state: "stale" },
    now: new Date("2026-07-15T13:00:00.000Z"),
  }));
  assert.match(stale, /class="pill warn"/);
  assert.match(stale, /Updated 3 hrs ago/);
});

test("freshness pill never fabricates a timestamp when no successful run exists", () => {
  const missing = renderToStaticMarkup(createElement(FreshnessBanner, {
    freshness: { ...base, state: "missing", label: "No app-owned data yet", lastSuccessfulRunAt: null },
  }));
  assert.match(missing, /class="pill warn"/);
  assert.match(missing, /No app-owned data yet/);
  assert.doesNotMatch(missing, /Updated/);
});
