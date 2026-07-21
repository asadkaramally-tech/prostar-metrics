import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePageFreshness,
  pageFreshnessRequirements,
  type AggregateFreshnessInput,
  type AggregateFreshnessPageKey,
  type SourceFreshnessEvidence,
} from "../../src/lib/store/freshness-evaluator";

const now = new Date("2026-07-09T12:00:00.000Z");
const sourceSuccessAt = "2026-07-09T11:00:00.000Z";
const sourceChangeAt = "2026-07-09T10:00:00.000Z";
const rollupAt = "2026-07-09T11:15:00.000Z";
const reconciliationAt = "2026-07-09T11:30:00.000Z";

test("a single successful source run cannot make a page current", () => {
  const result = evaluatePageFreshness(baseInput("quotes", [successfulSource("quotes")]));

  assert.equal(result.state, "building");
  assert.match(result.detail, /quote_logs/);
  assert.match(result.detail, /quote_nested/);
});

test("building and partial states become current only after every aggregate gate passes", () => {
  for (const explicitState of ["building", "partial"] as const) {
    const result = evaluatePageFreshness({
      ...baseInput("quotes", successfulSources("quotes")),
      explicitState,
    });

    assert.equal(result.state, "current");
    assert.equal(result.coverage.sources.quotes.state, "successful");
    assert.equal(result.coverage.sources.quote_logs.state, "successful");
    assert.equal(result.coverage.sources.quote_nested.state, "successful");
  }
});

test("a required continuation keeps aggregate freshness building", () => {
  const sources = successfulSources("quotes").map((source) =>
    source.sourceFamily === "quote_logs"
      ? { ...source, pendingCount: 1, completeWindow: false }
      : source,
  );
  const result = evaluatePageFreshness(baseInput("quotes", sources));

  assert.equal(result.state, "building");
  assert.match(result.detail, /quote_logs/);
  assert.equal(result.continuationCount, 1);
});

test("an older success cannot replace the current source-period manifest", () => {
  const sources = successfulSources("quotes").map((source) =>
    source.sourceFamily === "quotes"
      ? {
          ...source,
          manifestGeneration: null,
          reconciliationGeneration: null,
          manifestCompletedAt: null,
          manifestReconciledAt: null,
        }
      : source,
  );
  const result = evaluatePageFreshness(baseInput("quotes", sources));

  assert.equal(result.state, "building");
  assert.match(result.coverage.sources.quotes.detail, /current-period source\/page manifest/);
});

test("incomplete pages and stale manifest generations fail closed", async (t) => {
  await t.test("incomplete pages", () => {
    const sources = successfulSources("quotes").map((source) =>
      source.sourceFamily === "quotes"
        ? { ...source, expectedPageCount: 3, completedPageCount: 2 }
        : source,
    );
    const result = evaluatePageFreshness(baseInput("quotes", sources));
    assert.equal(result.state, "building");
    assert.match(result.coverage.sources.quotes.detail, /manifest is incomplete/);
  });

  await t.test("reconciliation from an older generation", () => {
    const sources = successfulSources("quotes").map((source) =>
      source.sourceFamily === "quotes"
        ? { ...source, manifestGeneration: 4, reconciliationGeneration: 3 }
        : source,
    );
    const result = evaluatePageFreshness(baseInput("quotes", sources));
    assert.equal(result.state, "building");
    assert.match(result.coverage.sources.quotes.detail, /same generation/);
  });
});

