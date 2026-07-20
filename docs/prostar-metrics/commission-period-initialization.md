# Historical Commission Period Initialization

This runbook initializes commission period prerequisites from January 2023 through an explicit/current Pacific month. It does not ingest from Simpro, call Azure, publish an export, change a payout formula, or calculate a payout itself. The existing commission rebuild runtime remains the only calculator.

The initializer is dry-run by default. `--execute` writes period/config evidence, immutable initialization audits, and exact monthly commission queue records in one serializable transaction. Missing config evidence is represented by the exact migration-019 predecessor and migration-025 successor rows plus both exact immutable audits; a lone current config row is never canonical. Only Asad or Laila can execute it.

## Locked Policy Boundary

The initializer authenticates these whole repository files before opening PostgreSQL:

- `docs/prostar-metrics/reference/commissions-dashboard.html`, SHA-256 `037b1f6e0e5b7a4156a8eee8180307e92dfc3f0f17b8f19b5ea7011f2852538b`;
- `docs/prostar-metrics/execution-plan.md`, SHA-256 `7392ad68fb810b840175604291a9b43cb57a3a4dce23de546f3e1c057abca3e5`, controlling Section 6.4;
- migration 009, SHA-256 `3601b7b7dbf0031f59828600ef4726cf616006c79875a2c3ac9b923d3c8599b5`;
- migration 019, SHA-256 `32a9947998e3e8c7e7f0403ef87b18ca53b2536d78a1a4892d738ef3cf5a5f60`;
- migration 025, SHA-256 `68437467608d41cfe828a03c9f5a2637b079a6feb0dc6a5169a96f6446bc1178`;
- additive migration 036, SHA-256 `98e180287fb96ace8237581e3d658a6bc6ace07c92ccef7e66ee854a5462db58`.

The latest active config must have canonical hash `719dd0fb880a4ffd7447f35a97b8989a0c9bbf1350071edbcc5fb708ffa574fc`: pool factor `0.50` (50%), minimum threshold `5`, `efficiencyEnabled=false`, persisted efficiency bound `20`, and Gold/Silver/Bronze/Standard multipliers `1.30/1.20/1.10/1.00`. The only accepted inactive history is the exact repository-authenticated migration-019 predecessor, hash `5966f042954aea4d9e8d7499655b76f7d4df9748693972cd386a8a7fb6735553`, contiguously superseded by the exact migration-025 row and both immutable migration audits. Runtime owner config audits do not carry source evidence, so an Asad/Laila email is not enough to approve a historical formula deviation. Efficiency enabled, a `0.55` pool factor, altered inactive history, a chain gap, or a duplicate active row aborts the full range.

Migration 036 is additive. It makes override approval, initialization, and failed-queue repair audits immutable and enforces one initialization audit per period. Its canonical views reconstruct the exact 019-to-025 config lineage and recompute roster and effective-override SHA-256 values from authoritative rows and their exact audits. Applied migrations 009, 019, and 025 remain unchanged and are checked through `metrics.schema_migrations` parent gates.

## Fail-Closed Checks

Before any write, the initializer validates the complete requested range:

- exact month dates and contiguous period revisions/supersession;
- exact locked config JSON, scalar columns, revision, hash, actor class, and active state;
- exact migration-019 to migration-025 config supersession and both exact immutable evidence audits;
- exact migration-009 roster rows and seed audits effective for each month;
- every override row and its effective recipient, Asad/Laila actor, typed runtime semantics, revision/before-value/supersession chain, SHA-256 idempotency evidence, and exact immutable `commission_override_revised` audit;
- every prior initialization audit field, including period/config actions, roster IDs/count/hash, override IDs/count/hash/audit IDs, all source paths/hashes, and exact queue identity;
- current run ownership (`run.period_id = period.id`) and the canonical serving verifier: immutable succeeded run, complete source and manifest evidence, exact config revision/hash, exact override hash, replayed results/calculation hash, and no stale/source-changed flag.

A corrupt or foreign current run is not publishable and is queued for rebuild. Missing/tampered audits, outsider or out-of-roster overrides, duplicate active records, arbitrary unaudited payouts, protected periods with missing config, and failed initialization queues are conflicts. No partial months are committed.

## Production Runbook

These commands only target Metrics PostgreSQL. Set the production PostgreSQL connection through the repository's normal secret injection before running them. Do not add Azure or Simpro credentials to these commands.

### 1. Apply and verify migrations

Use the normal hash-checking migration runner. It proves the live parent baseline and applies additive migration 036 without rewriting prior migrations:

```bash
npm run migrations:apply
npm run migration:compatibility:check
```

### 2. Accept source reconciliation prerequisites

Run the read-only prerequisite contract before initialization or drain:

```bash
npm run commissions:initialization-queue -- --prerequisites --through 2026-07 --actor asad@prostarmechanical.com
```

For January 2023 through July 2026, accept only:

