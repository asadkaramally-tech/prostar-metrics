# Recovery and preservation

## Source preservation

The first local evidence copy and hashes are described under `preservation/2026-08-28/`. Before deleting any old checkout or archive, copy that preservation directory to owner-selected protected storage, verify every recorded SHA-256 from the second location, restrict access, and record only the storage class, custodian, verification date, and manifest hash in Git.

Do not copy `.env.local`, Azure CLI profiles, credentials, or unrelated user files into the preservation set.

## Application rollback

The canonical deploy command captures the previous digest-pinned app/job state and automatically restores it when candidate verification fails. Do not improvise a tag-based rollback. A manual recovery must use the last verified immutable digest and restore the exact app, 24-job, traffic, identity, and configuration contract together.

After rollback, prove database-aware health, sole-revision 100% traffic, Easy Auth behavior, page/API smoke results, all job images, temporary firewall absence, and migration compatibility. Applied migrations are not automatically reversed; only additive backward-compatible migrations may enter the routine release path.

## Database recovery drill

An Azure/PostgreSQL owner must schedule and record a restore drill in an isolated target:

1. Select a documented backup/PITR timestamp and create an isolated restored server/database.
2. Deny public application traffic and production job access to the restored target.
3. Verify the migration ledger and hashes, critical table/read-model counts, source/reconciliation evidence, and representative commission invariants.
4. Run read-only application health against the isolated target; do not point production DNS or jobs at it.
5. Record recovery-point and recovery-time measurements, discrepancies, cleanup approval, and sanitized evidence.

No restore drill has been performed as part of the 2026-08-28 local stabilization work.
