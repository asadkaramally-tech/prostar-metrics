# Azure Cadence Jobs

The three extended schedules are implemented as bounded worker modes and declared as scheduled Container Apps jobs in `metrics.bicep`:

- `workers/reconcile-simpro.ts` exposes `--mode`, bounded month batch, runtime limit, request limit, and a persisted cadence cursor. Unknown arguments and modes fail closed.
- `workers/rebuild-rollups.ts` exposes a retry-idempotent Pacific 03:00 nightly commission mode and drains only the commission queue in that mode.

The existing 05:30 UTC current-month reconciliation and ten-minute rollup drain remain active and are not substitutes for these schedules.

## Required Hooks

### Nightly trailing 24 months

- Job: `job-psm-reconcile-trailing-24m`.
- Trigger after current reconciliation: `0 8 * * *` UTC.
- Required hook: `runCadencedReconciliation` in `workers/reconcile-simpro.ts`.
- Exact input: `{ mode: "trailing-24-months", scope: "all", batchMonths: 3, runtimeMinutes: 20, requestBudget: 1000 }`.
- Required behavior: calculate the latest 24 calendar-month starts using `America/Los_Angeles`, persist the next-month cursor, process at most three months and stop at 20 minutes or 1,000 Simpro requests, then resume on the next run. Unknown modes must fail rather than fall through to current-month reconciliation.

### Monthly older stable history

- Job: `job-psm-reconcile-stable-history`.
- Trigger: `0 9 1 * *` UTC.
- Required hook: `runCadencedReconciliation` in `workers/reconcile-simpro.ts`.
- Exact input: `{ mode: "older-stable-history", scope: "all", batchMonths: 3, runtimeMinutes: 20, requestBudget: 1000 }`.
- Required behavior: select only months older than the trailing 24-month window with two unchanged successful reconciliations, persist a month cursor, process at most three eligible months, and resume after the same runtime/request limits.

### Nightly commission rebuild

- Job: `job-psm-commissions-nightly`.
- Trigger: `0 * * * *` UTC, evaluated hourly because Azure Container Apps cron has no `America/Los_Angeles` timezone setting.
- Required hook: `enqueueCurrentPacificCommissionRebuild` in `workers/rebuild-rollups.ts`.
- Exact input: `{ timeZone: "America/Los_Angeles", localHour: 3, scope: "commissions", limit: 1 }`.
- Required behavior: no-op unless the current Los Angeles hour is 03, derive that local date's current month, enqueue and drain one commission rebuild, and use the Pacific local date as an idempotency key. The hook must produce exactly one rebuild across retries and both daylight-saving offsets (10:00 UTC during PDT and 11:00 UTC during PST).

### Materials month walk

- Job: `job-psm-materials`.
- Trigger: `40 1,7,13,19 * * *` UTC (four walks a day).
- Required hook: the `main` entrypoint of `workers/ingest-materials.ts` with `--months-back 1 --request-limit 8000`.
- Required behavior: walk the current Pacific month and the prior month live from Simpro (jobs completed in the window, then sections, cost centers, catalogs, Material one-offs, and prebuilds), replace each job's mirrored material lines atomically, refresh the persistent `metrics.catalog_groups` cache, seal each month walk in `metrics.materials_month_walks`, then enqueue and drain `materials` rollup rebuilds so `dashboard_read_models` serves `/materials` without request-time Simpro traffic. A failed month records `status = 'failed'` and retains the last complete mirror.

## Deployment Checklist

1. Run worker tests covering cursor resume, request/runtime exhaustion, month boundaries, DST transitions, retries, and same-local-date idempotency.
2. Build Bicep and run `npm run test:infra` to prove every declared job is included in monitoring.
3. Review metrics and monitoring deployment what-if output before applying the schedules.