test("current source SLAs match the scheduled baseline-plus-change-log architecture", () => {
  const requirements = pageFreshnessRequirements("quotes");
  assert.equal(requirements.find((item) => item.sourceFamily === "quotes")?.maxAgeHours, 8);
  assert.equal(requirements.find((item) => item.sourceFamily === "quote_logs")?.maxAgeHours, 1);
  assert.equal(requirements.find((item) => item.sourceFamily === "quote_logs")?.requiresCurrentManifest, false);
  assert.equal(requirements.find((item) => item.sourceFamily === "quote_logs")?.requiresCompleteWindow, true);
  assert.equal(requirements.find((item) => item.sourceFamily === "quote_nested")?.maxAgeHours, null);

  const technicianRequirements = pageFreshnessRequirements("technicians");
  assert.equal(technicianRequirements.find((item) => item.sourceFamily === "jobs_from_timesheets")?.maxAgeHours, 2);
  assert.equal(technicianRequirements.find((item) => item.sourceFamily === "employees")?.maxAgeHours, 26);
  assert.equal(technicianRequirements.find((item) => item.sourceFamily === "schedules")?.maxAgeHours, null);

  const result = evaluatePageFreshness(baseInput("quotes", successfulSources("quotes")));
  assert.equal(result.state, "current");
  assert.equal(result.coverage.sources.quotes.manifestGeneration, 1);
  assert.equal(result.coverage.sources.quote_nested.reconciliationGeneration, 1);
});

test("fresh change logs keep a page current between scheduled baseline scans", () => {
  const sources = successfulSources("quotes").map((source) => {
    if (source.sourceFamily === "quotes") {
      return { ...source, lastSuccessfulRunAt: "2026-07-09T06:00:00.000Z", dataThrough: "2026-07-09T06:00:00.000Z" };
    }
    if (source.sourceFamily === "quote_nested") {
      return { ...source, lastSuccessfulRunAt: "2026-07-01T06:00:00.000Z", dataThrough: "2026-07-01T06:00:00.000Z" };
    }
    return source;
  });

  assert.equal(evaluatePageFreshness(baseInput("quotes", sources)).state, "current");

  const staleLogs = sources.map((source) =>
    source.sourceFamily === "quote_logs"
      ? { ...source, dataThrough: "2026-07-09T10:00:00.000Z" }
      : source,
  );
  assert.equal(evaluatePageFreshness(baseInput("quotes", staleLogs)).state, "stale");
});

test("complete core coverage with missing secondary sources is partial", () => {
  const coreSources = successfulSources("jobs").filter((source) =>
    pageFreshnessRequirements("jobs").some(
      (requirement) => requirement.sourceFamily === source.sourceFamily && requirement.role === "core",
    ),
  );
  const result = evaluatePageFreshness(baseInput("jobs", coreSources));

  assert.equal(result.state, "partial");
  assert.match(result.detail, /timesheets/);
});

test("failed, suspect, and stale source evidence use status precedence", async (t) => {
  await t.test("failed source", () => {
    const sources = successfulSources("quotes").map((source) =>
      source.sourceFamily === "quote_logs"
        ? { ...source, lastFailedRunAt: "2026-07-09T11:30:00.000Z", completeWindow: false }
        : source,
    );
    assert.equal(evaluatePageFreshness(baseInput("quotes", sources)).state, "failed");
  });

  await t.test("complete serving evidence supersedes a dead-lettered source attempt", () => {
    const sources = successfulSources("quotes").map((source) =>
      source.sourceFamily === "quote_logs"
        ? { ...source, failedCount: 1, lastFailedRunAt: "2026-07-09T11:30:00.000Z" }
        : source,
    );
    assert.equal(evaluatePageFreshness(baseInput("quotes", sources)).state, "current");
  });

  await t.test("suspect reconciliation", () => {
    const input = baseInput("quotes", successfulSources("quotes"));
    input.reconciliation = { status: "mismatch", checkedAt: reconciliationAt };
    assert.equal(evaluatePageFreshness(input).state, "suspect");
  });

  await t.test("stale source", () => {
    const sources = successfulSources("quotes").map((source) =>
      source.sourceFamily === "quote_logs"
        ? { ...source, dataThrough: "2026-07-09T09:00:00.000Z" }
        : source,
    );
    assert.equal(evaluatePageFreshness(baseInput("quotes", sources)).state, "stale");
  });
});

