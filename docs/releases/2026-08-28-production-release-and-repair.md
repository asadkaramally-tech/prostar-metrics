# Production release and bounded repair receipt

Status: complete with explicitly deferred source-completeness work. Times are UTC.

## Release identity

- Source commit deployed: `017cb871d13e506fb21223b1828e8ca65a92dbb7`
- Azure deployment: `prostar-metrics-944ae74c-730d-43ee-972f-1237fd87b0f4`
- Completion: `2026-08-29T01:42:37.778Z`
- Container App revision: `aca-prostar-metrics-prod--0000153`
- Image digest: `sha256:a5a146f480db5377294155a803e1fa6cbde6b0797c92da5e706d32d624a8b0e8`
- Traffic: 100% to revision 153; database-aware health passed.
- CI: both required workflows passed for the exact release commit and the later evidence-only commit.

The release used only `npm run deploy:prod -- --full` from an isolated worktree. Its full preflight observed 1,039 application assertions, 399 script assertions, and 165 infrastructure assertions.

## Bounded repairs

The guarded repair command previewed exact IDs and counts, then required those same IDs during execution. It did not replay a broad queue.

- Schedule dead letters: 76 August 2026 rows, 85 September 2026 rows, and 1 October 2026 row requeued.
- Nested jobs: 11 September 2026 rows and 1 March 2021 row requeued.
- Exact backfill controls: Jobs record 422 and Quotes record 421 requeued.
- Bounded Jobs, Schedules, and Backfill worker executions all succeeded.
- No failed ingestion rows remained in the post-repair check.
- August Jobs and Technicians rollups rebuilt successfully.

The rollup drain correctly refused to publish July or August commissions because their source manifests were incomplete. That refusal is a safety success, not a payroll-ready result.

## Deferred residual work

Two September schedule rows and the exact Jobs/Quotes/Nested manifests remain queued pending source-complete traversal. The shared workers could claim unrelated queue work, so another broad run was not authorized. These records remain visible and fail closed; no health indicator was cosmetically forced green.

