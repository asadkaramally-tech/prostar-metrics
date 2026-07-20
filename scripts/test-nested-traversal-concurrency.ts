import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg, { type Client, type ClientConfig } from "pg";
import {
  beginProjectNestedTraversal,
  emptyNestedTraversalSeen,
  enqueueAffectedRollups,
  finalizeProjectNestedTraversal,
  mapCostCenterFact,
  markProjectSourceUnavailable,
  markScheduleSourceUnavailable,
  persistProjectCostCenter,
  persistScheduleBlocks,
  provenanceFor,
  withCurrentProjectNestedTraversal,
  type NestedFinalizationTransaction,
} from "@/lib/simpro/normalize-nested";
import {
  acquireSchedulePublicationAuthority,
  activeScheduleTechnicianPeriods,
  normalizeSimproSnapshot,
} from "@/lib/simpro/normalize";
import {
  acquireQuoteCategoryAdvisoryLock,
} from "@/lib/store/quote-category-rebuild";
import { acquireQuoteClassificationAdvisoryLock } from "@/lib/store/quote-classification-rebuild";
import { persistQuoteOverrideAction } from "@/lib/store/quote-overrides";
import type { PostgresQuery } from "@/lib/store/postgres";
import { snapshotTimestamp, writeRawSnapshot } from "@/lib/store/snapshots";

const { Client: PgClient } = pg;
const FORCED_ROLLUP_FAILURE = "forced nested traversal rollup publication failure";

const fixture = {
  generationRace: {
    quoteId: 8_900_000_001,
    rootGenerationOne: 8_910_000_011,
    rootGenerationTwo: 8_910_000_012,
    newerDecoy: 8_910_000_013,
    generationOneCostCenter: 8_920_000_011,
    lateGenerationOneCostCenter: 8_920_000_012,
    generationTwoCostCenter: 8_920_000_013,
  },
  childBarrier: {
    quoteId: 8_900_000_002,
    rootSnapshot: 8_910_000_021,
    newerDecoy: 8_910_000_022,
    currentCostCenter: 8_920_000_021,
    blockedCostCenter: 8_920_000_022,
  },
  unavailableBarrier: {
    quoteId: 8_900_000_003,
    rootSnapshot: 8_910_000_031,
    newerDecoy: 8_910_000_032,
    currentCostCenter: 8_920_000_031,
  },
  unavailableApplied: {
    quoteId: 8_900_000_004,
    rootSnapshot: 8_910_000_041,
    newerDecoy: 8_910_000_042,
    currentCostCenter: 8_920_000_041,
  },
  rollback: {
    quoteId: 8_900_000_005,
    rootSnapshot: 8_910_000_051,
    newerDecoy: 8_910_000_052,
    staleCostCenter: 8_920_000_051,
    currentCostCenter: 8_920_000_052,
  },
  scheduleReassignment: {
    firstJobId: 8_900_000_061,
    staleJobId: 8_900_000_062,
    scheduleId: 8_930_000_061,
    firstStaffId: 8_940_000_061,
    staleStaffId: 8_940_000_062,
    rollbackStaffId: 8_940_000_063,
  },
  lockOrder: {
    quoteId: 8_900_000_071,
    jobId: 8_900_000_072,
    rootSnapshot: 8_910_000_071,
  },
  overrideHandoff: {
    quoteId: 8_900_000_073,
    rootSnapshot: 8_910_000_073,
  },
  jobFinalization: {
    jobId: 8_900_000_081,
    rootSnapshot: 8_910_000_081,
    costCenterId: 8_920_000_081,
  },
  rawResurrection: {
    quoteId: 8_900_000_091,
  },
} as const;

type VerifiedTlsModule = {
  verifiedPostgresClientConfig(connectionString: string): Promise<ClientConfig>;
};

async function main() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  assert.ok(
    connectionString,
    "AZURE_POSTGRES_CONNECTION_STRING must identify test-migrations' temporary database",
  );

  const loadModule = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<VerifiedTlsModule>;
  const { verifiedPostgresClientConfig } = await loadModule(
    new URL("./postgres-tls.mjs", import.meta.url).href,
  );
  const clientConfig = await verifiedPostgresClientConfig(connectionString);
  const clientA = new PgClient({ ...clientConfig, application_name: "nested-traversal-test-a" });
  const clientB = new PgClient({ ...clientConfig, application_name: "nested-traversal-test-b" });
  let clientAConnected = false;
  let clientBConnected = false;

  try {
    await clientA.connect();
    clientAConnected = true;
    await clientB.connect();
    clientBConnected = true;

    const queryA = bindQuery(clientA);
    const queryB = bindQuery(clientB);
    await queryA("set statement_timeout = '15s'");
    await queryB("set statement_timeout = '15s'");

    const period = await queryA<{ period_start: string }>(
      `select to_char(
         date_trunc('month', current_timestamp at time zone 'America/Los_Angeles'),
         'YYYY-MM-DD'
       ) as period_start`,
    );
    const periodStart = period.rows[0]?.period_start;
    assert.match(
      periodStart ?? "",
      /^20\d{2}-\d{2}-01$/,
      "the integration fixture month must be the current in-scope Pacific month",
    );

    const backend = await queryB<{ pid: number }>("select pg_backend_pid() as pid");
    const clientBBackendPid = backend.rows[0]?.pid;
    assert.ok(clientBBackendPid, "client B must expose a PostgreSQL backend PID");

    await assertGenerationSupersession(queryA, clientA, periodStart);
    await assertBlockedChildWriteIsRejected(
      queryA,
      queryB,
      clientA,
      clientBBackendPid,
      periodStart,
    );
    await assertCompletedFinalizerBeatsSourceUnavailable(
      queryA,
      queryB,
      clientA,
      clientB,
      clientBBackendPid,
      periodStart,
    );
    await assertAppliedSourceUnavailableDeletesRawSnapshots(
      queryA,
      clientA,
      periodStart,
    );
    await assertLatePublicationFailureRollsBack(queryA, clientA, periodStart);
    await assertJobFinalizationRollupsAreAtomic(queryA, clientA, periodStart);
    await assertIdenticalHashResurrectionFinalizes(queryA, clientA, periodStart);
    await assertStaleCrossProjectScheduleCannotOverwrite(
      queryA,
      queryB,
      clientA,
      clientB,
      clientBBackendPid,
      periodStart,
    );
    await assertQuoteClassificationLockPrecedesJobMutation(
      queryA,
      queryB,
      clientB,
      clientBBackendPid,
      periodStart,
    );
    await assertNewerQuoteIngestionPrecedesReinstatement(
      queryA,
      queryB,
      clientB,
      clientBBackendPid,
      periodStart,
    );

    console.log("Nested traversal two-session PostgreSQL integration assertions passed.");
  } finally {
    const closes: Array<Promise<void>> = [];
    if (clientBConnected) closes.push(clientB.end());
    if (clientAConnected) closes.push(clientA.end());
    await Promise.allSettled(closes);
  }
}