test("authoritative reconciliation can validate an unchanged older rollup", async (t) => {
  await t.test("matched reconciliation after the source generation validates an older rollup", () => {
    const sources = successfulSources("quotes").map((source) => ({
      ...source,
      lastChangeAt: "2026-07-09T11:20:00.000Z",
    }));
    const result = evaluatePageFreshness(baseInput("quotes", sources));
    assert.equal(result.state, "current");
  });

  await t.test("a deterministic rollup after matched reconciliation remains current", () => {
    const input = baseInput("quotes", successfulSources("quotes"));
    input.reconciliation = { status: "matched", checkedAt: "2026-07-09T11:10:00.000Z" };
    const result = evaluatePageFreshness(input);
    assert.equal(result.state, "current");
  });

  await t.test("reconciliation predating the source generation remains building", () => {
    const sources = successfulSources("quotes").map((source) => ({
      ...source,
      lastChangeAt: "2026-07-09T11:20:00.000Z",
    }));
    const input = baseInput("quotes", sources);
    input.reconciliation = { status: "matched", checkedAt: "2026-07-09T11:10:00.000Z" };
    const result = evaluatePageFreshness(input);
    assert.equal(result.state, "building");
    assert.match(result.detail, /predates the current source generation/);
  });
});

test("a sealed historical period accepts a later deterministic rollup", () => {
  const input = baseInput("jobs", successfulSources("jobs"));
  input.sealedHistoricalPeriod = true;
  input.reconciliation = { status: "matched", checkedAt: "2026-07-09T11:30:00.000Z" };
  input.rollup = { status: "ready", rebuiltAt: "2026-07-09T11:45:00.000Z" };

  const result = evaluatePageFreshness(input);

  assert.equal(result.state, "current");
});

test("a sealed historical period still rejects reconciliation older than source evidence", () => {
  const sources = successfulSources("jobs").map((source) => ({
    ...source,
    lastChangeAt: "2026-07-09T11:40:00.000Z",
  }));
  const input = baseInput("jobs", sources);
  input.sealedHistoricalPeriod = true;
  input.reconciliation = { status: "matched", checkedAt: "2026-07-09T11:30:00.000Z" };
  input.rollup = { status: "ready", rebuiltAt: "2026-07-09T11:45:00.000Z" };

  const result = evaluatePageFreshness(input);

  assert.equal(result.state, "building");
  assert.match(result.detail, /historical reconciliation predates/);
});

test("commission freshness follows source, job reconciliation, then commission calculation order", async (t) => {
  const sources = successfulSources("commissions");

  await t.test("calculation after matched job reconciliation is current", () => {
    const result = evaluatePageFreshness({
      ...baseInput("commissions", sources),
      rollup: { status: "ready", rebuiltAt: "2026-07-09T11:45:00.000Z" },
    });
    assert.equal(result.state, "current");
  });

  await t.test("calculation before matched job reconciliation is building", () => {
    const result = evaluatePageFreshness({
      ...baseInput("commissions", sources),
      rollup: { status: "ready", rebuiltAt: "2026-07-09T11:20:00.000Z" },
    });
    assert.equal(result.state, "building");
    assert.match(result.detail, /commission calculation predates/);
  });
});

test("explicit failure and suspect states remain until durable evidence supersedes them", async (t) => {
  await t.test("undated explicit failure is preserved", () => {
    const result = evaluatePageFreshness({
      ...baseInput("quotes", successfulSources("quotes")),
      explicitState: "failed",
      explicitDetail: "Operator-set failure",
    });
    assert.equal(result.state, "failed");
    assert.equal(result.detail, "Operator-set failure");
  });

  await t.test("newer matched reconciliation and ready rollup clear a dated failure", () => {
    const result = evaluatePageFreshness({
      ...baseInput("quotes", successfulSources("quotes")),
      explicitState: "failed",
      explicitDetail: "Prior ingestion failure",
      explicitFailedAt: "2026-07-09T11:05:00.000Z",
    });
    assert.equal(result.state, "current");
  });

  await t.test("a dated failure remains when the rollup predates it", () => {
    const result = evaluatePageFreshness({
      ...baseInput("quotes", successfulSources("quotes")),
      rollup: { status: "ready", rebuiltAt: "2026-07-09T11:00:00.000Z" },
      explicitState: "failed",
      explicitDetail: "Prior ingestion failure",
      explicitFailedAt: "2026-07-09T11:05:00.000Z",
    });
    assert.equal(result.state, "failed");
  });

  await t.test("an equally current matched reconciliation clears explicit suspect", () => {
    const result = evaluatePageFreshness({
      ...baseInput("quotes", successfulSources("quotes")),
      explicitState: "suspect",
      explicitDetail: "Prior mismatch",
      explicitReconciledAt: reconciliationAt,
    });
    assert.equal(result.state, "current");
  });

  await t.test("explicit suspect remains when its evidence is newer than the matched reconciliation", () => {
    const result = evaluatePageFreshness({
      ...baseInput("quotes", successfulSources("quotes")),
      explicitState: "suspect",
      explicitDetail: "Prior mismatch",
      explicitReconciledAt: "2026-07-09T11:40:00.000Z",
    });
    assert.equal(result.state, "suspect");
    assert.equal(result.detail, "Prior mismatch");
  });

  await t.test("stored stale state is replaced by the current aggregate evaluation", () => {
    const result = evaluatePageFreshness({
      ...baseInput("quotes", successfulSources("quotes")),
      explicitState: "stale",
      explicitDetail: "Operator-set stale state",
    });
    assert.equal(result.state, "current");
    assert.doesNotMatch(result.detail, /Operator-set stale/);
  });
});

