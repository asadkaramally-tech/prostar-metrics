# Protected preservation receipt — 2026-08-28

The owner-selected second preservation copy completed successfully.

| Field | Verified value |
|---|---|
| Storage class | Private Azure Blob container in the existing Pro Star storage account |
| Custodian | Pro Star Mechanical Services Azure subscription |
| Account | `stprostarmetricsexports` |
| Container | `psm-metrics-preservation` |
| Prefix | `2026-08-28` |
| Public access | Disabled |
| Evidence objects | 41 |
| Total bytes | 417,856,121 |
| Newly uploaded | 41 |
| Reused | 0 |
| Manifest SHA-256 | `eee28399b85b97936cf0dd326333d305a60620a41dbdbb2a777909728157a0f8` |
| Verification | Every uploaded object and the remote `SHA256SUMS` manifest were streamed back and SHA-256 verified |
| Verified at | `2026-08-29T01:24:41.134Z` |

No credential value, Azure profile, `.env.local`, or raw evidence payload is recorded in Git. The transfer used a short-lived container-scoped user-delegation token issued by the production managed identity that already held Blob Data Contributor access. No standing role assignment was added.
