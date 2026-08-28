# Sanitized release receipt — revision 152

This receipt combines the ignored deployment manifest in the preserved `candidate-i-work` checkout with a fresh, read-only Azure Portal check on 2026-08-28. It contains no credential values.

| Field | Value |
|---|---|
| Repository | `prostar-metrics` |
| Strongly matched Git commit | `7571b13bdfa155693cddf2f284c2275a9c11df01` |
| Match method | Clean export of the commit independently reproduced the manifest's Docker build-context SHA across 815 entries |
| Docker build-context SHA-256 | `202c4d8be1620da7322a80c73034feb4fa162e2f1dfb649dc6c05eeb4c41eef0` |
| Image digest | `sha256:074bf8f5ff7915f43c775c04821f72ce9515fe15b0587fda31d508b4d96090b7` |
| Azure revision | `aca-prostar-metrics-prod--0000152` |
| Deployed at | `2026-07-23T17:17:31.974Z` |
| Revision created at | `2026-07-23T17:16:10.000Z` |
| Manifest state | `Provisioned`; `Healthy`; 100% traffic to revision 152 |
| Raw manifest SHA-256 | `e358e29fedb33f09087a539b01442a6f00f00a44e2fc1b214fe1dec8c8a9f8b6` |
| Raw manifest location | `candidate-i-work/docs/prostar-metrics/verification/deployment-manifest.json` (ignored; left in place) |
| Current Azure Portal verification | Revision 152 is the sole active revision, `Running`, with 100% traffic and 1/1 active replicas |
| Current verification date | `2026-08-28` |

## Limits

- The raw manifest omitted the Git commit; the commit identity is a strong independent build-context match, not a field copied from the manifest.
- Azure Portal independently confirmed the current active revision and traffic. It did not expose the image digest in the read-only revision panel; the digest remains bound through the immutable revision's deployment manifest.
- Job images, migration ledger, and rollback digest have not yet been re-queried.
- `DEPLOY.md` naming revision 124 as current is stale relative to this later receipt.