test("an existing current state is revalidated against aggregate evidence", () => {
  const result = evaluatePageFreshness({
    ...baseInput("quotes", [successfulSource("quotes")]),
    explicitState: "current",
  });

  assert.equal(result.state, "building");
});

test("jobs and technicians cannot be current until every migration 026 gap is zero", async (t) => {
  for (const pageKey of ["jobs", "technicians"] as const) {
    await t.test(pageKey, () => {
      const freshSources = successfulSources(pageKey).map((source) => ({
        ...source,
        lastSuccessfulRunAt: "2026-07-09T11:50:00.000Z",
        dataThrough: "2026-07-09T11:50:00.000Z",
      }));
      const missing = evaluatePageFreshness({
        ...baseInput(pageKey, freshSources),
        profitCapacityCompleteness: {
          completedJobsMissing: 2,
          activeCompletedCostCentersMissing: 3,
          peopleMissing: 1,
        },
      });
      assert.equal(missing.state, "building");
      assert.match(missing.detail, /2 completed jobs, 3 active completed cost centers, and 1 people remain/);

      const complete = evaluatePageFreshness({
        ...baseInput(pageKey, freshSources),
        profitCapacityCompleteness: {
          completedJobsMissing: 0,
          activeCompletedCostCentersMissing: 0,
          peopleMissing: 0,
        },
      });
      assert.equal(complete.state, "current");
    });
  }
});

test("missing migration 026 evidence fails closed for jobs", () => {
  const result = evaluatePageFreshness({
    ...baseInput("jobs", successfulSources("jobs")),
    profitCapacityCompleteness: null,
  });
  assert.equal(result.state, "building");
  assert.match(result.detail, /evidence is unavailable/);
});

function baseInput(
  pageKey: AggregateFreshnessPageKey,
  sources: SourceFreshnessEvidence[],
): AggregateFreshnessInput {
  return {
    pageKey,
    sources,
    rollup: { status: "ready", rebuiltAt: rollupAt },
    reconciliation: { status: "matched", checkedAt: reconciliationAt },
    explicitState: "building",
    profitCapacityCompleteness: {
      completedJobsMissing: 0,
      activeCompletedCostCentersMissing: 0,
      peopleMissing: 0,
    },
    now,
  };
}

function successfulSources(pageKey: AggregateFreshnessPageKey) {
  return pageFreshnessRequirements(pageKey).map((requirement) =>
    successfulSource(requirement.sourceFamily),
  );
}

function successfulSource(sourceFamily: string): SourceFreshnessEvidence {
  return {
    sourceFamily,
    lastSuccessfulRunAt: sourceSuccessAt,
    lastChangeAt: sourceChangeAt,
    dataThrough: sourceSuccessAt,
    pendingCount: 0,
    failedCount: 0,
    completeWindow: true,
    manifestGeneration: 1,
    reconciliationGeneration: 1,
    expectedPageCount: 1,
    completedPageCount: 1,
    manifestCompletedAt: sourceSuccessAt,
    manifestReconciledAt: sourceSuccessAt,
  };
}
