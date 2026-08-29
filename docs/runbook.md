# Operations runbook

## Read-only triage

1. Open Data Health as an authorized owner and record the generated time, page states, source failures, dead letters, pending backfill units, and queued/running work.
2. Run `npm run audit:production-state` from an authenticated, secret-supplied environment. Preserve its sanitized output with the incident record.
3. Identify the smallest failing scope: source family, entity ID, period, generation, and queue/request ID. Separate source ingestion, reconciliation, rollup, and serving failures; they are different stages.
4. Confirm whether the running image contains the relevant fix before changing queue state. A known-bad image must not replay known-bad work.
5. Capture before counts and the exact success condition. No repair is approved merely because an alert disappears.

## Bounded repair contract

All production repairs require an owner-approved change window and must be dry-run first. Use the narrowest existing command documented by its `--help`/argument parser. Record actor, scope, confirmation token, before counts, predicted writes, and rollback condition.

For the documented future-schedule dead letters:

1. Deploy the fix through the canonical full release path.
2. Re-read health and select only failures whose error and affected scope match the future-month rollup defect.
3. Dry-run the bounded queue repair for those exact IDs/scopes. Do not reset all queues or all-month cursors.
4. Execute only if the dry-run set equals the reviewed set.
5. Drain with existing worker request/runtime caps; verify source completion, matched reconciliation, rebuilt read model, and absence of a replacement dead letter.
6. Stop and roll back the candidate image if failure count grows, scope expands, reconciliation mismatches, or serving health regresses.

## Commission decision safety

Never treat a building, failed, stale, non-current, or source-incomplete commission period as payroll-ready. Before a payroll decision, the owner must set the decision cutoff and verify the selected period has a current immutable run, complete source evidence, matched job reconciliation, cent-exact pool invariants, and the intended configuration revision. Export/lock only through the existing guarded workflow.

## Evidence to retain

Keep the incident timestamp, live image digest, job image digests, migration ledger, sanitized health snapshots, exact repair selection, dry-run and execution output, post-repair reconciliation, and final smoke result. Never store credentials or raw production exports in Git.
