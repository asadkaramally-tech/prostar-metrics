# Pre-release production baseline — 2026-08-28

Captured read-only at approximately 21:06 UTC before any stabilization release.

## Azure application contract

- Subscription: `d7a98155-9693-4c6b-ad27-39e945c0f751` (`Azure subscription 1`).
- Resource group: `prostar-payroll`.
- Web app: `aca-prostar-metrics-prod`.
- Revision mode: `Single`; latest and latest-ready revision: `aca-prostar-metrics-prod--0000152`.
- Provisioning: succeeded; revision 152 was healthy with 100% traffic at the preceding live-state verification.
- Rollback image: `acrprostardispatchprod.azurecr.io/prostar-metrics@sha256:074bf8f5ff7915f43c775c04821f72ce9515fe15b0587fda31d508b4d96090b7`.
- All 24 Metrics Container App jobs were provisioned successfully and used that same immutable digest. The unrelated Verizon job was excluded from the Metrics contract.
- Database: PostgreSQL 17 server `pg-prostar-metrics-prod`, state `Ready`; 35-day retention, earliest reported restore time `2026-07-24T21:54:36.315207+00:00`; geo-redundancy and high availability disabled.
- Key Vault inventory contained the three expected enabled secret names; no values were recorded.
- Temporary `metrics-audit-*` firewall rules were absent after every production read.

## Strict data-state baseline

The checked-in database head was migration `052_close_july_quote_backfills_from_source_period_authority.sql`. Profit/capacity completeness was exact: 12,385 completed jobs with zero missing, 11,198 active completed cost centers with zero missing, and 43 people with zero missing.

The strict audit correctly failed before release. Sanitized blockers were:

- schedule ingestion: 76 failed August rows, 53 failed September rows, one failed October row, and 24 queued September rows, all on the out-of-serving-window technician-rollup error;
- nested jobs: three failed September rows, one failed March 2021 row, and six queued September rows on the same error class;
- July backfill: `jobs` and `quotes` dead-lettered after losing reconciliation leases; their source-period manifests remain suspect/mismatched, so they cannot be closed from existing authority;
- July nested backfill: `job_nested` remains queued with a suspect/mismatched manifest; `quote_nested` remains queued with partial coverage (119 of 124 pages);
- rollups: unlocked queued work remained for April through August; one August commission rebuild failed closed because `source_complete` was false;
- August commission period remained draft, stale, and unpublished. It is not payroll-ready.

The stabilization source now defers valid technician-rollup months on both sides of the supported January-2023-through-current window. Malformed dates still fail closed. Post-release repair must use exact previews, requeue only the named error classes, rerun the two dead-lettered backfills rather than falsely completing them, drain bounded rollups, and repeat the strict audit.

## GitHub baseline

- Repository: `asadkaramally-tech/prostar-metrics`; default branch `main`.
- Visibility: public.
- GitHub Pages: published from `main` root at the repository Pages URL.
- Classic branch protection: none.
- Workflow token default: read-only contents/packages; Actions could use any action, and full-SHA pin enforcement was off.
- The local GitHub CLI credential was invalid, while the owner's signed-in Chrome session could access settings.

This file records a rollback/before-state receipt. It is not evidence that the external changes or production release succeeded.