async function assertGenerationSupersession(
  query: PostgresQuery,
  client: Client,
  periodStart: string,
) {
  const ids = fixture.generationRace;
  await createQuoteFixture(query, {
    quoteId: ids.quoteId,
    periodStart,
    canonicalSnapshotId: ids.rootGenerationTwo,
    rawSnapshotIds: [ids.rootGenerationOne, ids.rootGenerationTwo, ids.newerDecoy],
  });

  const generationOne = await beginProjectNestedTraversal(
    "quote",
    ids.quoteId,
    transactionFor(client, query),
  );
  assert.equal(generationOne, 1, "the first traversal must use generation 1");
  await persistQuoteCostCenter(query, {
    quoteId: ids.quoteId,
    costCenterId: ids.generationOneCostCenter,
    generation: generationOne,
    configuredCostCenterId: 6,
  });

  const generationTwo = await beginProjectNestedTraversal(
    "quote",
    ids.quoteId,
    transactionFor(client, query),
  );
  assert.equal(generationTwo, 2, "the replacement traversal must use generation 2");

  await persistQuoteCostCenter(query, {
    quoteId: ids.quoteId,
    costCenterId: ids.lateGenerationOneCostCenter,
    generation: generationOne,
    configuredCostCenterId: 6,
  });
  await assertCostCenterAbsent(
    query,
    ids.quoteId,
    ids.lateGenerationOneCostCenter,
    "a late generation-1 child write must be rejected after generation 2 starts",
  );

  const staleFinalization = await finalizeProjectNestedTraversal({
    projectType: "quote",
    projectId: ids.quoteId,
    generation: generationOne,
    rootSnapshotId: ids.rootGenerationOne,
    seen: emptyNestedTraversalSeen(),
    query,
    transaction: transactionFor(client, query),
  });
  assert.deepEqual(
    staleFinalization,
    { applied: false, affectedPeriods: [] },
    "stale generation-1 finalization must not apply",
  );
  await assertRawSnapshotStates(
    query,
    [ids.rootGenerationOne, ids.rootGenerationTwo, ids.newerDecoy],
    [
      rawState(ids.rootGenerationOne, false, false),
      rawState(ids.rootGenerationTwo, false, false),
      rawState(ids.newerDecoy, false, false),
    ],
    "stale finalization must not complete or delete any raw root snapshot",
  );

  await persistQuoteCostCenter(query, {
    quoteId: ids.quoteId,
    costCenterId: ids.generationTwoCostCenter,
    generation: generationTwo,
    configuredCostCenterId: 5,
  });
  const winningFinalization = await finalizeProjectNestedTraversal({
    projectType: "quote",
    projectId: ids.quoteId,
    generation: generationTwo,
    rootSnapshotId: ids.rootGenerationTwo,
    seen: emptyNestedTraversalSeen(),
    query,
    transaction: transactionFor(client, query),
  });
  assert.deepEqual(
    winningFinalization,
    { applied: true, affectedPeriods: [{ scope: "quotes", periodStart }] },
    "generation-2 finalization must win and publish the current quote month",
  );

  const children = await query<{
    cost_center_id: string;
    traversal_generation: string;
    source_deleted: boolean;
  }>(
    `select cost_center_id::text, traversal_generation::text,
            source_deleted_at is not null as source_deleted
       from metrics.metrics_quote_cost_centers
      where quote_id = $1
      order by cost_center_id`,
    [ids.quoteId],
  );
  assert.deepEqual(
    children.rows,
    [
      {
        cost_center_id: String(ids.generationOneCostCenter),
        traversal_generation: "1",
        source_deleted: true,
      },
      {
        cost_center_id: String(ids.generationTwoCostCenter),
        traversal_generation: "2",
        source_deleted: false,
      },
    ],
    "generation-2 finalization must tombstone superseded children and retain only generation 2",
  );
  await assertTraversalState(query, ids.quoteId, 2, "completed", true);
  await assertRawSnapshotStates(
    query,
    [ids.rootGenerationOne, ids.rootGenerationTwo, ids.newerDecoy],
    [
      rawState(ids.rootGenerationOne, false, false),
      rawState(ids.rootGenerationTwo, true, false),
      rawState(ids.newerDecoy, false, false),
    ],
    "generation-2 finalization must complete exactly its supplied root snapshot, not the newer snapshot",
  );
}

async function assertBlockedChildWriteIsRejected(
  queryA: PostgresQuery,
  queryB: PostgresQuery,
  clientA: Client,
  clientBBackendPid: number,
  periodStart: string,
) {
  const ids = fixture.childBarrier;
  await createQuoteFixture(queryA, {
    quoteId: ids.quoteId,
    periodStart,
    canonicalSnapshotId: ids.rootSnapshot,
    rawSnapshotIds: [ids.rootSnapshot, ids.newerDecoy],
  });
  const generation = await beginProjectNestedTraversal(
    "quote",
    ids.quoteId,
    transactionFor(clientA, queryA),
  );
  await persistQuoteCostCenter(queryA, {
    quoteId: ids.quoteId,
    costCenterId: ids.currentCostCenter,
    generation,
    configuredCostCenterId: 5,
  });

  await queryA("begin");
  let transactionOpen = true;
  let blockedWrite: Promise<void> | null = null;
  try {
    await holdQuoteTraversalBarrier(queryA, ids.quoteId, generation);
    blockedWrite = persistQuoteCostCenter(queryB, {
      quoteId: ids.quoteId,
      costCenterId: ids.blockedCostCenter,
      generation,
      configuredCostCenterId: 6,
    });
    await waitForLockWait(
      queryA,
      clientBBackendPid,
      "client B current child write must block behind client A",
    );

    const finalization = await finalizeProjectNestedTraversal({
      projectType: "quote",
      projectId: ids.quoteId,
      generation,
      rootSnapshotId: ids.rootSnapshot,
      seen: emptyNestedTraversalSeen(),
      query: queryA,
      transaction: existingTransaction(queryA),
    });
    assert.deepEqual(
      finalization,
      { applied: true, affectedPeriods: [{ scope: "quotes", periodStart }] },
      "client A must complete the current generation while holding the barrier",
    );
    await queryA("commit");
    transactionOpen = false;
    await blockedWrite;
  } finally {
    if (transactionOpen) await queryA("rollback").catch(() => undefined);
    if (blockedWrite) await blockedWrite.catch(() => undefined);
  }

  await assertCostCenterAbsent(
    queryA,
    ids.quoteId,
    ids.blockedCostCenter,
    "the child write unblocked after completion must not appear",
  );
  await assertTraversalState(queryA, ids.quoteId, generation, "completed", true);
  await assertRawSnapshotStates(
    queryA,
    [ids.rootSnapshot, ids.newerDecoy],
    [
      rawState(ids.rootSnapshot, true, false),
      rawState(ids.newerDecoy, false, false),
    ],
    "barrier finalization must expose completion only on the exact root snapshot",
  );
}

async function assertCompletedFinalizerBeatsSourceUnavailable(
  queryA: PostgresQuery,
  queryB: PostgresQuery,
  clientA: Client,
  clientB: Client,
  clientBBackendPid: number,
  periodStart: string,
) {
  const ids = fixture.unavailableBarrier;
  await createQuoteFixture(queryA, {
    quoteId: ids.quoteId,
    periodStart,
    canonicalSnapshotId: ids.rootSnapshot,
    rawSnapshotIds: [ids.rootSnapshot, ids.newerDecoy],
  });
  const generation = await beginProjectNestedTraversal(
    "quote",
    ids.quoteId,
    transactionFor(clientA, queryA),
  );
  await persistQuoteCostCenter(queryA, {
    quoteId: ids.quoteId,
    costCenterId: ids.currentCostCenter,
    generation,
    configuredCostCenterId: 5,
  });

  await queryA("begin");
  let transactionOpen = true;
  let unavailable: ReturnType<typeof markProjectSourceUnavailable> | null = null;
  try {
    await holdQuoteTraversalBarrier(queryA, ids.quoteId, generation);
    unavailable = markProjectSourceUnavailable("quote", ids.quoteId, {
      expectedGeneration: generation,
      query: queryB,
      transaction: transactionFor(clientB, queryB),
    });
    await waitForLockWait(
      queryA,
      clientBBackendPid,
      "client B source-unavailable finalizer must block behind client A",
    );

    const completed = await finalizeProjectNestedTraversal({
      projectType: "quote",
      projectId: ids.quoteId,
      generation,
      rootSnapshotId: ids.rootSnapshot,
      seen: emptyNestedTraversalSeen(),
      query: queryA,
      transaction: existingTransaction(queryA),
    });
    assert.equal(completed.applied, true, "client A completed finalizer must apply");
    await queryA("commit");
    transactionOpen = false;
  } finally {
    if (transactionOpen) await queryA("rollback").catch(() => undefined);
  }

  assert.ok(unavailable, "the blocked source-unavailable operation must have started");
  const unavailableResult = await unavailable;
  assert.deepEqual(
    unavailableResult,
    { applied: false, affectedPeriods: [] },
    "source-unavailable must return applied:false after the generation completes",
  );

  const visible = await queryA<{
    quote_deleted: boolean;
    child_deleted: boolean;
    quote_snapshot_visible: boolean;
  }>(
    `select
       (select source_deleted_at is not null from metrics.metrics_quotes where quote_id = $1) as quote_deleted,
       (select source_deleted_at is not null from metrics.metrics_quote_cost_centers
         where quote_id = $1 and cost_center_id = $2) as child_deleted,
       exists(select 1 from metrics.quote_snapshots where quote_id = $1) as quote_snapshot_visible`,
    [ids.quoteId, ids.currentCostCenter],
  );
  assert.deepEqual(
    visible.rows[0],
    { quote_deleted: false, child_deleted: false, quote_snapshot_visible: true },
    "losing source-unavailable publication must not tombstone canonical or projected quote state",
  );
  await assertTraversalState(queryA, ids.quoteId, generation, "completed", true);
  await assertRawSnapshotStates(
    queryA,
    [ids.rootSnapshot, ids.newerDecoy],
    [
      rawState(ids.rootSnapshot, true, false),
      rawState(ids.newerDecoy, false, false),
    ],
    "losing source-unavailable publication must not delete raw snapshots or hide exact completion",
  );
}

