import assert from "node:assert/strict";
import test from "node:test";
import {
  getOperationalDataHealth,
  getOwnerDataHealth,
  type DataHealthQuery,
} from "../../src/lib/store/data-health";

const now = new Date("2026-07-09T12:00:00.000Z");

test("non-admin users receive no model and execute no data-health query", async () => {
  let queryCount = 0;
  const query: DataHealthQuery = async <T>() => {
    queryCount += 1;
    return { rows: [] as T[], rowCount: 0 };
  };

  const model = await getOwnerDataHealth({ roles: ["finance", "operator", "viewer"] }, { query, now });

  assert.equal(model, null);
  assert.equal(queryCount, 0);
});

test("the internal telemetry path reuses the same single aggregate query", async () => {
  let calls = 0;
  const query: DataHealthQuery = async <T>() => {
    calls += 1;
    return { rows: [healthyRow() as T], rowCount: 1 };
  };
  const model = await getOperationalDataHealth({ query, now: new Date("2026-07-09T12:00:00Z") });
  assert.equal(calls, 1);
  assert.equal(model.summary.status, "healthy");
});

test("a fully planned but unfinished historical backfill is alertable", async () => {
  const row = healthyRow();
  row.backfill = {
    start_month: "2023-01-01",
    through_month: "2026-07-01",
    total_months: 43,
    planned_months: 43,
    complete_months: 0,
    completed_required_units: 0,
    total_required_units: 387,
    missing_plan_months: 0,
  };
  const model = await getOperationalDataHealth({
    query: async <T>() => ({ rows: [row as T], rowCount: 1 }),
    now: new Date("2026-07-09T12:00:00Z"),
  });
  assert.equal(model.alerts.some((alert) => alert.id === "backfill-incomplete"), true);
  assert.equal(model.summary.status, "attention");
});

test("admin health loads with one bounded aggregate query and maps operational evidence", async () => {
  let queryCount = 0;
  let capturedSql = "";
  let capturedValues: unknown[] | undefined;
  const query: DataHealthQuery = async <T>(sql: string, values?: unknown[]) => {
    queryCount += 1;
    capturedSql = sql;
    capturedValues = values;
    return { rows: [attentionRow() as T], rowCount: 1 };
  };

  const model = await getOwnerDataHealth({ roles: ["admin"] }, { query, now });

  assert.ok(model);
  assert.equal(queryCount, 1);
  assert.deepEqual(capturedValues, ["2023-01-01", 8, "2026-07-01"]);
  for (const relation of [
    "metrics.ingestion_watermarks",
    "metrics.ingestion_jobs",
    "metrics.rollup_rebuild_queue",
    "metrics.authoritative_reconciliation_results",
    "metrics.backfill_source_month_ledger",
    "metrics.metrics_freshness",
    "metrics.simpro_profit_capacity_completeness",
  ]) {
    assert.match(capturedSql, new RegExp(relation.replaceAll(".", "\\.")));
  }
  assert.match(capturedSql, /limit 10/i);
  assert.doesNotMatch(capturedSql, /invoice/i);
  assert.match(capturedSql, /min\(updated_at\) filter \(where status = 'queued'\)/);
  assert.match(capturedSql, /checked_at desc, period_start desc, id desc/);
  assert.doesNotMatch(capturedSql, /metrics\.reconciliation_runs/);

  assert.equal(model.summary.status, "critical");
  assert.equal(model.summary.queueDepth, 4);
  assert.equal(model.summary.failedWorkCount, 2);
  assert.equal(model.summary.deadLetterCount, 1);
  assert.equal(model.watermarks[0].sourceFamily, "quote_logs");
  assert.equal(model.watermarks[0].gapDetected, true);
  assert.equal(model.queues[0].oldestAgeSeconds, 7_200);
  assert.equal(model.failures.items[0].status, "dead_lettered");
  assert.equal(model.reconciliations[0].valueDrift, -12.5);
  assert.equal(model.pages[0].coveragePercent, 75);
  assert.equal(model.pages.length, 4);
  assert.equal(model.backfill.percentComplete, (300 / 387) * 100);
  assert.equal(model.profitCapacity.totalMissing, 6);
  assert.equal(model.reconciliations.find((item) => item.scope === "jobs")?.status, "incomplete");
  assert.equal(model.pages.find((page) => page.pageKey === "jobs")?.state, "building");
  assert.ok(model.alerts.some((alert) => alert.id === "failed-work" && alert.severity === "critical"));
  assert.ok(model.alerts.some((alert) => alert.id === "watermark-quote_logs"));
  assert.ok(model.alerts.some((alert) => alert.id === "queue-ingestion"));
  assert.ok(model.alerts.some((alert) => alert.id === "reconciliation-quotes"));
  assert.ok(model.alerts.some((alert) => alert.id === "backfill-plan-coverage"));
  assert.ok(model.alerts.some((alert) => alert.id === "profit-capacity-incomplete"));
});

