import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  flattenBulkEmployees,
  flattenBulkMobileStatus,
  flattenBulkSchedules,
  flattenBulkTimesheets,
  type BulkEmployeeRow,
  type BulkMobileStatusRow,
  type BulkScheduleBlockRow,
  type BulkScheduleRow,
  type BulkTimesheetRow,
} from "@/lib/simpro/bulk-operational-export";

export type OperationalFamily =
  | "employees"
  | "timesheets"
  | "schedules"
  | "mobile_status";

export type OperationalBootstrapQueryClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

type OperationalSourceManifest = {
  family: OperationalFamily;
  file: string;
  sha256: string;
  rowCount: number;
  requestCount: number;
  exactIds: Array<number | string>;
  complete?: boolean;
  detailsComplete?: boolean;
  targetCount?: number;
  completedTargetCount?: number;
  detailTargetCount?: number;
  completedDetailTargetCount?: number;
  perMonthIds?: Record<string, string[]>;
  targets?: Array<Record<string, unknown>>;
  pages?: Array<Record<string, unknown>>;
};

export type OperationalBootstrapManifest = {
  version: 1;
  source: string;
  companyId: string;
  startDate: string;
  asOfDate: string;
  timezone: string;
  startedAt: string;
  completedAt: string;
  requestsUsed: number;
  sources: OperationalSourceManifest[];
};

export type VerifiedOperationalSource = Readonly<
  Omit<OperationalSourceManifest, "exactIds" | "perMonthIds" | "targets" | "pages"> & {
    exactIds: readonly (number | string)[];
    perMonthIds?: Readonly<Record<string, readonly string[]>>;
    targets?: readonly Readonly<Record<string, unknown>>[];
    pages?: readonly Readonly<Record<string, unknown>>[];
    rows: readonly Readonly<Record<string, unknown>>[];
  }
>;

export type VerifiedOperationalArtifact = Readonly<{
  directory: string;
  manifestSha256: string;
  manifest: Readonly<OperationalBootstrapManifest>;
  sources: Readonly<Record<OperationalFamily, VerifiedOperationalSource>>;
}>;

export type OperationalArtifactVerificationOptions = {
  afterSourceBytesRead?: (source: { family: OperationalFamily; filePath: string }) => void | Promise<void>;
};

export type OperationalBootstrapResult = {
  manifestSha256: string;
  imported: Record<OperationalFamily, number>;
  tombstoned: Record<OperationalFamily, number>;
  rollupsQueued: number;
  canonicalCounts: Record<string, number>;
};

type BootstrapRun = {
  family: OperationalFamily;
  jobId: number;
  runId: number;
  requestCount: number;
  rowCount: number;
};

type ImportEntry<T> = {
  payload: Record<string, unknown>;
  fact: T;
};

const EXPECTED_FAMILIES: OperationalFamily[] = [
  "employees",
  "timesheets",
  "schedules",
  "mobile_status",
];
const BATCH_SIZE = 500;
const verifiedArtifacts = new WeakSet<VerifiedOperationalArtifact>();

export async function verifyOperationalBulkArtifact(
  directory: string,
  options: OperationalArtifactVerificationOptions = {},
): Promise<VerifiedOperationalArtifact> {
  const resolvedDirectory = path.resolve(directory);
  const manifestText = await readFile(path.join(resolvedDirectory, "manifest.json"), "utf8");
  const expectedManifestHash = parseChecksumFile(
    await readFile(path.join(resolvedDirectory, "manifest.sha256"), "utf8"),
    "manifest.json",
  );
  const manifestSha256 = sha256(manifestText);
  if (manifestSha256 !== expectedManifestHash) {
    throw new Error(`Operational manifest checksum mismatch: expected ${expectedManifestHash}, received ${manifestSha256}`);
  }

  const manifest = JSON.parse(manifestText) as OperationalBootstrapManifest;
  assertManifestContract(manifest);
  const sources = {} as Record<OperationalFamily, VerifiedOperationalSource>;
  for (const source of manifest.sources) {
    sources[source.family] = await verifySourceArtifact(resolvedDirectory, manifest, source, options);
  }
  const verifiedManifest: OperationalBootstrapManifest = {
    ...manifest,
    sources: manifest.sources.map((source) => manifestSourceFromVerified(sources[source.family])),
  };
  const artifact = deepFreeze({
    directory: resolvedDirectory,
    manifestSha256,
    manifest: verifiedManifest,
    sources,
  }) as VerifiedOperationalArtifact;
  verifiedArtifacts.add(artifact);
  return artifact;
}

