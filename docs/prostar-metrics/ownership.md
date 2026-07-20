# Pro Star Metrics Execution Ownership

This file implements G-0 ownership. Agents must not edit another owner's paths without Integration Owner coordination.

| Owner | Work packages | Primary paths |
| --- | --- | --- |
| Integration/Storage | WP-00, shared integration | infra/db/migrations/**, docs/prostar-metrics/**, src/lib/store/read-model-rebuilds.ts |
| Production Entry | WP-01 | Dockerfile, infra/azure/metrics.bicep, production host-binding validation |
| Data Contract | WP-02 | src/lib/simpro/**, docs/prostar-metrics/data-dictionary.md |
| Pipeline | WP-03, WP-04 | workers/**, ingestion/freshness/reconciliation store modules, Azure job definitions |
| Quote Metrics | WP-05A/B/C | quote metrics/read models/API/components |
| Job Metrics | WP-06A/B | job metrics/read models/API/components |
| Technician Performance | WP-07 | technician metrics/read models/API/components |
| Commissions | WP-08, WP-09A/B/C | commission metrics/store/API/components/export generators |
| Infrastructure | WP-10 | infra/azure/** excluding coordinated WP-01 host change |
| Verification | WP-11 | tests/** and verification evidence; no primary production implementation |

## Shared Files

- src/lib/store/read-model-rebuilds.ts remains Integration/Storage-owned until split by domain.
- src/lib/store/postgres.ts and shared auth modules require Integration Owner review.
- package.json and package-lock.json require Integration Owner coordination.
- Migration 004 and every later number are reserved and created only by Integration/Storage.

## Merge Order

1. WP-00 traceability and reference lock.
2. WP-01 production entry.
3. WP-02 contracts and additive migrations.
4. WP-03/WP-04 pipeline and source facts.
5. Domain formula packages before their UI/read-model dependents.
6. WP-10 infrastructure changes.
7. WP-11 release verification.
