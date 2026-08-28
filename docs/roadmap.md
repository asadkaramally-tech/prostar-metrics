# Audit improvement roadmap

Status date: 2026-08-28. “Implemented locally” means code and regression coverage exist in this branch; it does not mean production changed.

| Workstream | Status | Closure evidence / next authority |
|---|---|---|
| Preserve candidate evidence | Partial | First hashed local copy complete; owner must select and verify a second protected copy. |
| Establish release authority | Partial | Live revision 152 and source-context binding recorded; owner-authorized production query must add 24 job digests, migration ledger, smoke result, and rollback digest. |
| Diagnose future-schedule dead letters | Implemented locally | Valid future rollups are deferred; deploy first, then use the bounded repair procedure in `runbook.md`. |
| Dependency and injection security | Implemented locally | Patched dependency tree, escaped/React-rendered source labels, regression tests, zero known npm advisories at local verification. |
| CI and secret scanning | Prepared locally | Read-only workflow and reviewed Gitleaks allowlist exist; repository owner must push, enable required checks, and protect the authoritative branch. |
| Deployment gate | Implemented locally | Changed source/dependencies now fail routine mode without an exact full-preflight certificate; `--full` is the only certificate-producing path. |
| Accessibility and interaction | Implemented locally | Native sort buttons, keyboard disclosures, focus trap, focusable definition tooltips, per-row request isolation, and tests. |
| Freshness and coverage language | Implemented locally | Header separates “data through” from pipeline check age; materials wording no longer implies unproven current coverage. |
| Narrow mobile layout | Implemented locally | Health control avoids top navigation and recorded-time rows reflow at 480px/320px. |
| Agent/architecture/runbook/recovery docs | Implemented locally | Current authority index and concise operating documents added; stale handoffs labeled. |
| Generated drift inventory | Implemented locally | Deterministic route/API/auth/job/config/migration inventory is checked by Phase 0 and CI. |
| Production release and repair | Owner-authorized | Use `DEPLOY.md`; no production mutation occurred in this work. |
| Repository visibility and Pages | Owner decision | Make private/disable Pages if the repository is not intentionally public; then document the decision. |
| Commission/payroll cutoff | Owner decision | Set the decision cutoff and accept no incomplete/non-current period; follow `runbook.md`. |
| Backup restore exercise | Owner-authorized | Execute the isolated drill in `recovery.md` and record sanitized RPO/RTO evidence. |
| Large-module split / IaC simplification / archive deletion | Deferred maintenance | Do only as bounded, behavior-preserving follow-ups after the stabilization release; no deletion before second-copy verification. |

The branch is ready for owner review only after the clean-install gate in `AGENTS.md` is rerun and its counts are added to the stabilization worklog.

Exact guarded procedures for every owner-authorized item are in [`owner-actions.md`](owner-actions.md).
