# Local stabilization worklog — 2026-08-28

## Plain-English outcome

The strongest verified source is now in a real local working branch, the two most direct code defects are fixed, the dependency tree is patched, and a read-only CI workflow is ready. The complete local test/build baseline is green.

Nothing was deployed. Production, PostgreSQL, Simpro, GitHub settings, credentials, alert recipients, and queued work were not changed. The live health backlog therefore remains until an owner approves a release and a separate bounded repair/replay plan.

## Working baseline

- Branch: `codex/stabilization-2026-08-28`.
- Parent: `7571b13bdfa155693cddf2f284c2275a9c11df01`.
- That parent reproduces the Docker context hash recorded for live Azure revision `aca-prostar-metrics-prod--0000152`.
- No Git remote is configured in this audit workspace, and nothing was pushed.

## What changed

### 1. Candidate work was preserved locally

Dirty overlays, untracked files, and otherwise unreachable Git trees from the candidate checkouts were exported and hashed. The binary payloads are ignored so they cannot accidentally enter the currently public repository. No `.env.local` or Azure profile was copied.

This is the first copy only. A second owner-approved protected copy is still required before any old checkout or archive may be deleted. See [`../../preservation/2026-08-28/README.md`](../../preservation/2026-08-28/README.md).

### 2. The future-schedule ingestion defect was fixed

The dead-letter message about being unable to queue a technician rollup for `2026-09-01` has a concrete code explanation: a valid future schedule block caused the parent nested import to request a rollup outside the serving window; the queue correctly refused it, but the caller then treated that refusal as a fatal ingestion error.

The normalizer now defers only valid future months. Past/current months still queue normally, and malformed dates still fail closed. This prevents future schedule data from poisoning an otherwise valid parent import without weakening date validation.

This code fix does not clear the existing production dead letters. Those should be replayed only after the fix is deployed and the exact affected scopes are reviewed.

### 3. The chart injection path was removed

Heatmap and bullet charts now render database/Simpro labels through React text nodes. Shared tooltip helpers escape source-controlled text and reject unsafe color values. Histogram and horizontal-stack tooltip extras are treated as plain text.

Regression tests use malicious markup/event payloads and prove they render as text rather than executable elements. Existing visual markup contracts remain covered.

### 4. Dependencies and runtimes were patched and pinned

Next.js moved from 16.2.9 to 16.3.3, its lint configuration was kept aligned, and vulnerable transitive parser/build/image packages were updated. Both complete and production-only npm audits now report zero known advisories. See [`../security/2026-08-28-dependency-audit.md`](../security/2026-08-28-dependency-audit.md).

The project now declares Node 24.x, npm 11.x, and `npm@11.6.2`. The local run used Node 24.13.0 and npm 11.6.2.

### 5. Read-only CI is ready as code

`.github/workflows/ci.yml` has two nondeploying jobs:

- a quality job that installs from the lockfile, checks advisories, runs the repository evidence gates, lint, type-check, and production build;
- a full-history Gitleaks job with only the 11 manually reviewed false-positive fingerprints ignored.

Third-party actions are pinned to immutable commits and workflow permissions are read-only. The workflow has not been pushed or enabled, and branch protection has not been changed.

### 6. A date-dependent test was made deterministic

The current-month evidence test used a fixed July 2026 timestamp and began failing in August. It now uses the same database clock that selects the current Pacific month. Production stale-evidence validation remains unchanged.

## Verification receipt

| Gate | Result |
|---|---|
| Install from lockfile | Passed |
| Full application/store suite | 1,035 passed; 0 failed |
| Script/evidence suite | 397 concrete assertions passed |
| Infrastructure suite | 165 concrete assertions passed |
| Feature-plan check | 98 records validated |
| Reference-manifest check | 4 artifacts and 5 sidecar hashes validated |
| No-mirror guard | Passed |
| TypeScript | Passed |
| ESLint | 0 errors; 3 nonblocking warnings |
| Production build | Passed; 29 pages generated and build evidence validated |
| Full dependency audit | 0 known vulnerabilities |
| Production dependency audit | 0 known vulnerabilities |
| Full-history secret scan | 73 commits scanned; no unignored findings |
| Patch whitespace check | Passed |

## Still requires an owner decision or production authority

1. Choose protected storage for the second preservation copy.
2. Decide whether to make GitHub private and disable Pages.
3. Decide which maintained branch becomes authoritative, then enable the prepared CI and branch protection.
4. Approve a guarded production release; do not replay failed work before the fixed image is live.
5. After release, re-read Data Health and prepare a bounded dead-letter/rollup repair with before/after counts and rollback criteria.
6. Finish the release receipt for the 24 job image digests, migration ledger, smoke result, and rollback digest.
7. Confirm the August commission/payroll decision cutoff before treating any incomplete period as usable.

Accessibility, commission-row request isolation, modal focus, freshness wording, and narrow-screen layout remain valid Phase 1 work. They were not mixed into this stabilization patch.