async function assertAppliedSourceUnavailableDeletesRawSnapshots(
  query: PostgresQuery,
  client: Client,
  periodStart: string,
) {
  const ids = fixture.unavailableApplied;
  await createQuoteFixture(query, {
    quoteId: ids.quoteId,
    periodStart,
    canonicalSnapshotId: ids.rootSnapshot,
    rawSnapshotIds: [ids.rootSnapshot, ids.newerDecoy],
  });
  const generation = await beginProjectNestedTraversal(
    "quote",
    ids.quoteId,
    transactionFor(client, query),
  );
  await persistQuoteCostCenter(query, {
    quoteId: ids.quoteId,
    costCenterId: ids.currentCostCenter,
    generation,
    configuredCostCenterId: 5,
  });

  const unavailable = await markProjectSourceUnavailable("quote", ids.quoteId, {
    expectedGeneration: generation,
    query,
    transaction: transactionFor(client, query),
  });
  assert.deepEqual(
    unavailable,
    { applied: true, affectedPeriods: [{ scope: "quotes", periodStart }] },
    "current source-unavailable publication must apply to the current quote month",
  );

  const tombstones = await query<{
    quote_deleted: boolean;
    child_deleted: boolean;
    quote_snapshot_visible: boolean;
  }>(
    `select
       (select source_deleted_at is not null from metrics.metrics_quotes where quote_id = $1) as quote_deleted,
       (select source_deleted_at is not null from metrics.metrics_quote_cost_centers
         where quote_id = $1 and cost_center_id = $2) as child_deleted,
       exists(select 1 from metrics.quote_snapshots where quote_id = $1) as quote_snapshot_visible`,
    [ids.quoteId, ids.currentCostCenter],
  );
  assert.deepEqual(
    tombstones.rows[0],
    { quote_deleted: true, child_deleted: true, quote_snapshot_visible: false },
    "applied source-unavailable publication must tombstone canonical children and remove the projection",
  );
  await assertTraversalState(query, ids.quoteId, generation, "source_deleted", true);
  await assertRawSnapshotStates(
    query,
    [ids.rootSnapshot, ids.newerDecoy],
    [
      rawState(ids.rootSnapshot, false, true),
      rawState(ids.newerDecoy, false, true),
    ],
    "applied source-unavailable publication must source-delete every raw project snapshot atomically",
  );
}

async function assertLatePublicationFailureRollsBack(
  query: PostgresQuery,
  client: Client,
  periodStart: string,
) {
  const ids = fixture.rollback;
  await createQuoteFixture(query, {
    quoteId: ids.quoteId,
    periodStart,
    canonicalSnapshotId: ids.rootSnapshot,
    rawSnapshotIds: [ids.rootSnapshot, ids.newerDecoy],
  });
  const staleGeneration = await beginProjectNestedTraversal(
    "quote",
    ids.quoteId,
    transactionFor(client, query),
  );
  await persistQuoteCostCenter(query, {
    quoteId: ids.quoteId,
    costCenterId: ids.staleCostCenter,
    generation: staleGeneration,
    configuredCostCenterId: 6,
  });
  const currentGeneration = await beginProjectNestedTraversal(
    "quote",
    ids.quoteId,
    transactionFor(client, query),
  );
  await persistQuoteCostCenter(query, {
    quoteId: ids.quoteId,
    costCenterId: ids.currentCostCenter,
    generation: currentGeneration,
    configuredCostCenterId: 5,
  });

  let cleanupObserved = false;
  let publicationObserved = false;
  const failingQuery: PostgresQuery = async (text, values) => {
    if (text.includes("update metrics.metrics_quote_cost_centers set source_deleted_at")) {
      cleanupObserved = true;
    }
    if (text.includes("insert into metrics.rollup_rebuild_queue")) {
      publicationObserved = true;
      assert.equal(
        cleanupObserved,
        true,
        "the forced rollup failure must occur after stale-child cleanup executes",
      );
      throw new Error(FORCED_ROLLUP_FAILURE);
    }
    return query(text, values);
  };

  await assert.rejects(
    finalizeProjectNestedTraversal({
      projectType: "quote",
      projectId: ids.quoteId,
      generation: currentGeneration,
      rootSnapshotId: ids.rootSnapshot,
      seen: emptyNestedTraversalSeen(),
      query: failingQuery,
      transaction: transactionFor(client, failingQuery),
    }),
    { name: "Error", message: FORCED_ROLLUP_FAILURE },
    "forced rollup publication failure must reject finalization",
  );
  assert.equal(cleanupObserved, true, "finalization must reach stale-child cleanup before failure");
  assert.equal(publicationObserved, true, "finalization must reach late category/rollup publication");

  const children = await query<{
    cost_center_id: string;
    traversal_generation: string;
    source_deleted: boolean;
  }>(
    `select cost_center_id::text, traversal_generation::text,
            source_deleted_at is not null as source_deleted
       from metrics.metrics_quote_cost_centers
      where quote_id = $1
      order by cost_center_id`,
    [ids.quoteId],
  );
  assert.deepEqual(
    children.rows,
    [
      {
        cost_center_id: String(ids.staleCostCenter),
        traversal_generation: "1",
        source_deleted: false,
      },
      {
        cost_center_id: String(ids.currentCostCenter),
        traversal_generation: "2",
        source_deleted: false,
      },
    ],
    "rollup failure must roll stale-child cleanup back",
  );
  await assertTraversalState(query, ids.quoteId, currentGeneration, "active", false);
  await assertRawSnapshotStates(
    query,
    [ids.rootSnapshot, ids.newerDecoy],
    [
      rawState(ids.rootSnapshot, false, false),
      rawState(ids.newerDecoy, false, false),
    ],
    "rollup failure must roll exact root completion back and preserve raw visibility",
  );

  const publication = await query<{
    canonical_category: string;
    canonical_basis: string | null;
    snapshot_category: string | null;
    snapshot_basis: string | null;
    queued_rollups: number;
  }>(
    `select q.category as canonical_category, q.category_basis as canonical_basis,
            s.category as snapshot_category, s.category_basis as snapshot_basis,
            (select count(*)::int from metrics.rollup_rebuild_queue
              where idempotency_key like $2) as queued_rollups
       from metrics.metrics_quotes q
       left join metrics.quote_snapshots s on s.quote_id = q.quote_id
      where q.quote_id = $1`,
    [ids.quoteId, `quote-category-finalization:${ids.quoteId}:%`],
  );
  assert.deepEqual(
    publication.rows[0],
    {
      canonical_category: "Unclassified",
      canonical_basis: null,
      snapshot_category: "Unclassified",
      snapshot_basis: null,
      queued_rollups: 0,
    },
    "rollup failure must roll category publication and its queue entry back",
  );
}

