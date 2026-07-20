import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  evaluatePageFreshness,
  historicalPageFreshnessRequirements,
  pageFreshnessRequirements,
} from "../../src/lib/store/freshness-evaluator";

const source = readFileSync(path.join(process.cwd(), "src/lib/store/freshness.ts"), "utf8");

test("page freshness serving uses the stored row instead of aggregate validation", () => {
  const pageServingFunction = source.match(
    /export async function getPageFreshness[\s\S]*?export function reconciliationScopeForPage/,
  )?.[0] ?? "";

  assert.match(pageServingFunction, /return buildStoredFreshnessStatus\(row\)/);
  assert.doesNotMatch(pageServingFunction, /evaluateStoredPageFreshness/);
});

test("freshness accepts a successful no-op rebuild after the latest source change", () => {
  assert.match(source, /latest_successful_rebuild as/);
  assert.match(source, /max\(finished_at\) as finished_at/);
  assert.match(
    source,
    /greatest\(latest_model\.rebuilt_at, latest_successful_rebuild\.finished_at\) as rebuilt_at/,
  );
  assert.match(source, /and status = 'succeeded'/);
});

test("freshness serves a ready read model even when a later rebuild attempt is dead-lettered", () => {
  assert.match(source, /Serving the latest ready read model; a later rebuild attempt is dead-lettered/);
  assert.match(source, /row\.rebuilt_at/);
});

test("current source evidence requires authoritative page and generation proof", () => {
  const current = evaluatePageFreshness({
    pageKey: "quotes",
    requirements: pageFreshnessRequirements("quotes"),
    sources: pageFreshnessRequirements("quotes").map((requirement) => ({
      sourceFamily: requirement.sourceFamily,
      lastSuccessfulRunAt: "2026-07-13T11:30:00.000Z",
      dataThrough: "2026-07-13T11:30:00.000Z",
      completeWindow: true,
    })),
    reconciliation: { status: "matched", checkedAt: "2026-07-13T11:50:00.000Z" },
    rollup: { status: "ready", rebuiltAt: "2026-07-13T11:40:00.000Z" },
    now: new Date("2026-07-13T12:00:00.000Z"),
  });

  assert.equal(current.state, "building");
  assert.match(current.coverage.sources.quotes.detail, /current-period source\/page manifest/);
});

test("historical evidence still accepts complete authoritative legacy manifests", () => {
  const requirements = historicalPageFreshnessRequirements("quotes");
  const historical = evaluatePageFreshness({
    pageKey: "quotes",
    requirements,
    sources: requirements.map((requirement) => ({
      sourceFamily: requirement.sourceFamily,
      lastSuccessfulRunAt: "2026-07-01T08:00:00.000Z",
      lastChangeAt: "2026-07-01T08:00:00.000Z",
      dataThrough: "2026-06-30T23:59:59.000Z",
      completeWindow: true,
    })),
    reconciliation: { status: "matched", checkedAt: "2026-07-01T09:00:00.000Z" },
    rollup: { status: "ready", rebuiltAt: "2026-07-01T08:30:00.000Z" },
    now: new Date("2026-07-13T12:00:00.000Z"),
  });

  assert.equal(historical.state, "current");
});

test("freshness optimistic locking preserves PostgreSQL timestamp precision", () => {
  assert.match(source, /updated_at::text as updated_at/);
  assert.match(source, /and updated_at = \$11::timestamptz/);
});

test("freshness refresh retries when a concurrent writer wins the stored-row update", () => {
  assert.match(source, /const updated = await queryPostgres/);
  assert.match(source, /returning updated_at::text/);
  assert.match(source, /if \(updated\.rowCount !== 1\)/);
  assert.match(source, /refreshPageFreshnessAttempt\(pageKey, attempt \+ 1\)/);
});
