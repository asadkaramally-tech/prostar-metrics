# Public repository and local exposure scan — 2026-08-28

## Outcome

The public Git history scan found **11 automated matches and no confirmed committed credential** after manual structural triage. The matches are Azure built-in role IDs, deliberate test fixtures, a test idempotency key, and noncredential UI/test keys. This lowers—but does not eliminate—the risk that a credential was committed.

Two ignored `.env.local` files are byte-identical and each contains one value that Gitleaks classifies as a generic API key. The files were not found in the scanned Git history. They are local credential copies and should be retained only until the owner verifies the canonical values are recoverable from Key Vault or the approved secret store.

The public repository still exposes internal operational information: named people/customers/jobs in tracked design evidence, Azure resource names and identifiers, infrastructure topology, and historical public IP addresses. Repository visibility therefore remains an owner decision even without a confirmed credential leak.

## Scope and method

- Tool: locally installed Gitleaks, default rules, full redaction.
- Git target: `/Users/asadkaramally/Documents/Codex/2026-07-27/prostar-metrics`.
- History result: 73 commits, approximately 34.83 MB scanned, 11 matches.
- Dirty/untracked preservation overlays: approximately 391 KB decoded/scanned, zero matches.
- Local credential copies: the two known ignored `.env.local` files, scanned separately with redacted reports.
- Reports contain redacted matches only; no credential value is recorded in this workspace.

This was a pattern scan, not proof that every historical binary/image/archive is harmless. Gitleaks did not report a confirmed secret, but visibility review must also consider nonsecret business and infrastructure information.

## Triage of the 11 history matches

| Category | Count | Disposition |
|---|---:|---|
| Azure built-in role-definition UUIDs | 5 | False positive; identifiers are not credentials |
| Deliberate sanitizer/security test fixtures, including a synthetic JWT and fake principal IDs | 3 | False positive; tests intentionally contain secret-shaped values to verify rejection/redaction |
| Test idempotency key | 1 | False positive; noncredential test input |
| `aggregate12Key` values duplicated in a tracked redesign patch | 2 | False positive; UI/test aggregation keys, not authentication material |

The redacted machine report is [`gitleaks-history-2026-08-28.json`](./gitleaks-history-2026-08-28.json). Do not replace the false positives with a broad ignore. If CI is added, use narrow fingerprint/path-and-rule exceptions with comments so new findings still fail closed.

## Local `.env.local` finding

- Present in the July 27 and restyle checkouts.
- Files are ignored by Git and byte-identical to one another.
- Each produces one redacted `generic-api-key` finding at the same line.
- Neither file was copied into preservation artifacts.
- No matching tracked `.env.local` path was found in the 73-commit history scan.

Required disposition:

1. Confirm the corresponding runtime credential exists and is usable in Key Vault or the owner-approved secret source.
2. Determine whether any other archived checkout contains the same file.
3. Do not print or paste the value into an issue, CI log, document, or chat.
4. Remove duplicate local copies only after preservation/source work no longer needs them and the owner authorizes cleanup.
5. Rotate only if a later scan or access record shows exposure, or the owner chooses precautionary rotation.

## Visibility recommendation

Recommended owner choice: make `prostar-metrics` private and disable GitHub Pages after confirming no operational dependency uses Pages. This recommendation is based on internal-data/topology exposure, not a claim of credential compromise.

Before changing settings, preserve the current repository/Pages configuration and confirm that the deployment pipeline pulls from GitHub in a way compatible with a private repository.