async function assertJobFinalizationRollupsAreAtomic(
  query: PostgresQuery,
  client: Client,
  periodStart: string,
) {
  const ids = fixture.jobFinalization;
  await query(
    `delete from metrics.rollup_rebuild_queue
      where period_start = $1::date
        and metric_family in ('jobs', 'technicians', 'commissions')`,
    [periodStart],
  );
  await query(
    `insert into metrics.raw_simpro_snapshots (
       id, entity_type, entity_id, source_path, source_hash, payload,
       complete_traversal, parent_identity
     ) values (
       $1, 'job_details', $2::text, $3, $4,
       jsonb_build_object('fixtureSnapshotId', $1::bigint), false,
       jsonb_build_object('projectType', 'job', 'projectId', $2::bigint)
     )`,
    [
      ids.rootSnapshot,
      ids.jobId,
      `/migration-test/jobs/${ids.jobId}/${ids.rootSnapshot}`,
      `nested-traversal-concurrency-job-${ids.jobId}`,
    ],
  );
  await query(
    `insert into metrics.metrics_jobs (
       job_id, job_no, completed_date, stage, total, category,
       source_snapshot_id, source_hash, fetched_at
     ) values ($1, $2, $3::date, 'Complete', 100, 'Unclassified', $4, $5, now())`,
    [
      ids.jobId,
      String(ids.jobId),
      periodStart,
      ids.rootSnapshot,
      `nested-traversal-concurrency-job-${ids.jobId}`,
    ],
  );
  await query(
    `insert into metrics.job_snapshots (
       job_id, job_no, name, stage_name, completed_date, sell_value, source_snapshot_id
     ) values ($1, $2, $3, 'Complete', $4::date, 100, $5)`,
    [ids.jobId, String(ids.jobId), `Concurrency job ${ids.jobId}`, periodStart, ids.rootSnapshot],
  );
  const generation = await beginProjectNestedTraversal(
    "job",
    ids.jobId,
    transactionFor(client, query),
  );
  await persistProjectCostCenter({
    projectType: "job",
    projectId: ids.jobId,
    fact: mapCostCenterFact(ids.costCenterId + 1_000_000, {
      ID: ids.costCenterId,
      CostCenter: { ID: 5, Name: "HVAC" },
      Total: { ExTax: 100 },
    }),
    provenance: provenanceFor({ fixture: ids.jobId }, ids.rootSnapshot, null),
    traversalGeneration: generation,
    query,
  });

  const failingQuery: PostgresQuery = async (text, values) => {
    if (text.includes("insert into metrics.rollup_rebuild_queue")) {
      throw new Error(FORCED_ROLLUP_FAILURE);
    }
    return query(text, values);
  };
  await assert.rejects(
    finalizeProjectNestedTraversal({
      projectType: "job",
      projectId: ids.jobId,
      generation,
      rootSnapshotId: ids.rootSnapshot,
      seen: emptyNestedTraversalSeen(),
      query: failingQuery,
      transaction: transactionFor(client, failingQuery),
    }),
    { name: "Error", message: FORCED_ROLLUP_FAILURE },
    "job finalization must reject when related rollup publication fails",
  );

  const rolledBack = await query<{
    category: string;
    complete_traversal: boolean;
    traversal_status: string;
    rollup_count: number;
  }>(
    `select job.category, root.complete_traversal,
            traversal.status as traversal_status,
            (select count(*)::int
               from metrics.rollup_rebuild_queue
              where period_start = $2::date
                and metric_family in ('jobs', 'technicians', 'commissions')) as rollup_count
       from metrics.raw_simpro_snapshots root
       join metrics.metrics_jobs job on job.job_id = $1
       join metrics.project_nested_traversals traversal
         on traversal.project_type = 'job' and traversal.project_id = $1
      where root.id = $3`,
    [ids.jobId, periodStart, ids.rootSnapshot],
  );
  assert.deepEqual(
    rolledBack.rows[0],
    {
      category: "Unclassified",
      complete_traversal: false,
      traversal_status: "active",
      rollup_count: 0,
    },
    "job finalization failure must roll root, traversal, and all queue writes back",
  );

  const completed = await finalizeProjectNestedTraversal({
    projectType: "job",
    projectId: ids.jobId,
    generation,
    rootSnapshotId: ids.rootSnapshot,
    seen: emptyNestedTraversalSeen(),
    query,
    transaction: transactionFor(client, query),
  });
  assert.deepEqual(completed, {
    applied: true,
    affectedPeriods: [
      { scope: "jobs", periodStart },
      { scope: "technicians", periodStart },
      { scope: "commissions", periodStart },
    ],
  });

  const published = await query<{ metric_family: string; status: string }>(
    `select metric_family, status::text
       from metrics.rollup_rebuild_queue
      where period_start = $1::date
        and metric_family in ('jobs', 'technicians', 'commissions')
      order by metric_family`,
    [periodStart],
  );
  assert.deepEqual(published.rows, [
    { metric_family: "commissions", status: "queued" },
    { metric_family: "jobs", status: "queued" },
    { metric_family: "technicians", status: "queued" },
  ]);
}

