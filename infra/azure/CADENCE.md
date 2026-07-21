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
- Trigger: `0 10,11 * * *` UTC. Those two UTC hours cover Pacific 03:00 across PDT and PST; the worker's local-hour guard makes the nonmatching invocation an inexpensive no-op.
- Required hook: `enqueueCurrentPacificCommissionRebuild` in `workers/rebuild-rollups.ts`.
- Exact input: `{ timeZone: "America/Los_Angeles", localHour: 3, scope: "commissions", limit: 1 }`.
- Required behavior: no-op unless the current Los Angeles hour is 03, derive that local date's current month, enqueue and drain one commission rebuild, and use the Pacific local date as an idempotency key. The hook must produce exactly one rebuild across retries and both daylight-saving offsets (10:00 UTC during PDT and 11:00 UTC during PST).

### Materials month walk

- Job: `job-psm-materials`.
- Trigger: `40 1,7,13,19 * * *` UTC (four walks a day).
- Required hook: the `main` entrypoint of `workers/ingest-materials.ts` with `--mode incremental --hot-window-days 7 --request-limit 8000 --auto-close-prior-month`.
- Required behavior: discover only jobs completed in the most recent seven Pacific business dates, then refresh older jobs only when the complete, gap-free `job_logs` watermark names an already-mirrored job through `metrics.source_change_events`. It replaces each selected job's mirrored lines atomically and refreshes the persistent `metrics.catalog_groups` cache, then rebuilds affected `materials` read models. Once per month, the same scheduled job authoritatively walks the just-closed prior month; a database boundary check makes successful closes idempotent and retries missing or failed closes on the next scheduled run. Incremental passes never delete jobs absent from the seven-day discovery window. `/materials` continues to serve `dashboard_read_models` without request-time Simpro traffic.

### Materials full-month reconciliation

- Invocation: operator/reconciliation run after month close (it is intentionally separate from the bounded four-times-daily job).
- Required hook: `workers/ingest-materials.ts --mode full-month --months-back 1 --request-limit 8000`.
- Required behavior: authoritatively discover and walk the current and prior Pacific months, then seal only those fully discovered months in `metrics.materials_month_walks`. This is the deletion/reconciliation path for jobs that moved, were removed, or were never eligible for incremental change-log refresh. Backfills use the same `--mode full-month --from YYYY-MM --to YYYY-MM` path. A failed full-month walk records `status = 'failed'` and retains the last complete mirror.

### Hot-window ingestion and overlap control

- Current Jobs and Quotes discovery use a seven-day completion/update window instead of re-enqueuing ninety daily partitions every twenty minutes. Durable candidate queues and the reconciliation schedules above remain responsible for retries and older-history correction.
- Candidate ingestion runs at minutes 2 and 32; rollup draining runs at minutes 12 and 42. Each worker lane holds a database-backed, expiring execution lease, so Azure starting a new execution while the previous one is still active becomes a cheap no-op rather than another competing database workload.
- Employee and commission local-time jobs run only at the two UTC hours that cover their Pacific target hour across daylight-saving changes. Their local-hour and idempotency guards remain authoritative.

## Deployment Checklist

1. Run worker tests covering cursor resume, request/runtime exhaustion, month boundaries, DST transitions, retries, and same-local-date idempotency.
2. Build Bicep and run `npm run test:infra` to prove every declared job is included in monitoring.
3. Review metrics and monitoring deployment what-if output before applying the schedules.