test("complete evidence produces a healthy empty-alert model", async () => {
  const query: DataHealthQuery = async <T>() => ({
    rows: [healthyRow() as T],
    rowCount: 1,
  });

  const model = await getOwnerDataHealth({ roles: ["admin", "finance"] }, { query, now });

  assert.ok(model);
  assert.equal(model.summary.status, "healthy");
  assert.equal(model.summary.activeAlertCount, 0);
  assert.deepEqual(model.alerts, []);
  assert.equal(model.backfill.percentComplete, 100);
  assert.deepEqual(model.pages.map((page) => page.state), ["current", "current", "current", "current"]);
  assert.equal(model.profitCapacity.complete, true);
});

test("missing aggregate rows fail closed to explicit missing page states", async () => {
  const query: DataHealthQuery = async <T>() => ({ rows: [] as T[], rowCount: 0 });

  const model = await getOwnerDataHealth({ roles: ["admin"] }, { query, now });

  assert.ok(model);
  assert.equal(model.pages.length, 4);
  assert.ok(model.pages.every((page) => page.state === "missing"));
  assert.equal(model.summary.status, "critical");
  assert.equal(model.watermarks.length, 0);
  assert.equal(model.failures.total, 0);
  assert.equal(model.profitCapacity.evidenceAvailable, false);
  assert.ok(model.alerts.some((alert) => alert.id === "profit-capacity-evidence-missing"));
});

