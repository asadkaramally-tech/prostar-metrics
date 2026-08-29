# Architecture

The application is an owner-facing Next.js dashboard backed by app-owned Azure PostgreSQL data. It does not use Simpro as a live page backend.

```text
Simpro API
   │ bounded, rate-limited background reads
   ▼
Container Apps jobs ──► raw/canonical PostgreSQL tables
   │                              │
   ├── reconciliation evidence    ├── deterministic rollups
   └── durable queues/leases      ▼
                           dashboard read models
                                  │ authenticated reads
                                  ▼
                        Next.js pages and API routes
```

## Authority boundaries

- Simpro is authoritative for source records the integration actually supports.
- PostgreSQL source manifests, generations, exact-ID hashes, reconciliation rows, and migration ledger prove what was imported and whether it is usable.
- Persisted dashboard read models are the request-serving authority. A page does not reconstruct truth from Simpro during a request.
- Commission results are immutable calculated runs tied to source/config evidence. Missing or incomplete evidence must remain unavailable rather than becoming zero.
- Easy Auth authenticates users; application role checks authorize each protected API. Only `/api/health` is public.
- Azure Key Vault references supply runtime secrets through managed identity. Secrets are not build inputs or repository files.

## Change boundaries

- Web/API changes belong under `src/`; ingestion and reconciliation under `workers/` and `scripts/`; infrastructure under `infra/azure/`; ordered schema changes under `infra/db/migrations/`.
- Existing migrations and signed evidence are immutable. Corrections are additive.
- The app and exact 24-job set are released together from a digest-pinned image by the canonical deploy command.