```json
{
  "throughMonth": "2026-07",
  "ready": true,
  "sourceUnitsExpected": 215,
  "sourceUnitsAccepted": 215,
  "reconciliationsExpected": 86,
  "reconciliationsAccepted": 86,
  "rejected": []
}
```

This is the exact locked-policy prerequisite: five completed/matched source-ledger families and authoritative matched `jobs` plus `technicians` reconciliation per month, with current complete source-manifest generations. Do not initialize or drain while `ready` is false.

The initializer probes this contract again inside its serializable transaction immediately before writing. Failed repair probes happen before queue mutation in that repair transaction. The drain performs the complete range prerequisite probe in the same process before any claim; direct claim callers that do not carry that verified range state still call `metrics.commission_initialization_prerequisites_accepted(period_start)` atomically for the selected month.

### 3. Dry-run

```bash
npm run commissions:initialize-periods -- --through 2026-07 --actor asad@prostarmechanical.com --dry-run
```

Require `monthCount: 43`, no conflicts, the locked config hash for every month, exact effective roster/override evidence, and only expected create/preserve/queue actions.

### 4. Execute

Use the exact token printed by dry-run:

```bash
npm run commissions:initialize-periods -- --through 2026-07 --actor asad@prostarmechanical.com --execute --confirm INITIALIZE-COMMISSION-PERIODS-2023-01-THROUGH-2026-07
```

Execution automatically retries PostgreSQL serialization failures up to three total attempts. If all attempts fail, run the dry-run again, inspect concurrent period/config/override/queue changes, and then rerun the same execute command. Never work around a conflict with direct table edits.

### 5. Rerun and inspect exact queue scope

The execute command is idempotent. Rerun dry-run immediately, then inspect only initialization-audited queue IDs:

```bash
npm run commissions:initialize-periods -- --through 2026-07 --actor asad@prostarmechanical.com --dry-run
npm run commissions:initialization-queue -- --status --through 2026-07 --actor asad@prostarmechanical.com
```

A converged initialization reports zero period/config/audit/queue writes. Before drain, the status report should show 43 audited periods and the expected linked queue inventory.

### 6. Drain at most 43 exact commission jobs

This drain claims only queue IDs whose full immutable queue identity is linked from a version-2 initialization audit: exact ID, v2 key and reason, commissions/month/empty-dimensions scope, migration-036 creation bound, and latest period revision. It cannot claim quote, job, technician, generic commission, tampered initialization, or out-of-range queue records. Immutable run persistence, `current_run_id`, `dashboard_read_models`, and exact one-row queue completion commit in one owner- and live-lease-fenced transaction. A scope mismatch, expiry, owner replacement, dashboard failure, or completion failure rolls that transaction back without partial publication.

```bash
npm run commissions:initialization-queue -- --drain --through 2026-07 --limit 43 --actor asad@prostarmechanical.com --confirm DRAIN-COMMISSION-INITIALIZATION-2023-01-THROUGH-2026-07
```

Monitor without claiming work:

```bash
npm run commissions:initialization-queue -- --status --through 2026-07 --actor asad@prostarmechanical.com
```

Do not use the general rollup worker for this historical operation; its commission scope is broader than initialization-audited queue IDs.

### 7. Repair an explicitly failed queue record

The initializer intentionally refuses to recycle a failed queue. After correcting and accepting the source reconciliation failure, repair exactly one failed linked record in place:

```bash
npm run commissions:initialization-queue -- --repair-failed --month 2023-01 --actor laila@prostarmechanical.com --reason "Accepted source reconciliation repair evidence for January 2023." --confirm REQUEUE-COMMISSION-INITIALIZATION-2023-01
```

Then rerun `--status`, the initializer dry-run, and the bounded drain. Repair is serializable, audited, prerequisite-gated in the same transaction, and retries SQLSTATE `40001` up to three total attempts. After exhausted retries, inspect status first; rerun repair only if that exact record remains `failed`. A record with a changed key, reason, timestamp, scope, period revision, or audit linkage is not repairable by this command; investigate the immutable evidence conflict instead of editing it in place.

### 8. Verify canonical completion

The initializer dry-run uses the same canonical integrity verifier as serving/runtime. This command succeeds only when all 43 latest periods are canonically publishable and initialization has no remaining writes:

```bash
npm run --silent commissions:initialize-periods -- --through 2026-07 --actor asad@prostarmechanical.com --dry-run \
  | jq -e '.monthCount == 43 and .summary.periodsToCreate == 0 and .summary.configsToEvidence == 0 and .summary.evidenceAuditsToWrite == 0 and .summary.rebuildsToQueue == 0 and all(.periods[]; .runIntegrity == "publishable" and .rebuildAction == "not_needed")'
```

Finally run the repository-wide strict audit:

```bash
npm run audit:production-state -- --strict --summary
```

Publication remains blocked until both canonical completion and strict audit pass. Initialization only creates/evidences prerequisites and queues the existing fully functional runtime; it never applies labor-efficiency payout changes or fabricates policy.