export async function importVerifiedOperationalArtifact(
  client: OperationalBootstrapQueryClient,
  artifact: VerifiedOperationalArtifact,
): Promise<OperationalBootstrapResult> {
  if (!verifiedArtifacts.has(artifact)) {
    throw new Error("Operational bulk import requires the immutable result returned by verifyOperationalBulkArtifact.");
  }
  const imported = emptyFamilyCounts();
  const tombstoned = emptyFamilyCounts();
  const runs: BootstrapRun[] = [];
  let rollupsQueued = 0;

  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('prostar-metrics-operational-bootstrap'))");
    await client.query(
      `create temporary table operational_bootstrap_seen (
         family text not null,
         identity text not null,
         primary key (family, identity)
       ) on commit drop`,
    );

    for (const family of EXPECTED_FAMILIES) {
      const source = artifact.sources[family];
      const run = await startBootstrapRun(client, artifact, source);
      runs.push(run);

      for (let offset = 0; offset < source.rows.length; offset += BATCH_SIZE) {
        const payloads = source.rows.slice(offset, offset + BATCH_SIZE) as Record<string, unknown>[];
        const count = await importFamilyBatch(client, artifact, run, payloads);
        imported[family] += count;
      }
      if (imported[family] !== source.rowCount) {
        throw new Error(`${family} import count ${imported[family]} does not match manifest ${source.rowCount}`);
      }
      tombstoned[family] = await finalizeAuthoritativeFamily(client, artifact, source);
      await completeBootstrapRun(client, run, source.sha256);
    }

    rollupsQueued = await enqueueOperationalRollups(client, artifact);
    const canonicalCounts = await readCanonicalCounts(client, artifact.manifest);
    await client.query("commit");
    return {
      manifestSha256: artifact.manifestSha256,
      imported,
      tombstoned,
      rollupsQueued,
      canonicalCounts,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

function manifestSourceFromVerified(source: VerifiedOperationalSource): OperationalSourceManifest {
  return {
    family: source.family,
    file: source.file,
    sha256: source.sha256,
    rowCount: source.rowCount,
    requestCount: source.requestCount,
    exactIds: [...source.exactIds],
    complete: source.complete,
    detailsComplete: source.detailsComplete,
    targetCount: source.targetCount,
    completedTargetCount: source.completedTargetCount,
    detailTargetCount: source.detailTargetCount,
    completedDetailTargetCount: source.completedDetailTargetCount,
    perMonthIds: source.perMonthIds
      ? Object.fromEntries(Object.entries(source.perMonthIds).map(([month, ids]) => [month, [...ids]]))
      : undefined,
    targets: source.targets?.map((target) => ({ ...target })),
    pages: source.pages?.map((page) => ({ ...page })),
  };
}

async function verifySourceArtifact(
  directory: string,
  manifest: OperationalBootstrapManifest,
  source: OperationalSourceManifest,
  options: OperationalArtifactVerificationOptions,
): Promise<VerifiedOperationalSource> {
  if (source.file !== `${source.family}.jsonl` || path.basename(source.file) !== source.file) {
    throw new Error(`Unsafe or unexpected ${source.family} artifact filename: ${source.file}`);
  }
  const filePath = path.join(directory, source.file);
  const bytes = await readFile(filePath);
  await options.afterSourceBytesRead?.({ family: source.family, filePath });
  const actualHash = sha256(bytes);
  if (actualHash !== source.sha256) {
    throw new Error(`${source.family} artifact checksum mismatch: expected ${source.sha256}, received ${actualHash}`);
  }
  const rows = parseJsonlBytes(bytes, source.file);

  const exactIds: Array<number | string> = [];
  const perMonthIds: Record<string, string[]> = {};
  for (const payload of rows) {
    if (source.family === "employees") {
      exactIds.push(flattenBulkEmployees([payload], manifest.completedAt)[0]!.employeeId);
    } else if (source.family === "timesheets") {
      const fact = flattenBulkTimesheets([payload], manifest.completedAt)[0]!;
      if (!fact.workDate || fact.workDate < manifest.startDate || fact.workDate > manifest.asOfDate) {
        throw new Error(`Timesheet ${fact.timesheetIdentity} falls outside the declared export window`);
      }
      exactIds.push(fact.timesheetIdentity);
      const month = `${fact.workDate.slice(0, 7)}-01`;
      (perMonthIds[month] ??= []).push(fact.timesheetIdentity);
    } else if (source.family === "schedules") {
      exactIds.push(flattenBulkSchedules([payload], manifest.completedAt).schedules[0]!.scheduleId);
    } else if (source.family === "mobile_status") {
      exactIds.push(flattenBulkMobileStatus([payload], manifest.completedAt)[0]!.logId);
    }
  }

  if (exactIds.length !== source.rowCount || !sameIdentities(exactIds, source.exactIds)) {
    throw new Error(`${source.family} exact identity evidence does not match the JSONL artifact`);
  }
  if (source.family === "timesheets") {
    if (JSON.stringify(sortRecord(perMonthIds)) !== JSON.stringify(sortRecord(source.perMonthIds ?? {}))) {
      throw new Error("Timesheet per-month identity evidence does not match the JSONL artifact");
    }
  }
  return deepFreeze({
    ...source,
    exactIds,
    perMonthIds: source.family === "timesheets" ? sortRecord(perMonthIds) : source.perMonthIds,
    rows,
  });
}

function assertManifestContract(manifest: OperationalBootstrapManifest) {
  if (manifest.version !== 1) throw new Error(`Unsupported operational manifest version: ${manifest.version}`);
  if (manifest.startDate !== "2023-01-01") throw new Error(`Unexpected operational start date: ${manifest.startDate}`);
  if (manifest.timezone !== "America/Los_Angeles") throw new Error(`Unexpected operational timezone: ${manifest.timezone}`);
  if (!validDate(manifest.asOfDate) || !validTimestamp(manifest.startedAt) || !validTimestamp(manifest.completedAt)) {
    throw new Error("Operational manifest dates are invalid");
  }
  const families = manifest.sources.map((source) => source.family).sort();
  if (JSON.stringify(families) !== JSON.stringify([...EXPECTED_FAMILIES].sort())) {
    throw new Error("Operational manifest must contain exactly employees, timesheets, schedules, and mobile_status");
  }
  const requestCount = manifest.sources.reduce((sum, source) => sum + source.requestCount, 0);
  if (requestCount !== manifest.requestsUsed) {
    throw new Error(`Operational request evidence ${requestCount} does not match requestsUsed ${manifest.requestsUsed}`);
  }
  for (const source of manifest.sources) {
    if (!Number.isSafeInteger(source.rowCount) || source.rowCount < 0 || source.exactIds.length !== source.rowCount) {
      throw new Error(`${source.family} row identity contract is invalid`);
    }
    if (!Number.isSafeInteger(source.requestCount) || source.requestCount < 1 || !/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new Error(`${source.family} request/checksum contract is invalid`);
    }
    if (source.family === "timesheets" && source.targetCount !== source.completedTargetCount) {
      throw new Error("Timesheet employee traversal is incomplete");
    }
  }
}

async function importFamilyBatch(
  client: OperationalBootstrapQueryClient,
  artifact: VerifiedOperationalArtifact,
  run: BootstrapRun,
  payloads: Record<string, unknown>[],
): Promise<number> {
  if (run.family === "employees") {
    const facts = flattenBulkEmployees(payloads, artifact.manifest.completedAt);
    await insertRawSnapshots(client, artifact, run, entries(payloads, facts, (fact) => String(fact.employeeId)));
    await importEmployees(client, entries(payloads, facts, (fact) => String(fact.employeeId)));
    return facts.length;
  }
  if (run.family === "timesheets") {
    const facts = flattenBulkTimesheets(payloads, artifact.manifest.completedAt);
    await insertRawSnapshots(client, artifact, run, entries(payloads, facts, (fact) => fact.timesheetIdentity));
    await importTimesheets(client, entries(payloads, facts, (fact) => fact.timesheetIdentity));
    return facts.length;
  }
  if (run.family === "schedules") {
    const flattened = flattenBulkSchedules(payloads, artifact.manifest.completedAt);
    await insertRawSnapshots(client, artifact, run, entries(payloads, flattened.schedules, (fact) => String(fact.scheduleId)));
    await importSchedules(client, payloads, flattened.schedules, flattened.scheduleBlocks);
    return flattened.schedules.length;
  }
  if (run.family === "mobile_status") {
    const facts = flattenBulkMobileStatus(payloads, artifact.manifest.completedAt);
    await insertRawSnapshots(client, artifact, run, entries(payloads, facts, (fact) => String(fact.logId)));
    await importMobileStatus(client, entries(payloads, facts, (fact) => String(fact.logId)));
    return facts.length;
  }

  throw new Error(`Unsupported operational family: ${String(run.family)}`);
}

function entries<T>(
  payloads: Record<string, unknown>[],
  facts: T[],
  identity: (fact: T) => string,
): Array<ImportEntry<T> & { identity: string }> {
  if (payloads.length !== facts.length) throw new Error("Operational payload/fact cardinality mismatch");
  return facts.map((fact, index) => ({ payload: payloads[index]!, fact, identity: identity(fact) }));
}

async function insertRawSnapshots<T>(
  client: OperationalBootstrapQueryClient,
  artifact: VerifiedOperationalArtifact,
  run: BootstrapRun,
  rows: Array<ImportEntry<T> & { identity: string }>,
) {
  await client.query(
    `with rows as (select entry from jsonb_array_elements($1::jsonb) entry), seen as (
       insert into operational_bootstrap_seen (family, identity)
       select $2, entry->>'identity' from rows
       on conflict do nothing
     )
     insert into metrics.raw_simpro_snapshots (
       entity_type, entity_id, source_path, payload, source_hash, source_updated_at,
       source_version, ingestion_run_id, complete_traversal, parent_identity, page_window
     )
     select $2, entry->>'identity', $3, entry->'payload', entry->'fact'->>'sourceHash',
            nullif(entry->'fact'->>'sourceModifiedAt', '')::timestamptz,
            $4, $5, true, jsonb_build_object('identity', entry->>'identity'), $6::jsonb
       from rows
     on conflict (entity_type, entity_id, source_hash) do update set
       ingestion_run_id = excluded.ingestion_run_id,
       complete_traversal = true,
       parent_identity = excluded.parent_identity,
       page_window = excluded.page_window,
       source_deleted_at = null`,
    [
      JSON.stringify(rows),
      run.family,
      sourcePath(run.family),
      `operational-bootstrap:${artifact.manifestSha256}`,
      run.runId,
      JSON.stringify({ manifestSha256: artifact.manifestSha256, completeTraversal: true }),
    ],
  );
}

async function importEmployees(
  client: OperationalBootstrapQueryClient,
  rows: Array<ImportEntry<BulkEmployeeRow> & { identity: string }>,
) {
  await client.query(
    `with rows as (select entry->'fact' row from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.dim_people (
       simpro_employee_id, display_name, role_type, active, email, position,
       source_created_at, source_modified_at, last_seen_at
     )
     select (row->>'employeeId')::bigint, row->>'displayName', 'employee',
            (row->>'active')::boolean, nullif(row->>'email', ''), nullif(row->>'position', ''),
            nullif(row->>'sourceCreatedAt', '')::timestamptz,
            nullif(row->>'sourceModifiedAt', '')::timestamptz, now()
       from rows
     on conflict (simpro_employee_id) do update set
       display_name = excluded.display_name,
       role_type = 'employee', active = excluded.active, email = excluded.email,
       position = excluded.position, source_created_at = excluded.source_created_at,
       source_modified_at = excluded.source_modified_at, last_seen_at = now()`,
    [JSON.stringify(rows)],
  );
  await client.query(
    `with rows as (select entry->'fact' row from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.employee_snapshots (
       employee_id, display_name, email, archived, source_snapshot_id, updated_at
     )
     select (row->>'employeeId')::bigint, row->>'displayName', nullif(row->>'email', ''),
            (row->>'archived')::boolean, snapshot.id, now()
       from rows
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = 'employees'
        and snapshot.entity_id = row->>'employeeId'
        and snapshot.source_hash = row->>'sourceHash'
     on conflict (employee_id) do update set
       display_name = excluded.display_name, email = excluded.email,
       archived = excluded.archived, source_snapshot_id = excluded.source_snapshot_id,
       updated_at = now()`,
    [JSON.stringify(rows)],
  );
}

async function importTimesheets(
  client: OperationalBootstrapQueryClient,
  rows: Array<ImportEntry<BulkTimesheetRow> & { identity: string }>,
) {
  await client.query(
    `with rows as (select entry->'fact' row from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.metrics_employee_timesheets (
       timesheet_id, employee_id, person_id, reference_type, reference_id, reference_raw,
       work_date, start_time, end_time, total_hours, schedule_rate, schedule_rate_id,
       schedule_rate_name, cost, overhead_cost, total_cost, parse_status,
       source_snapshot_id, source_hash, source_deleted_at, fetched_at, updated_from_source_at
     )
     select row->>'timesheetId', (row->>'employeeId')::bigint, person.person_id,
            nullif(row->>'referenceType', ''), nullif(row->>'referenceId', '')::bigint,
            nullif(row->>'referenceRaw', ''), nullif(row->>'workDate', '')::date,
            nullif(row->>'startAt', '')::timestamptz, nullif(row->>'endAt', '')::timestamptz,
            coalesce(nullif(row->>'totalHours', '')::numeric, 0), null,
            nullif(row->>'scheduleRateId', '')::bigint, nullif(row->>'scheduleRateName', ''),
            nullif(row->>'cost', '')::numeric, nullif(row->>'overheadCost', '')::numeric,
            nullif(row->>'totalCost', '')::numeric, row->>'parseStatus', snapshot.id,
            row->>'sourceHash', null, nullif(row->>'fetchedAt', '')::timestamptz, now()
       from rows
       left join metrics.dim_people person on person.simpro_employee_id = (row->>'employeeId')::bigint
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = 'timesheets'
        and snapshot.entity_id = row->>'timesheetIdentity'
        and snapshot.source_hash = row->>'sourceHash'
     on conflict (employee_id, timesheet_id) do update set
       person_id = excluded.person_id, reference_type = excluded.reference_type,
       reference_id = excluded.reference_id, reference_raw = excluded.reference_raw,
       work_date = excluded.work_date, start_time = excluded.start_time,
       end_time = excluded.end_time, total_hours = excluded.total_hours,
       schedule_rate = null, schedule_rate_id = excluded.schedule_rate_id,
       schedule_rate_name = excluded.schedule_rate_name, cost = excluded.cost,
       overhead_cost = excluded.overhead_cost, total_cost = excluded.total_cost,
       parse_status = excluded.parse_status, source_snapshot_id = excluded.source_snapshot_id,
       source_hash = excluded.source_hash, source_deleted_at = null,
       fetched_at = excluded.fetched_at, updated_from_source_at = now()`,
    [JSON.stringify(rows)],
  );
  await client.query(
    `with rows as (select entry->'fact' row from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.timesheet_snapshots (
       employee_id, simpro_timesheet_id, reference_type, reference_id, reference_href,
       work_date, start_at, end_at, total_hours, cost_value, source_snapshot_id
     )
     select (row->>'employeeId')::bigint, row->>'timesheetId', nullif(row->>'referenceType', ''),
            nullif(row->>'referenceId', ''), nullif(row->>'referenceHref', ''),
            nullif(row->>'workDate', '')::date, nullif(row->>'startAt', '')::timestamptz,
            nullif(row->>'endAt', '')::timestamptz, nullif(row->>'totalHours', '')::numeric,
            coalesce(nullif(row->>'totalCost', '')::numeric, nullif(row->>'cost', '')::numeric), snapshot.id
       from rows
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = 'timesheets'
        and snapshot.entity_id = row->>'timesheetIdentity'
        and snapshot.source_hash = row->>'sourceHash'
     on conflict (employee_id, simpro_timesheet_id) do update set
       reference_type = excluded.reference_type, reference_id = excluded.reference_id,
       reference_href = excluded.reference_href, work_date = excluded.work_date,
       start_at = excluded.start_at, end_at = excluded.end_at,
       total_hours = excluded.total_hours, cost_value = excluded.cost_value,
       source_snapshot_id = excluded.source_snapshot_id`,
    [JSON.stringify(rows)],
  );
}

async function importSchedules(
  client: OperationalBootstrapQueryClient,
  payloads: Record<string, unknown>[],
  schedules: BulkScheduleRow[],
  blocks: BulkScheduleBlockRow[],
) {
  const rows = schedules.map((fact, index) => ({ fact, payload: payloads[index]! }));
  await upsertObservedPeople(client, schedules.map((row) => ({
    staffId: row.staffId,
    staffName: row.staffName,
    roleType: row.staffType ?? "employee",
  })));
  await client.query(
    `with rows as (select entry from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.metrics_schedules (
       schedule_id, reference_type, reference_id, staff_person_id, schedule_date,
       total_hours, start_time, end_time, iso_start_time, iso_end_time,
       schedule_rate, schedule_rate_id, schedule_rate_name, reference_raw,
       source_modified_at, source_snapshot_id, source_hash, source_deleted_at,
       fetched_at, updated_from_source_at
     )
     select (entry->'fact'->>'scheduleId')::bigint,
            nullif(entry->'fact'->>'referenceType', ''), nullif(entry->'fact'->>'referenceId', '')::bigint,
            person.person_id, nullif(entry->'fact'->>'scheduleDate', '')::date,
            nullif(entry->'fact'->>'totalHours', '')::numeric,
            nullif(entry->'fact'->>'startTime', '')::time, nullif(entry->'fact'->>'endTime', '')::time,
            nullif(entry->'fact'->>'isoStartTime', '')::timestamptz,
            nullif(entry->'fact'->>'isoEndTime', '')::timestamptz, null,
            nullif(entry->'fact'->>'scheduleRateId', '')::bigint,
            nullif(entry->'fact'->>'scheduleRateName', ''), nullif(entry->'fact'->>'referenceRaw', ''),
            nullif(entry->'fact'->>'sourceModifiedAt', '')::timestamptz,
            snapshot.id, entry->'fact'->>'sourceHash', null,
            nullif(entry->'fact'->>'fetchedAt', '')::timestamptz, now()
       from rows
       left join metrics.dim_people person
         on person.simpro_employee_id = nullif(entry->'fact'->>'staffId', '')::bigint
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = 'schedules'
        and snapshot.entity_id = entry->'fact'->>'scheduleId'
        and snapshot.source_hash = entry->'fact'->>'sourceHash'
     on conflict (schedule_id) do update set
       reference_type = excluded.reference_type, reference_id = excluded.reference_id,
       staff_person_id = excluded.staff_person_id, schedule_date = excluded.schedule_date,
       total_hours = excluded.total_hours, start_time = excluded.start_time,
       end_time = excluded.end_time, iso_start_time = excluded.iso_start_time,
       iso_end_time = excluded.iso_end_time, schedule_rate = null,
       schedule_rate_id = excluded.schedule_rate_id, schedule_rate_name = excluded.schedule_rate_name,
       reference_raw = excluded.reference_raw, source_modified_at = excluded.source_modified_at,
       source_snapshot_id = excluded.source_snapshot_id, source_hash = excluded.source_hash,
       source_deleted_at = null, fetched_at = excluded.fetched_at, updated_from_source_at = now()`,
    [JSON.stringify(rows)],
  );
  await client.query(
    `with rows as (select entry from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.schedule_snapshots (
       schedule_id, reference_type, reference_id, project_type, project_id,
       staff, blocks, planned_start_at, planned_end_at, source_snapshot_id
     )
     select (entry->'fact'->>'scheduleId')::bigint, nullif(entry->'fact'->>'referenceType', ''),
            nullif(entry->'fact'->>'referenceId', ''), nullif(entry->'fact'->>'referenceType', ''),
            nullif(entry->'fact'->>'projectId', ''),
            case when entry->'payload'->'Staff' is null then '[]'::jsonb else jsonb_build_array(entry->'payload'->'Staff') end,
            coalesce(entry->'payload'->'Blocks', '[]'::jsonb),
            nullif(entry->'fact'->>'isoStartTime', '')::timestamptz,
            nullif(entry->'fact'->>'isoEndTime', '')::timestamptz, snapshot.id
       from rows
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = 'schedules'
        and snapshot.entity_id = entry->'fact'->>'scheduleId'
        and snapshot.source_hash = entry->'fact'->>'sourceHash'
     on conflict (schedule_id) do update set
       reference_type = excluded.reference_type, reference_id = excluded.reference_id,
       project_type = excluded.project_type, project_id = excluded.project_id,
       staff = excluded.staff, blocks = excluded.blocks,
       planned_start_at = excluded.planned_start_at, planned_end_at = excluded.planned_end_at,
       source_snapshot_id = excluded.source_snapshot_id`,
    [JSON.stringify(rows)],
  );
  const scheduleIds = schedules.map((row) => row.scheduleId);
  await client.query(
    `update metrics.metrics_schedule_blocks
        set source_deleted_at = coalesce(source_deleted_at, now()), fetched_at = now()
      where schedule_id = any($1::bigint[])`,
    [scheduleIds],
  );
  if (blocks.length > 0) {
    await client.query(
      `with rows as (select entry row from jsonb_array_elements($1::jsonb) entry)
       insert into metrics.metrics_schedule_blocks (
         schedule_id, block_index, staff_id, reference_type, reference_id, schedule_rate_id,
         planned_hours, planned_start_at, planned_end_at, source_snapshot_id, source_hash,
         source_deleted_at, fetched_at
       )
       select (row->>'scheduleId')::bigint, (row->>'blockIndex')::integer,
              nullif(row->>'staffId', '')::bigint, nullif(row->>'referenceType', ''),
              nullif(row->>'referenceId', '')::bigint, nullif(row->>'scheduleRateId', '')::bigint,
              nullif(row->>'plannedHours', '')::numeric,
              nullif(row->>'plannedStartAt', '')::timestamptz,
              nullif(row->>'plannedEndAt', '')::timestamptz,
              snapshot.id, row->>'sourceHash', null, nullif(row->>'fetchedAt', '')::timestamptz
         from rows
         join metrics.raw_simpro_snapshots snapshot
           on snapshot.entity_type = 'schedules'
          and snapshot.entity_id = row->>'scheduleId'
          and snapshot.source_hash = row->>'scheduleSourceHash'
       on conflict (schedule_id, block_index) do update set
         staff_id = excluded.staff_id, reference_type = excluded.reference_type,
         reference_id = excluded.reference_id, schedule_rate_id = excluded.schedule_rate_id,
         planned_hours = excluded.planned_hours, planned_start_at = excluded.planned_start_at,
         planned_end_at = excluded.planned_end_at, source_snapshot_id = excluded.source_snapshot_id,
         source_hash = excluded.source_hash, source_deleted_at = null, fetched_at = excluded.fetched_at`,
      [JSON.stringify(blocks)],
    );
  }
}

async function importMobileStatus(
  client: OperationalBootstrapQueryClient,
  rows: Array<ImportEntry<BulkMobileStatusRow> & { identity: string }>,
) {
  await upsertObservedPeople(client, rows.map(({ fact }) => ({
    staffId: fact.staffId,
    staffName: fact.staffName,
    roleType: fact.staffType ?? "employee",
  })));
  await client.query(
    `with rows as (select entry->'fact' row from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.metrics_mobile_status_logs (
       simpro_log_id, staff_person_id, work_order_id, work_order_type, project_id,
       cost_center_id, status_id, status_name, latitude, longitude, date_logged,
       coverage_window_start, coverage_window_end, fetched_at, source_snapshot_id, source_hash
     )
     select (row->>'logId')::bigint, person.person_id,
            nullif(row->>'workOrderId', '')::bigint, nullif(row->>'workOrderType', ''),
            nullif(row->>'projectId', '')::bigint, nullif(row->>'costCenterId', '')::bigint,
            nullif(row->>'statusId', '')::bigint, nullif(row->>'statusName', ''),
            nullif(row->>'latitude', '')::numeric, nullif(row->>'longitude', '')::numeric,
            nullif(row->>'dateLogged', '')::timestamptz,
            nullif(row->>'dateLogged', '')::timestamptz,
            nullif(row->>'dateLogged', '')::timestamptz,
            nullif(row->>'fetchedAt', '')::timestamptz, snapshot.id, row->>'sourceHash'
       from rows
       left join metrics.dim_people person on person.simpro_employee_id = nullif(row->>'staffId', '')::bigint
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = 'mobile_status'
        and snapshot.entity_id = row->>'logId'
        and snapshot.source_hash = row->>'sourceHash'
     on conflict (simpro_log_id) do update set
       staff_person_id = excluded.staff_person_id, work_order_id = excluded.work_order_id,
       work_order_type = excluded.work_order_type, project_id = excluded.project_id,
       cost_center_id = excluded.cost_center_id, status_id = excluded.status_id,
       status_name = excluded.status_name, latitude = excluded.latitude,
       longitude = excluded.longitude, date_logged = excluded.date_logged,
       coverage_window_start = excluded.coverage_window_start,
       coverage_window_end = excluded.coverage_window_end, fetched_at = excluded.fetched_at,
       source_snapshot_id = excluded.source_snapshot_id, source_hash = excluded.source_hash`,
    [JSON.stringify(rows)],
  );
  await client.query(
    `with rows as (select entry->'fact' row from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.mobile_status_snapshots (
       log_id, staff_id, staff_name, work_order_id, job_id, status_name,
       latitude, longitude, logged_at, source_snapshot_id
     )
     select (row->>'logId')::bigint, nullif(row->>'staffId', '')::bigint,
            nullif(row->>'staffName', ''), nullif(row->>'workOrderId', '')::bigint,
            nullif(row->>'projectId', '')::bigint, nullif(row->>'statusName', ''),
            nullif(row->>'latitude', '')::numeric, nullif(row->>'longitude', '')::numeric,
            nullif(row->>'dateLogged', '')::timestamptz, snapshot.id
       from rows
       join metrics.raw_simpro_snapshots snapshot
         on snapshot.entity_type = 'mobile_status'
        and snapshot.entity_id = row->>'logId'
        and snapshot.source_hash = row->>'sourceHash'
     on conflict (log_id) do update set
       staff_id = excluded.staff_id, staff_name = excluded.staff_name,
       work_order_id = excluded.work_order_id, job_id = excluded.job_id,
       status_name = excluded.status_name, latitude = excluded.latitude,
       longitude = excluded.longitude, logged_at = excluded.logged_at,
       source_snapshot_id = excluded.source_snapshot_id`,
    [JSON.stringify(rows)],
  );
}

async function upsertObservedPeople(
  client: OperationalBootstrapQueryClient,
  rows: Array<{ staffId: number | null; staffName: string | null; roleType: string }>,
) {
  const unique = new Map<number, { staffId: number; staffName: string; roleType: string }>();
  for (const row of rows) {
    if (row.staffId === null) continue;
    unique.set(row.staffId, {
      staffId: row.staffId,
      staffName: row.staffName ?? `Employee ${row.staffId}`,
      roleType: row.roleType,
    });
  }
  if (unique.size === 0) return;
  await client.query(
    `with rows as (select entry row from jsonb_array_elements($1::jsonb) entry)
     insert into metrics.dim_people (simpro_employee_id, display_name, role_type, active, last_seen_at)
     select (row->>'staffId')::bigint, row->>'staffName', row->>'roleType', true, now()
       from rows
     on conflict (simpro_employee_id) do update set
       display_name = case
         when metrics.dim_people.display_name ~* '^Employee [0-9]+$' then excluded.display_name
         else metrics.dim_people.display_name
       end,
       role_type = case when metrics.dim_people.role_type = 'unknown' then excluded.role_type else metrics.dim_people.role_type end,
       last_seen_at = now()`,
    [JSON.stringify([...unique.values()])],
  );
}

async function finalizeAuthoritativeFamily(
  client: OperationalBootstrapQueryClient,
  artifact: VerifiedOperationalArtifact,
  source: Pick<OperationalSourceManifest, "family">,
): Promise<number> {
  let result: { rowCount: number | null };
  if (source.family === "employees") {
    result = await client.query(
      `with absent as (
         delete from metrics.employee_snapshots employee
          where not exists (
            select 1 from operational_bootstrap_seen seen
             where seen.family = 'employees' and seen.identity = employee.employee_id::text
          )
          returning employee_id
       )
       update metrics.dim_people person
          set active = false, last_seen_at = now()
         from absent
        where person.simpro_employee_id = absent.employee_id`,
    );
  } else if (source.family === "timesheets") {
    result = await client.query(
      `update metrics.metrics_employee_timesheets fact
          set source_deleted_at = coalesce(source_deleted_at, now()), updated_from_source_at = now()
        where fact.work_date >= $1::date and fact.work_date <= $2::date
          and not exists (
            select 1 from operational_bootstrap_seen seen
             where seen.family = 'timesheets'
               and seen.identity = fact.employee_id::text || ':' || fact.timesheet_id
          )
          and fact.source_deleted_at is null`,
      [artifact.manifest.startDate, artifact.manifest.asOfDate],
    );
    await client.query(
      `delete from metrics.timesheet_snapshots fact
        where fact.work_date >= $1::date and fact.work_date <= $2::date
          and not exists (
            select 1 from operational_bootstrap_seen seen
             where seen.family = 'timesheets'
               and seen.identity = fact.employee_id::text || ':' || fact.simpro_timesheet_id
          )`,
      [artifact.manifest.startDate, artifact.manifest.asOfDate],
    );
  } else if (source.family === "schedules") {
    result = await client.query(
      `update metrics.metrics_schedules fact
          set source_deleted_at = coalesce(source_deleted_at, now()), updated_from_source_at = now()
        where not exists (
          select 1 from operational_bootstrap_seen seen
           where seen.family = 'schedules' and seen.identity = fact.schedule_id::text
        ) and fact.source_deleted_at is null`,
    );
    await client.query(
      `update metrics.metrics_schedule_blocks block
          set source_deleted_at = coalesce(source_deleted_at, now()), fetched_at = now()
        where exists (
          select 1 from metrics.metrics_schedules schedule
           where schedule.schedule_id = block.schedule_id and schedule.source_deleted_at is not null
        ) and block.source_deleted_at is null`,
    );
    await client.query(
      `delete from metrics.schedule_snapshots fact
        where not exists (
          select 1 from operational_bootstrap_seen seen
           where seen.family = 'schedules' and seen.identity = fact.schedule_id::text
        )`,
    );
  } else if (source.family === "mobile_status") {
    result = await client.query(
      `delete from metrics.metrics_mobile_status_logs fact
        where not exists (
          select 1 from operational_bootstrap_seen seen
           where seen.family = 'mobile_status' and seen.identity = fact.simpro_log_id::text
        )`,
    );
    await client.query(
      `delete from metrics.mobile_status_snapshots fact
        where not exists (
          select 1 from operational_bootstrap_seen seen
           where seen.family = 'mobile_status' and seen.identity = fact.log_id::text
        )`,
    );
  } else {
    throw new Error(`Unsupported operational family: ${String(source.family)}`);
  }

  await client.query(
    `update metrics.raw_simpro_snapshots raw
        set source_deleted_at = coalesce(source_deleted_at, now())
      where raw.entity_type = $1
        and not exists (
          select 1 from operational_bootstrap_seen seen
           where seen.family = $1 and seen.identity = raw.entity_id
        )
        and raw.source_deleted_at is null`,
    [source.family],
  );
  return result.rowCount ?? 0;
}

async function startBootstrapRun(
  client: OperationalBootstrapQueryClient,
  artifact: VerifiedOperationalArtifact,
  source: Pick<OperationalSourceManifest, "family" | "sha256" | "rowCount" | "requestCount">,
): Promise<BootstrapRun> {
  const workerId = `operational-bootstrap:${process.pid}`;
  const idempotencyKey = `operational-bootstrap:${artifact.manifestSha256}:${source.family}`;
  const params = JSON.stringify({
    transport: "simpro-operational-jsonl",
    manifestSha256: artifact.manifestSha256,
    artifactSha256: source.sha256,
    exactRowCount: source.rowCount,
    completeTraversal: true,
  });
  const job = await client.query<{ id: string; generation: number }>(
    `insert into metrics.ingestion_jobs (
       entity_type, status, priority, idempotency_key, request_budget, requests_used,
       params, operation, source_window_start, source_window_end, locked_by, locked_at,
       lock_expires_at, heartbeat_at, attempts, next_attempt_at, updated_at
     ) values (
       $1::metrics.ingestion_entity_type, 'running', 1, $2, $3, 0,
       $4::jsonb, 'bulk_bootstrap', $5::timestamptz, $6::timestamptz, $7, now(),
       now() + interval '30 minutes', now(), 1, now(), now()
     )
     on conflict (entity_type, idempotency_key) do update set
       status = 'running'::metrics.ingestion_job_status, priority = 1,
       request_budget = excluded.request_budget, requests_used = 0, params = excluded.params,
       operation = excluded.operation, source_window_start = excluded.source_window_start,
       source_window_end = excluded.source_window_end, locked_by = excluded.locked_by,
       locked_at = now(), lock_expires_at = excluded.lock_expires_at, heartbeat_at = now(),
       attempts = metrics.ingestion_jobs.attempts + 1,
       generation = metrics.ingestion_jobs.generation + 1,
       continuation_token = null, page_cursor = null, last_error = null,
       dead_lettered_at = null, completed_at = null, updated_at = now()
     returning id::text, generation`,
    [source.family, idempotencyKey, source.requestCount, params, artifact.manifest.startDate, artifact.manifest.completedAt, workerId],
  );
  const jobRow = job.rows[0];
  if (!jobRow) throw new Error(`Unable to start ${source.family} operational bootstrap job`);
  const run = await client.query<{ id: string }>(
    `insert into metrics.ingestion_runs (
       job_id, entity_type, source_family, source_window_start, source_window_end,
       status, worker_id, job_generation, source_hash
     ) values ($1, $2::metrics.ingestion_entity_type, $2, $3::timestamptz, $4::timestamptz,
       'running', $5, $6, $7)
     returning id::text`,
    [jobRow.id, source.family, artifact.manifest.startDate, artifact.manifest.completedAt, workerId, jobRow.generation, source.sha256],
  );
  const runRow = run.rows[0];
  if (!runRow) throw new Error(`Unable to start ${source.family} operational bootstrap run`);
  return {
    family: source.family,
    jobId: Number(jobRow.id),
    runId: Number(runRow.id),
    requestCount: source.requestCount,
    rowCount: source.rowCount,
  };
}

async function completeBootstrapRun(
  client: OperationalBootstrapQueryClient,
  run: BootstrapRun,
  sourceSha256: string,
) {
  await client.query(
    `update metrics.ingestion_runs
        set status = 'succeeded'::metrics.ingestion_job_status, finished_at = now(),
            request_count = $2, snapshot_count = $3, normalized_count = $3,
            source_hash = $4, error_message = null
      where id = $1`,
    [run.runId, run.requestCount, run.rowCount, sourceSha256],
  );
  await client.query(
    `update metrics.ingestion_jobs
        set status = 'succeeded'::metrics.ingestion_job_status, requests_used = $2,
            locked_by = null, locked_at = null, lock_expires_at = null,
            heartbeat_at = null, attempts = 0, last_error = null,
            dead_lettered_at = null, completed_at = now(), updated_at = now()
      where id = $1`,
    [run.jobId, run.requestCount],
  );
}

async function enqueueOperationalRollups(
  client: OperationalBootstrapQueryClient,
  artifact: VerifiedOperationalArtifact,
): Promise<number> {
  const result = await client.query(
    `with periods as (
       select generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month')::date period_start
     ), requests as (
       select scope, period_start
         from periods cross join unnest(array['jobs','technicians','commissions']) scope
     )
     insert into metrics.rollup_rebuild_queue (
       metric_family, period_grain, period_start, dimensions_json, reason, idempotency_key
     )
     select scope, 'month', period_start, '{}'::jsonb, 'verified Simpro operational bulk bootstrap',
            'operational-bootstrap:' || $3 || ':' || scope || ':' || period_start::text
       from requests
     on conflict (idempotency_key) do nothing`,
    [artifact.manifest.startDate, artifact.manifest.asOfDate, artifact.manifestSha256],
  );
  return result.rowCount ?? 0;
}

async function readCanonicalCounts(
  client: OperationalBootstrapQueryClient,
  manifest: OperationalBootstrapManifest,
) {
  const result = await client.query<Record<string, number>>(
    `select
       (select count(*)::int from metrics.employee_snapshots) employees,
       (select count(*)::int from metrics.metrics_employee_timesheets
         where source_deleted_at is null and work_date >= $1::date and work_date <= $2::date) timesheets,
       (select count(*)::int from metrics.metrics_schedules where source_deleted_at is null) schedules,
       (select count(*)::int from metrics.metrics_schedule_blocks where source_deleted_at is null) schedule_blocks,
       (select count(*)::int from metrics.metrics_mobile_status_logs) mobile_status`,
    [manifest.startDate, manifest.asOfDate],
  );
  return result.rows[0] ?? {};
}

function sourcePath(family: OperationalFamily) {
  if (family === "employees") return "simpro:/employees/?Archived=false+true";
  if (family === "timesheets") return "simpro:/employees/{id}/timesheets/";
  if (family === "schedules") return "simpro:/schedules/?display=all";
  if (family === "mobile_status") return "simpro:/logs/mobileStatus/";
  throw new Error(`Unsupported operational family: ${String(family)}`);
}

function emptyFamilyCounts(): Record<OperationalFamily, number> {
  return { employees: 0, timesheets: 0, schedules: 0, mobile_status: 0 };
}

function parseJsonlBytes(bytes: Uint8Array, file: string) {
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const [index, line] of Buffer.from(bytes).toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${file} line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(value)) throw new Error(`${file} line ${index + 1} contains a non-object row`);
    rows.push(deepFreeze(value));
  }
  return Object.freeze(rows);
}

function parseChecksumFile(value: string, expectedFile: string) {
  const match = /^([a-f0-9]{64})  (.+)\n?$/.exec(value);
  if (!match || match[2] !== expectedFile) throw new Error(`Invalid checksum file for ${expectedFile}`);
  return match[1]!;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentities(left: Array<number | string>, right: Array<number | string>) {
  return left.length === right.length && left.every((value, index) => String(value) === String(right[index]));
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime());
}

function validTimestamp(value: string) {
  return !Number.isNaN(new Date(value).getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