async function assertStaleCrossProjectScheduleCannotOverwrite(
  queryA: PostgresQuery,
  queryB: PostgresQuery,
  clientA: Client,
  clientB: Client,
  clientBBackendPid: number,
  periodStart: string,
) {
  const ids = fixture.scheduleReassignment;
  const firstGeneration = await beginProjectNestedTraversal(
    "job",
    ids.firstJobId,
    transactionFor(clientA, queryA),
  );
  const staleGeneration = await beginProjectNestedTraversal(
    "job",
    ids.staleJobId,
    transactionFor(clientB, queryB),
  );
  const currentScheduleDate = `${periodStart.slice(0, 7)}-15`;
  const previousMonth = new Date(`${periodStart}T12:00:00Z`);
  previousMonth.setUTCDate(0);
  const previousPeriodStart = `${previousMonth.toISOString().slice(0, 7)}-01`;
  const previousScheduleDate = `${previousPeriodStart.slice(0, 7)}-15`;
  const newerPayload = schedulePayload({
    scheduleId: ids.scheduleId,
    jobId: ids.firstJobId,
    scheduleDate: previousScheduleDate,
    sourceModifiedAt: "2089-01-01T12:00:00Z",
    hours: 4,
    staffId: ids.firstStaffId,
  });
  const olderPayload = schedulePayload({
    scheduleId: ids.scheduleId,
    jobId: ids.staleJobId,
    scheduleDate: previousScheduleDate,
    sourceModifiedAt: "2088-01-01T11:00:00Z",
    hours: 2,
    staffId: ids.staleStaffId,
  });

  let transactionOpen = true;
  await queryA("begin");
  try {
    const newer = await publishScheduleFixture({
      query: queryA,
      transaction: existingTransaction(queryA),
      projectId: ids.firstJobId,
      generation: firstGeneration,
      payload: newerPayload,
    });
    assert.equal(newer.applied, true);
    assert.equal(newer.value?.normalization.normalized, true);

    const stalePublication = publishScheduleFixture({
      query: queryB,
      transaction: transactionFor(clientB, queryB),
      projectId: ids.staleJobId,
      generation: staleGeneration,
      payload: olderPayload,
    });
    await waitForLockWait(
      queryA,
      clientBBackendPid,
      "the stale cross-project schedule must wait on the schedule advisory lock",
    );
    await queryA("commit");
    transactionOpen = false;

    const stale = await stalePublication;
    assert.equal(stale.applied, true);
    assert.equal(
      stale.value?.normalization.normalized,
      false,
      "older source evidence must not overwrite a reassigned global schedule",
    );
  } finally {
    if (transactionOpen) await queryA("rollback").catch(() => undefined);
  }

  const published = await queryA<{
    reference_id: string;
    total_hours: number;
    snapshot_project_id: string;
    block_hours: number;
    staff_id: string;
    stale_staff_exists: boolean;
  }>(
    `select schedule.reference_id::text, schedule.total_hours::double precision,
            snapshot.project_id as snapshot_project_id,
            block.planned_hours::double precision as block_hours,
            person.simpro_employee_id::text as staff_id,
            exists(select 1 from metrics.dim_people
                    where simpro_employee_id = $2) as stale_staff_exists
       from metrics.metrics_schedules schedule
       join metrics.schedule_snapshots snapshot using (schedule_id)
       join metrics.metrics_schedule_blocks block using (schedule_id)
       join metrics.dim_people person on person.person_id = schedule.staff_person_id
      where schedule.schedule_id = $1 and block.block_index = 0`,
    [ids.scheduleId, ids.staleStaffId],
  );
  assert.deepEqual(
    published.rows[0],
    {
      reference_id: String(ids.firstJobId),
      total_hours: 4,
      snapshot_project_id: String(ids.firstJobId),
      block_hours: 4,
      staff_id: String(ids.firstStaffId),
      stale_staff_exists: false,
    },
    "raw/canonical/snapshot/block publication must retain the newer reassignment",
  );

  let reassignmentTransactionOpen = true;
  const missingHash = `stale-schedule-404-${ids.scheduleId}`;
  await queryA("begin");
  try {
    const reassigned = await publishScheduleFixture({
      query: queryA,
      transaction: existingTransaction(queryA),
      projectId: ids.staleJobId,
      generation: staleGeneration,
      payload: schedulePayload({
        scheduleId: ids.scheduleId,
        jobId: ids.staleJobId,
        scheduleDate: currentScheduleDate,
        sourceModifiedAt: "2090-01-01T12:00:00Z",
        hours: 6,
        staffId: ids.staleStaffId,
      }),
    });
    assert.deepEqual(reassigned.value?.affectedPeriods, [
      { scope: "technicians", periodStart: previousPeriodStart },
      { scope: "technicians", periodStart },
    ]);

    const staleMissing = markScheduleSourceUnavailable(ids.scheduleId, {
      observedAt: "2000-01-01T00:00:00Z",
      tombstoneSnapshot: scheduleTombstoneSnapshot(ids.scheduleId, missingHash),
      query: queryB,
      transaction: transactionFor(clientB, queryB),
    });
    await waitForLockWait(
      queryA,
      clientBBackendPid,
      "the stale schedule 404 must wait on the schedule advisory lock",
    );
    await queryA("commit");
    reassignmentTransactionOpen = false;
    const staleMissingResult = await staleMissing;
    assert.equal(staleMissingResult.applied, false);
  } finally {
    if (reassignmentTransactionOpen) await queryA("rollback").catch(() => undefined);
  }

  const staleRaw = await queryA<{ count: number }>(
    "select count(*)::int as count from metrics.raw_simpro_snapshots where source_hash = $1",
    [missingHash],
  );
  assert.equal(staleRaw.rows[0]?.count, 0, "a stale 404 must leave no tombstone raw evidence");
  const staleScheduleHash = `schedule-${ids.staleJobId}-${staleGeneration}-2088-01-01T11:00:00Z`;
  const staleScheduleRaw = await queryA<{ count: number }>(
    "select count(*)::int as count from metrics.raw_simpro_snapshots where source_hash = $1",
    [staleScheduleHash],
  );
  assert.equal(staleScheduleRaw.rows[0]?.count, 0, "a stale reassignment must leave no raw evidence");
  const queuedMonths = await queryA<{ period_start: string }>(
    `select period_start::text
       from metrics.rollup_rebuild_queue
      where metric_family = 'technicians'
        and period_start = any($1::date[])
      order by period_start`,
    [[previousPeriodStart, periodStart]],
  );
  assert.deepEqual(queuedMonths.rows, [
    { period_start: previousPeriodStart },
    { period_start: periodStart },
  ]);

  const rollbackMissingHash = `rollback-schedule-404-${ids.scheduleId}`;
  const beforeRollback = await schedulePublicationState(queryA, ids.scheduleId);
  const failingQuery: PostgresQuery = async (text, values) => {
    if (text.includes("insert into metrics.rollup_rebuild_queue")) {
      throw new Error("forced schedule 404 rollup failure");
    }
    return queryA(text, values);
  };
  await assert.rejects(
    markScheduleSourceUnavailable(ids.scheduleId, {
      observedAt: "2091-01-01T00:00:00Z",
      tombstoneSnapshot: scheduleTombstoneSnapshot(ids.scheduleId, rollbackMissingHash),
      query: failingQuery,
      transaction: transactionFor(clientA, failingQuery),
    }),
    /forced schedule 404 rollup failure/,
  );
  assert.deepEqual(
    await schedulePublicationState(queryA, ids.scheduleId),
    beforeRollback,
    "schedule 404 evidence, canonical state, blocks, snapshot, and queues must roll back together",
  );
  const rollbackRaw = await queryA<{ count: number }>(
    "select count(*)::int as count from metrics.raw_simpro_snapshots where source_hash = $1",
    [rollbackMissingHash],
  );
  assert.equal(rollbackRaw.rows[0]?.count, 0);

  const deleted = await markScheduleSourceUnavailable(ids.scheduleId, {
    observedAt: "2092-01-01T00:00:00Z",
    tombstoneSnapshot: scheduleTombstoneSnapshot(ids.scheduleId, `applied-schedule-404-${ids.scheduleId}`),
    query: queryA,
    transaction: transactionFor(clientA, queryA),
  });
  assert.equal(deleted.applied, true);
  assert.deepEqual(deleted.affectedPeriods, [{ scope: "technicians", periodStart }]);
  assert.deepEqual(await schedulePublicationState(queryA, ids.scheduleId), {
    schedule_deleted: true,
    snapshot_count: 0,
    active_block_count: 0,
    active_raw_count: 0,
  });

  const rollbackScheduleId = ids.scheduleId + 1;
  const rollbackHash = `schedule-rollback-${rollbackScheduleId}`;
  const rollbackPayload = schedulePayload({
    scheduleId: rollbackScheduleId,
    jobId: ids.firstJobId,
    scheduleDate: currentScheduleDate,
    sourceModifiedAt: "2093-01-01T13:00:00Z",
    hours: 3,
    staffId: ids.rollbackStaffId,
  });
  await assert.rejects(
    withCurrentProjectNestedTraversal({
      projectType: "job",
      projectId: ids.firstJobId,
      generation: firstGeneration,
      transaction: transactionFor(clientA, queryA),
      callback: async (query) => {
        const snapshot = await writeRawSnapshot({
          entityType: "job_schedule_detail",
          entityId: `${ids.firstJobId}:${rollbackScheduleId}`,
          sourcePath: `/jobs/${ids.firstJobId}/schedules/${rollbackScheduleId}`,
          payload: rollbackPayload,
          sourceHash: rollbackHash,
          parentIdentity: { projectType: "job", projectId: ids.firstJobId },
        }, query);
        const fetchedAt = snapshotTimestamp(snapshot.extracted_at);
        const normalization = await normalizeSimproSnapshot({
          entity: "schedules",
          entityId: String(rollbackScheduleId),
          payload: rollbackPayload,
          sourceSnapshotId: snapshot.id,
          sourceHash: rollbackHash,
          fetchedAt,
          traversalGeneration: firstGeneration,
          query,
        });
        assert.equal(normalization.normalized, true);
        const failingBlockQuery: PostgresQuery = async (text, values) => {
          if (text.includes("insert into metrics.metrics_schedule_blocks")) {
            throw new Error("forced schedule block publication failure");
          }
          return query(text, values);
        };
        await persistScheduleBlocks({
          scheduleId: rollbackScheduleId,
          payload: rollbackPayload,
          provenance: { sourceSnapshotId: snapshot.id, sourceHash: rollbackHash, fetchedAt },
          referenceType: "job",
          referenceId: ids.firstJobId,
          traversalGeneration: firstGeneration,
          query: failingBlockQuery,
        });
      },
    }),
    /forced schedule block publication failure/,
  );
  const rolledBack = await queryA<{
    raw_count: number;
    schedule_count: number;
    snapshot_count: number;
    block_count: number;
    person_count: number;
  }>(
    `select
       (select count(*)::int from metrics.raw_simpro_snapshots where source_hash = $1) as raw_count,
       (select count(*)::int from metrics.metrics_schedules where schedule_id = $2) as schedule_count,
       (select count(*)::int from metrics.schedule_snapshots where schedule_id = $2) as snapshot_count,
       (select count(*)::int from metrics.metrics_schedule_blocks where schedule_id = $2) as block_count,
       (select count(*)::int from metrics.dim_people where simpro_employee_id = $3) as person_count`,
    [rollbackHash, rollbackScheduleId, ids.rollbackStaffId],
  );
  assert.deepEqual(
    rolledBack.rows[0],
    { raw_count: 0, schedule_count: 0, snapshot_count: 0, block_count: 0, person_count: 0 },
    "schedule raw/canonical/snapshot/person/block publication must roll back as one unit",
  );
}