function attentionRow() {
  return {
    watermarks: [{
      source_family: "quote_logs",
      window_key: "incremental",
      status: "gap",
      data_through: "2026-07-09T10:00:00.000Z",
      expected_through: "2026-07-09T11:00:00.000Z",
      last_success_at: "2026-07-09T10:05:00.000Z",
      complete_window: false,
      gap_detected: true,
      record_count: 25,
      updated_at: "2026-07-09T11:40:00.000Z",
    }],
    queues: [
      {
        kind: "ingestion",
        queued: 3,
        running: 1,
        failed: 1,
        dead_lettered: 1,
        oldest_queued_at: "2026-07-09T10:00:00.000Z",
        oldest_age_seconds: 7_200,
      },
      {
        kind: "rollup",
        queued: 1,
        running: 0,
        failed: 1,
        dead_lettered: 0,
        oldest_queued_at: "2026-07-09T11:45:00.000Z",
        oldest_age_seconds: 900,
      },
    ],
    failure_summary: { total: 2, dead_lettered: 1 },
    failures: [{
      id: "81",
      kind: "ingestion",
      source: "quote_logs",
      status: "dead_lettered",
      error: "cursor gap",
      occurred_at: "2026-07-09T11:45:00.000Z",
    }],
    reconciliations: [
      {
        scope: "quotes",
        period_start: "2026-07-01",
        status: "mismatch",
        count_drift: 2,
        value_drift: -12.5,
        checked_at: "2026-07-09T11:30:00.000Z",
      },
      {
        scope: "jobs",
        period_start: "2026-07-01",
        status: "incomplete",
        count_drift: 0,
        value_drift: 0,
        checked_at: "2026-07-09T11:30:00.000Z",
      },
    ],
    profit_capacity: {
      evidence_available: true,
      completed_jobs_total: 100,
      completed_jobs_missing: 2,
      active_completed_cost_centers_total: 240,
      active_completed_cost_centers_missing: 3,
      people_total: 25,
      people_missing: 1,
      total_missing: 6,
    },
    backfill: {
      start_month: "2023-01-01",
      through_month: "2026-07-01",
      total_months: 43,
      planned_months: 42,
      complete_months: 33,
      completed_required_units: 300,
      total_required_units: 387,
      missing_plan_months: 1,
    },
    pages: [
      {
        page_key: "quotes",
        state: "suspect",
        data_through: "2026-07-09T10:00:00.000Z",
        updated_at: "2026-07-09T11:35:00.000Z",
        detail: "Latest reconciliation mismatch",
        continuation_count: 3,
        core_covered: 2,
        core_total: 3,
        secondary_covered: 1,
        secondary_total: 1,
      },
      {
        page_key: "jobs",
        state: "building",
        data_through: "2026-07-09T10:00:00.000Z",
        updated_at: "2026-07-09T11:35:00.000Z",
        detail: "Migration 026 profit and capacity normalization is incomplete.",
        continuation_count: 0,
        core_covered: 3,
        core_total: 3,
        secondary_covered: 2,
        secondary_total: 2,
      },
    ],
  };
}

function healthyRow() {
  return {
    watermarks: [{
      source_family: "quote_logs",
      window_key: "incremental",
      status: "succeeded",
      data_through: "2026-07-09T11:45:00.000Z",
      expected_through: "2026-07-09T11:45:00.000Z",
      last_success_at: "2026-07-09T11:50:00.000Z",
      complete_window: true,
      gap_detected: false,
      record_count: 12,
      updated_at: "2026-07-09T11:50:00.000Z",
    }],
    queues: [
      { kind: "ingestion", queued: 0, running: 0, failed: 0, dead_lettered: 0, oldest_queued_at: null, oldest_age_seconds: null },
      { kind: "rollup", queued: 0, running: 0, failed: 0, dead_lettered: 0, oldest_queued_at: null, oldest_age_seconds: null },
    ],
    failure_summary: { total: 0, dead_lettered: 0 },
    failures: [],
    reconciliations: ["quotes", "jobs", "technicians", "commissions"].map((scope) => ({
      scope,
      period_start: "2026-07-01",
      status: "matched",
      count_drift: 0,
      value_drift: 0,
      checked_at: "2026-07-09T11:55:00.000Z",
    })),
    profit_capacity: {
      evidence_available: true,
      completed_jobs_total: 100,
      completed_jobs_missing: 0,
      active_completed_cost_centers_total: 240,
      active_completed_cost_centers_missing: 0,
      people_total: 25,
      people_missing: 0,
      total_missing: 0,
    },
    backfill: {
      start_month: "2023-01-01",
      through_month: "2026-07-01",
      total_months: 43,
      planned_months: 43,
      complete_months: 43,
      completed_required_units: 387,
      total_required_units: 387,
      missing_plan_months: 0,
    },
    pages: ["quotes", "jobs", "technicians", "commissions"].map((pageKey) => ({
      page_key: pageKey,
      state: "current",
      data_through: "2026-07-09T11:45:00.000Z",
      updated_at: "2026-07-09T11:55:00.000Z",
      detail: "All required source gates passed.",
      continuation_count: 0,
      core_covered: 3,
      core_total: 3,
      secondary_covered: 1,
      secondary_total: 1,
    })),
  };
}
