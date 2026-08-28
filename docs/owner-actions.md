# Owner-authorized actions

These procedures are intentionally not executed by local stabilization work. Each begins with a recorded owner decision and ends with read-back evidence.

## Repository authority, visibility, Pages, and CI

1. Choose the repository and authoritative branch. This checkout currently has no Git remote, so verify the target independently before adding one; do not infer it from stale docs.
2. Preserve the current visibility, Pages source, default branch, collaborators, rulesets, and deploy keys as a rollback receipt.
3. Because tracked history contains internal names and topology, the recommendation is private visibility and Pages disabled unless the owner explicitly accepts public exposure.
4. Push `codex/stabilization-2026-08-28` without force, open a pull request, and require the prepared read-only CI checks on the selected default branch. Block force pushes and branch deletion; require pull requests and green exact-SHA checks.
5. Test with one harmless failing PR and one green PR. Read back visibility, Pages state, default branch, protection/ruleset, workflow permissions, and the merged commit. Restore the recorded settings if authorized users lose access.

## Second preservation copy

1. Select encrypted, access-controlled storage owned by the business—not another unprotected working folder.
2. Copy only the `preservation/2026-08-28/` evidence set; do not add ignored credential files.
3. From the destination, independently verify every hash in the preservation manifests.
4. Record destination class/custodian, access list, verification date, and manifest hash. Do not record a credential or a public share link.
5. Only after successful verification may the owner separately authorize deletion of an obsolete source copy.

## Production release and release-authority receipt

1. Approve a window and use only `npm run deploy:prod -- --full` as documented in [`../DEPLOY.md`](../DEPLOY.md).
2. Before release, record current app revision/digest, 24 job images, 100% traffic target, migration ledger/hashes, and rollback digest using read-only Azure/PostgreSQL access.
3. Release the reviewed exact commit; retain the generated evidence and sanitized receipt.
4. Read back the candidate revision and every job image, prove the migration ledger, run authenticated page/API smoke checks, confirm 100% sole-revision traffic and database health, and verify the temporary firewall rule is absent.
5. If any acceptance check fails, let the canonical transaction restore the prior immutable contract and stop. Do not repair queues during a failed release.

## Exact future-schedule replay

Only after the fixed image is verified live, supply the database connection through the trusted environment and preview a small batch:

```bash
npm run queue:repair -- --entity schedules --error-contains "Unable to queue technicians rollup for 2026-09-01" --limit 20
```

The preview must contain only reviewed failures caused by the documented future-month defect. If it does, execute the same predicate with an authorized owner identity and incident reason:

```bash
npm run queue:repair -- --entity schedules --error-contains "Unable to queue technicians rollup for 2026-09-01" --limit 20 --execute --actor-email <authorized-owner-email> --reason "Replay reviewed future-schedule failures after verified fixed-image release"
```

Compare returned IDs to the preview, then let the normal bounded worker drain them. Re-read dead letters, source run state, reconciliation, rollup, and page freshness. Stop if the match set differs, a new failure appears, or scope expands. Repeat only with a newly captured preview; never raise the predicate to a generic error or reset the full queue.

## Credentials and access

The full-history scan found no confirmed committed credential, so do not rotate indiscriminately. For a proven exposure or scheduled rotation:

1. Inventory secret names and consumers without printing values; identify the owner, canonical Key Vault secret, managed-identity references, release-only migration credential, Easy Auth registration, and any local ignored copies.
2. Create a new version in the canonical provider, update versionless Key Vault-backed consumers, and verify reference/read access without exposing the value.
3. Deploy or restart through the canonical workflow and prove health, bounded Simpro access, database TLS access, authentication, and job execution.
4. Revoke the old provider credential only after every consumer is verified. Record secret name, version identifiers, timestamps, actors, and validation—not values.
5. Remove obsolete local copies only after the second preservation copy and explicit owner authorization. Re-run the redacted history/worktree scan.

## Recovery drill

Approve an isolated PostgreSQL point-in-time restore and follow [`recovery.md`](recovery.md). The restored target must have no production traffic or jobs. Record sanitized RPO/RTO, migration-ledger verification, representative invariants, and cleanup approval.

## Business decisions

- Set and record the commission/payroll cutoff before review. A period must be current, immutable, source-complete, reconciled, and cent-exact; otherwise defer the decision.
- Confirm the two authorized application owners and alert recipients. Any allowlist or recipient change requires explicit owner approval, a tested access path, and a rollback identity.
- Decide whether public repository/Pages exposure is intentional. Silence is not acceptance.