async function assertIdenticalHashResurrectionFinalizes(
  query: PostgresQuery,
  client: Client,
  periodStart: string,
) {
  const quoteId = fixture.rawResurrection.quoteId;
  const payload = {
    ID: quoteId,
    QuoteNo: `RESURRECT-${quoteId}`,
    Stage: "Pending",
    DateIssued: periodStart,
    Total: { ExTax: 0 },
  };
  const rawHash = `identical-hash-resurrection-${quoteId}`;
  const firstGeneration = await beginProjectNestedTraversal(
    "quote",
    quoteId,
    transactionFor(client, query),
  );
  const first = await withCurrentProjectNestedTraversal({
    projectType: "quote",
    projectId: quoteId,
    generation: firstGeneration,
    transaction: transactionFor(client, query),
    callback: async (transactionQuery) => {
      const snapshot = await writeRawSnapshot({
        entityType: "quote_details",
        entityId: String(quoteId),
        sourcePath: `/quotes/${quoteId}`,
        payload,
        sourceHash: rawHash,
        parentIdentity: { projectType: "quote", projectId: quoteId, generation: 1 },
        completeTraversal: false,
      }, transactionQuery);
      await normalizeSimproSnapshot({
        entity: "quotes",
        entityId: String(quoteId),
        payload,
        sourceSnapshotId: snapshot.id,
        sourceHash: rawHash,
        fetchedAt: snapshotTimestamp(snapshot.extracted_at),
        query: transactionQuery,
      });
      return snapshot;
    },
  });
  assert.equal(first.applied, true);
  assert.ok(first.value?.id);

  const deleted = await markProjectSourceUnavailable("quote", quoteId, {
    expectedGeneration: firstGeneration,
    tombstoneSnapshot: {
      entityType: "quote_details",
      entityId: String(quoteId),
      sourcePath: `/quotes/${quoteId}`,
      payload: { sourceUnavailable: true, status: 404, projectType: "quote", projectId: quoteId },
      sourceHash: `resurrection-tombstone-${quoteId}`,
      parentIdentity: { projectType: "quote", projectId: quoteId },
    },
    query,
    transaction: transactionFor(client, query),
  });
  assert.equal(deleted.applied, true);

  const secondGeneration = await beginProjectNestedTraversal(
    "quote",
    quoteId,
    transactionFor(client, query),
  );
  const second = await withCurrentProjectNestedTraversal({
    projectType: "quote",
    projectId: quoteId,
    generation: secondGeneration,
    transaction: transactionFor(client, query),
    callback: async (transactionQuery) => {
      const snapshot = await writeRawSnapshot({
        entityType: "quote_details",
        entityId: String(quoteId),
        sourcePath: `/quotes/${quoteId}?reappeared=true`,
        payload,
        sourceHash: rawHash,
        parentIdentity: { projectType: "quote", projectId: quoteId, generation: 2 },
        pageWindow: { source: "identical_reappearance" },
        completeTraversal: false,
      }, transactionQuery);
      await normalizeSimproSnapshot({
        entity: "quotes",
        entityId: String(quoteId),
        payload,
        sourceSnapshotId: snapshot.id,
        sourceHash: rawHash,
        fetchedAt: snapshotTimestamp(snapshot.extracted_at),
        query: transactionQuery,
      });
      await persistQuoteCostCenter(transactionQuery, {
        quoteId,
        costCenterId: quoteId + 100,
        generation: secondGeneration,
        configuredCostCenterId: 7,
      });
      return snapshot;
    },
  });
  assert.equal(second.applied, true);
  assert.equal(second.value?.id, first.value?.id, "identical reappearance must reactivate the existing raw identity");
  assert.equal(second.value?.inserted, true, "reactivation is a persisted raw write");

  const finalized = await finalizeProjectNestedTraversal({
    projectType: "quote",
    projectId: quoteId,
    generation: secondGeneration,
    rootSnapshotId: second.value!.id,
    seen: emptyNestedTraversalSeen(),
    query,
    transaction: transactionFor(client, query),
  });
  assert.equal(finalized.applied, true);
  const active = await query<{
    source_deleted: boolean;
    complete_traversal: boolean;
    source_path: string;
    parent_generation: string;
    page_source: string;
  }>(
    `select source_deleted_at is not null as source_deleted,
            complete_traversal, source_path,
            parent_identity->>'generation' as parent_generation,
            page_window->>'source' as page_source
       from metrics.raw_simpro_snapshots
      where entity_type = 'quote_details' and entity_id = $1::text and source_hash = $2`,
    [quoteId, rawHash],
  );
  assert.deepEqual(active.rows[0], {
    source_deleted: false,
    complete_traversal: true,
    source_path: `/quotes/${quoteId}?reappeared=true`,
    parent_generation: "2",
    page_source: "identical_reappearance",
  });
}

async function assertQuoteClassificationLockPrecedesJobMutation(
  queryA: PostgresQuery,
  queryB: PostgresQuery,
  clientB: Client,
  clientBBackendPid: number,
  periodStart: string,
) {
  const ids = fixture.lockOrder;
  await createQuoteFixture(queryA, {
    quoteId: ids.quoteId,
    periodStart,
    canonicalSnapshotId: ids.rootSnapshot,
    rawSnapshotIds: [ids.rootSnapshot],
  });
  await queryA(
    `insert into metrics.metrics_jobs (job_id, job_no, total, stage, completed_date)
     values ($1, $2, 100, 'Complete', $3::date)`,
    [ids.jobId, String(ids.jobId), periodStart],
  );

  let transactionOpen = true;
  await queryA("begin");
  try {
    await acquireQuoteClassificationAdvisoryLock(queryA);
    await queryA(
      "select quote_id from metrics.metrics_quotes where quote_id = $1 for update",
      [ids.quoteId],
    );

    const jobPayload = {
      ID: ids.jobId,
      JobNo: String(ids.jobId),
      Stage: "Complete",
      CompletedDate: periodStart,
      Total: { ExTax: 100 },
      Totals: {},
      ConvertedFrom: { Type: "Quote", ID: ids.quoteId },
    };
    const jobNormalization = transactionFor(clientB, queryB)(async (query) => {
      const sourceHash = `conversion-lock-source-${ids.jobId}`;
      const source = await writeRawSnapshot({
        entityType: "job_details",
        entityId: String(ids.jobId),
        sourcePath: `/migration-test/jobs/${ids.jobId}/conversion-lock`,
        payload: jobPayload,
        sourceHash,
        completeTraversal: true,
        parentIdentity: { projectType: "job", projectId: ids.jobId },
      }, query);
      return normalizeSimproSnapshot({
        entity: "jobs",
        entityId: String(ids.jobId),
        payload: jobPayload,
        sourceSnapshotId: source.id,
        sourceHash,
        fetchedAt: snapshotTimestamp(source.extracted_at),
        query,
      });
    });
    await waitForLockWait(
      queryA,
      clientBBackendPid,
      "job normalization must wait for classification authority before touching the job row",
    );

    const jobLock = await queryA(
      "select job_id from metrics.metrics_jobs where job_id = $1 for update",
      [ids.jobId],
    );
    assert.equal(jobLock.rowCount, 1, "the repair transaction must acquire the job row without deadlock");
    await queryA("commit");
    transactionOpen = false;

    const normalized = await jobNormalization;
    assert.equal(normalized.normalized, true);
  } finally {
    if (transactionOpen) await queryA("rollback").catch(() => undefined);
  }

  const relation = await queryA<{
    converted_from_id: string;
    quote_outcome: string;
  }>(
    `select job.converted_from_id::text,
            quote.outcome as quote_outcome
       from metrics.metrics_jobs job
       join metrics.metrics_quotes quote on quote.quote_id = $2
      where job.job_id = $1`,
    [ids.jobId, ids.quoteId],
  );
  assert.deepEqual(
    relation.rows[0],
    {
      converted_from_id: String(ids.quoteId),
      quote_outcome: "won",
    },
    "job conversion evidence must publish after the serialized lock handoff",
  );
}

