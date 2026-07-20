# Pro Star Metrics Dashboard

Phase 0 implementation scaffold for the locked Pro Star Metrics Dashboard plan.

The app is intentionally isolated from the existing lead/dispatch platform so the metrics dashboards do not inherit legacy mirror reads or request-time Simpro fan-out. Dashboard routes read the app-owned PostgreSQL serving store. Simpro access belongs to bounded ingestion workers.

## V1 Scope

- Quote Metrics
- Job Metrics
- Technician Performance
- Technician Commissions

The old pending/active job queue, dispatch timeline, and old job detail modal are not part of this app.

## Phase 0 Commands

```bash
npm run guard:no-mirror
npm run test
npm run phase0:check
npm run ingest:worker -- --dry-run --entity quotes --from 2025-01-01 --to 2025-01-31
```

## Data Model

Run the migrations in `infra/db/migrations` against the app-owned Azure PostgreSQL database. The schema includes raw snapshots, rollups, ingestion queue/run state, freshness state, quote and commission overrides, commission calculation runs, exports, roles, audit events, and reconciliation checks.

No production path should depend on demo data, preexisting mirror tables, or broad Simpro calls during page/API requests.
