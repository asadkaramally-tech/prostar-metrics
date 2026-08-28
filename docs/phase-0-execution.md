# HISTORICAL — Phase 0 Execution Notes

This is an early implementation snapshot, not a current readiness checklist. See [`index.md`](index.md) and [`roadmap.md`](roadmap.md).

## Implemented

- `F-01`: App Router scaffold with four v1 routes.
- `F-02`: Initial Azure PostgreSQL migration for snapshots, rollups, ingestion, overrides, exports, roles, audit, reconciliation, and commission revision tables.
- `F-03`: Server-side role scaffold using Azure Easy Auth / Entra headers, with local dev bypass disabled by default.
- `F-04`: Simpro REST client scaffold with pagination, retry/backoff, 429/5xx handling, request timeout, and typed endpoint wrappers.
- `F-05`: Ingestion queue helpers with locks, retry fields, continuation token, priority, idempotency key, and request budget.
- `F-06`: Central Simpro rate limiter defaults to 5 requests/second.
- `F-07`: Freshness state helpers and data-through banner component.
- `F-08`: No-mirror guard script.
- `F-09`: No static/demo business data path added.
- `F-10`: Reconciliation worker scaffold.
- `F-11`: Ops baseline documented as migration and environment assumptions; Azure resource provisioning remains an external deployment task.

## Still Required Before Closing Gate G-0

- Apply migrations to an actual Azure PostgreSQL dev database and capture output.
- Configure Entra / Easy Auth in the Azure Container App and capture a protected page screenshot.
- Run a bounded Simpro sample pull with real credentials.
- Execute sample ingestion into the app-owned tables.
- Prove queue lock/retry behavior against the dev database.
- Rotate any leaked historical secrets before production promotion.