async function assertNewerQuoteIngestionPrecedesReinstatement(
  queryA: PostgresQuery,
  queryB: PostgresQuery,
  clientB: Client,
  clientBBackendPid: number,
  periodStart: string,
) {
  const ids = fixture.overrideHandoff;
  await createQuoteFixture(queryA, {
    quoteId: ids.quoteId,
    periodStart,
    canonicalSnapshotId: ids.rootSnapshot,
    rawSnapshotIds: [ids.rootSnapshot],
  });
  await queryA(
    "update metrics.raw_simpro_snapshots set complete_traversal = true where id = $1",
    [ids.rootSnapshot],
  );
  const exclusion = await persistQuoteOverrideAction({
    quoteId: ids.quoteId,
    action: "exclude",
    expectedActiveExclusionRevision: 0,
    idempotencyKey: `concurrency-exclude-${ids.quoteId}`,
    reason: "Concurrency fixture owner exclusion.",
    actorEmail: "owner@prostarmechanical.com",
  }, queryA);
  assert.equal(exclusion.revision, 1);

  const acceptedPayload = {
    ID: ids.quoteId,
    QuoteNo: `CONCURRENCY-${ids.quoteId}`,
    DateIssued: periodStart,
    DateApproved: periodStart,
    Stage: "Complete",
    Status: { Name: " Quote Accepted Online " },
    Total: { ExTax: 100 },
  };
  const acceptedSourceHash = `accepted-source-${ids.quoteId}`;
  let ingestionOpen = true;
  await queryA("begin");
  try {
    await acquireQuoteClassificationAdvisoryLock(queryA);
    const source = await writeRawSnapshot({
      entityType: "quote_details",
      entityId: String(ids.quoteId),
      sourcePath: `/migration-test/quotes/${ids.quoteId}/accepted`,
      payload: acceptedPayload,
      sourceHash: acceptedSourceHash,
      completeTraversal: true,
      parentIdentity: { projectType: "quote", projectId: ids.quoteId },
    }, queryA);
    await normalizeSimproSnapshot({
      entity: "quotes",
      entityId: String(ids.quoteId),
      payload: acceptedPayload,
      sourceSnapshotId: source.id,
      sourceHash: acceptedSourceHash,
      fetchedAt: snapshotTimestamp(source.extracted_at),
      query: queryA,
    });

    const reinstatement = transactionFor(clientB, queryB)((query) => persistQuoteOverrideAction({
      quoteId: ids.quoteId,
      action: "reinstate",
      expectedActiveExclusionRevision: 1,
      idempotencyKey: `concurrency-reinstate-${ids.quoteId}`,
      reason: "Concurrency fixture owner reinstatement.",
      actorEmail: "owner@prostarmechanical.com",
    }, query));
    await waitForLockWait(
      queryA,
      clientBBackendPid,
      "quote reinstatement must wait for newer source ingestion on the global classification lock",
    );
    await queryA("commit");
    ingestionOpen = false;

    const restored = await reinstatement;
    assert.equal(restored.outcome, "manual_reinstated");
    assert.equal(restored.revision, 2);
  } finally {
    if (ingestionOpen) await queryA("rollback").catch(() => undefined);
  }

  const final = await queryA<{
    status_name: string;
    outcome: string;
    outcome_reason: string;
    active_exclusions: number;
  }>(
    `select q.status_name, q.outcome, q.outcome_reason,
            (select count(*)::int from metrics.quote_classification_overrides o
              where o.quote_id = q.quote_id and o.active and o.outcome = 'excluded') as active_exclusions
       from metrics.metrics_quotes q
      where q.quote_id = $1`,
    [ids.quoteId],
  );
  assert.deepEqual(final.rows[0], {
    status_name: "Quote Accepted Online",
    outcome: "won",
    outcome_reason: "accepted_online",
    active_exclusions: 0,
  }, "the waiting action must classify from committed newer source evidence without deadlock");
}

async function publishScheduleFixture(params: {
  query: PostgresQuery;
  transaction: NestedFinalizationTransaction;
  projectId: number;
  generation: number;
  payload: Record<string, unknown>;
}) {
  return withCurrentProjectNestedTraversal({
    projectType: "job",
    projectId: params.projectId,
    generation: params.generation,
    transaction: params.transaction,
    callback: async (query) => {
      const scheduleId = Number(params.payload.ID);
      const fetchedAt = new Date().toISOString();
      const hash = `schedule-${params.projectId}-${params.generation}-${String(params.payload.DateModified)}`;
      const authority = await acquireSchedulePublicationAuthority({
        entityId: String(scheduleId),
        payload: params.payload,
        fetchedAt,
        query,
      });
      if (!authority.applied) {
        return {
          hash,
          snapshot: null,
          normalization: { entity: "schedules" as const, normalized: false, affectedPeriods: [] },
          affectedPeriods: [],
        };
      }
      const snapshot = await writeRawSnapshot({
        entityType: "job_schedule_detail",
        entityId: `${params.projectId}:${scheduleId}`,
        sourcePath: `/jobs/${params.projectId}/schedules/${scheduleId}`,
        payload: params.payload,
        sourceHash: hash,
        sourceUpdatedAt: String(params.payload.DateModified),
        parentIdentity: { projectType: "job", projectId: params.projectId, scheduleId },
      }, query);
      const normalization = await normalizeSimproSnapshot({
        entity: "schedules",
        entityId: String(scheduleId),
        payload: params.payload,
        sourceSnapshotId: snapshot.id,
        sourceHash: hash,
        fetchedAt,
        traversalGeneration: params.generation,
        query,
      });
      if (normalization.normalized) {
        await persistScheduleBlocks({
          scheduleId,
          payload: params.payload,
          provenance: { sourceSnapshotId: snapshot.id, sourceHash: hash, fetchedAt },
          referenceType: "job",
          referenceId: params.projectId,
          traversalGeneration: params.generation,
          query,
        });
      }
      const currentPeriods = await activeScheduleTechnicianPeriods(scheduleId, query);
      const affectedPeriods = [...new Map(
        [...authority.affectedPeriods, ...currentPeriods]
          .map((period) => [`${period.scope}:${period.periodStart}`, period]),
      ).values()];
      await enqueueAffectedRollups(affectedPeriods, `schedule ${scheduleId} concurrency fixture`, query);
      return { hash, snapshot, normalization, affectedPeriods };
    },
  });
}

function schedulePayload(params: {
  scheduleId: number;
  jobId: number;
  scheduleDate: string;
  sourceModifiedAt: string;
  hours: number;
  staffId: number;
}): Record<string, unknown> {
  return {
    ID: params.scheduleId,
    Type: "job",
    Reference: `${params.jobId}-1`,
    Date: params.scheduleDate,
    DateModified: params.sourceModifiedAt,
    TotalHours: params.hours,
    Staff: { ID: params.staffId, Name: `Employee ${params.staffId}` },
    Blocks: [{ Hrs: params.hours, StartTime: "08:30", EndTime: "12:30" }],
  };
}

function scheduleTombstoneSnapshot(scheduleId: number, hash: string) {
  return {
    entityType: "schedule_details",
    entityId: String(scheduleId),
    sourcePath: `/schedules/${scheduleId}`,
    payload: { sourceUnavailable: true, status: 404, scheduleId },
    sourceHash: hash,
    parentIdentity: { scheduleId },
  };
}

async function schedulePublicationState(query: PostgresQuery, scheduleId: number) {
  const result = await query<{
    schedule_deleted: boolean;
    snapshot_count: number;
    active_block_count: number;
    active_raw_count: number;
  }>(
    `select
       coalesce((select source_deleted_at is not null
                   from metrics.metrics_schedules where schedule_id = $1), false) as schedule_deleted,
       (select count(*)::int from metrics.schedule_snapshots where schedule_id = $1) as snapshot_count,
       (select count(*)::int from metrics.metrics_schedule_blocks
         where schedule_id = $1 and source_deleted_at is null) as active_block_count,
       (select count(*)::int from metrics.raw_simpro_snapshots
         where parent_identity->>'scheduleId' = $1::text and source_deleted_at is null) as active_raw_count`,
    [scheduleId],
  );
  return result.rows[0];
}

async function createQuoteFixture(
  query: PostgresQuery,
  params: {
    quoteId: number;
    periodStart: string;
    canonicalSnapshotId: number;
    rawSnapshotIds: readonly number[];
  },
) {
  for (let index = 0; index < params.rawSnapshotIds.length; index += 1) {
    const snapshotId = params.rawSnapshotIds[index];
    await query(
      `insert into metrics.raw_simpro_snapshots (
         id, entity_type, entity_id, source_path, source_hash, extracted_at,
         payload, complete_traversal, parent_identity
       ) values (
         $1, 'quote_details', $2::text, $3, $4,
         now() + ($5::int * interval '1 second'),
         jsonb_build_object('fixtureSnapshotId', $1::bigint), false,
         jsonb_build_object('quoteId', $2::bigint)
       )`,
      [
        snapshotId,
        params.quoteId,
        `/migration-test/quotes/${params.quoteId}/${snapshotId}`,
        `nested-traversal-concurrency-${snapshotId}`,
        index,
      ],
    );
  }

  await query(
    `insert into metrics.metrics_quotes (
       quote_id, quote_no, date_issued, date_approved, total, won_reason,
       category, category_basis, source_snapshot_id, source_hash, fetched_at
     ) values (
       $1, $2, $3::date, $3::date, 100, 'not_won',
       'Unclassified', null, $4, $5, now()
     )`,
    [
      params.quoteId,
      `CONCURRENCY-${params.quoteId}`,
      params.periodStart,
      params.canonicalSnapshotId,
      `nested-traversal-concurrency-quote-${params.quoteId}`,
    ],
  );
  await query(
    `insert into metrics.quote_snapshots (
       quote_id, quote_no, date_issued, date_approved, total_value,
       category, category_basis, source_snapshot_id
     ) values ($1, $2, $3::date, $3::date, 100, 'Unclassified', null, $4)`,
    [
      params.quoteId,
      `CONCURRENCY-${params.quoteId}`,
      params.periodStart,
      params.canonicalSnapshotId,
    ],
  );
}

async function persistQuoteCostCenter(
  query: PostgresQuery,
  params: {
    quoteId: number;
    costCenterId: number;
    generation: number;
    configuredCostCenterId: number;
  },
) {
  const sectionId = params.costCenterId + 1_000_000;
  const fact = mapCostCenterFact(sectionId, {
    ID: params.costCenterId,
    CostCenter: {
      ID: params.configuredCostCenterId,
      Name: `Configured ${params.configuredCostCenterId}`,
    },
    Name: `Concurrency cost center ${params.costCenterId}`,
    Total: { ExTax: 100 },
  });
  await persistProjectCostCenter({
    projectType: "quote",
    projectId: params.quoteId,
    fact,
    provenance: provenanceFor(
      { quoteId: params.quoteId, costCenterId: params.costCenterId, generation: params.generation },
      null,
      null,
    ),
    traversalGeneration: params.generation,
    query,
  });
}

async function holdQuoteTraversalBarrier(
  query: PostgresQuery,
  quoteId: number,
  generation: number,
) {
  await acquireQuoteClassificationAdvisoryLock(query);
  await acquireQuoteCategoryAdvisoryLock(query);
  const traversal = await query(
    `select generation
       from metrics.project_nested_traversals
      where project_type = 'quote' and project_id = $1
        and generation = $2 and status = 'active'
      for update`,
    [quoteId, generation],
  );
  assert.equal(
    traversal.rowCount,
    1,
    "client A must hold the current traversal row before starting client B",
  );
}

async function waitForLockWait(
  observer: PostgresQuery,
  backendPid: number,
  assertionMessage: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const activity = await observer<{
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      "select wait_event_type, wait_event from pg_stat_activity where pid = $1",
      [backendPid],
    );
    if (
      activity.rows[0]?.wait_event_type === "Lock"
      && activity.rows[0]?.wait_event === "advisory"
    ) return;
    await delay(20);
  }
  assert.fail(assertionMessage);
}

async function assertCostCenterAbsent(
  query: PostgresQuery,
  quoteId: number,
  costCenterId: number,
  message: string,
) {
  const result = await query<{ count: number }>(
    `select count(*)::int as count
       from metrics.metrics_quote_cost_centers
      where quote_id = $1 and cost_center_id = $2`,
    [quoteId, costCenterId],
  );
  assert.equal(result.rows[0]?.count, 0, message);
}

async function assertTraversalState(
  query: PostgresQuery,
  quoteId: number,
  generation: number,
  status: "active" | "completed" | "source_deleted",
  finalized: boolean,
) {
  const result = await query<{
    generation: string;
    status: string;
    finalized: boolean;
  }>(
    `select generation::text, status, finalized_at is not null as finalized
       from metrics.project_nested_traversals
      where project_type = 'quote' and project_id = $1`,
    [quoteId],
  );
  assert.deepEqual(
    result.rows[0],
    { generation: String(generation), status, finalized },
    `quote ${quoteId} traversal must remain generation ${generation} in ${status} state`,
  );
}

function rawState(id: number, complete: boolean, sourceDeleted: boolean) {
  return { id: String(id), complete_traversal: complete, source_deleted: sourceDeleted };
}

async function assertRawSnapshotStates(
  query: PostgresQuery,
  snapshotIds: readonly number[],
  expected: ReturnType<typeof rawState>[],
  message: string,
) {
  const result = await query<ReturnType<typeof rawState>>(
    `select id::text, complete_traversal,
            source_deleted_at is not null as source_deleted
       from metrics.raw_simpro_snapshots
      where id = any($1::bigint[])
      order by id`,
    [snapshotIds],
  );
  assert.deepEqual(result.rows, expected, message);
}

function bindQuery(client: Client): PostgresQuery {
  return async <T = Record<string, unknown>>(text: string, values?: unknown[]) => {
    const result = await client.query(text, values);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  };
}

function transactionFor(
  client: Client,
  query: PostgresQuery,
): NestedFinalizationTransaction {
  return async <T>(callback: (transactionQuery: PostgresQuery) => Promise<T>) => {
    await client.query("begin");
    try {
      const result = await callback(query);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  };
}

function existingTransaction(query: PostgresQuery): NestedFinalizationTransaction {
  return <T>(callback: (transactionQuery: PostgresQuery) => Promise<T>) => callback(query);
}

void main();
