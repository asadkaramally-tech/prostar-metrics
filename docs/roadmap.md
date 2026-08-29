# Audit improvement roadmap

Status date: 2026-08-28. “Implemented locally” means code and regression coverage exist in this branch; it does not mean production changed.

| Workstream | Status | Closure evidence / next authority |
|---|---|---|
| Preserve candidate evidence | Complete | The second protected copy was uploaded to private encrypted Azure Blob storage and every object was read back and SHA-256 verified; see `releases/2026-08-28-preservation-receipt.md`. |
| Establish release authority | Complete | Exact commit, deployment, revision, image digest, health, migration, CI, and rollback evidence were captured; see `releases/2026-08-28-production-release-and-repair.md`. |
| Diagnose out-of-window schedule dead letters | Implemented locally | Valid pre-2023 and future rollups are deferred; malformed dates still fail closed. Deploy first, then use the bounded repair procedure in `runbook.md`. |
| Dependency and injection security | Implemented locally | Patched dependency tree, escaped/React-rendered source labels, regression tests, zero known npm advisories at local verification. |
| CI and secret scanning | Prepared locally | Read-only workflow and reviewed Gitleaks allowlist exist; repository owner must push, enable required checks, and protect the authoritative branch. |
| Deployment gate | Implemented locally | Changed source/dependencies now fail routine mode without an exact full-preflight certificate; `--full` is the only certificate-producing path. |
| Accessibility and interaction | Implemented locally | Native sort buttons, keyboard disclosures, focus trap, focusable definition tooltips, per-row request isolation, and tests. |
| Freshness and coverage language | Implemented locally | Header separates “data through” from pipeline check age; materials wording no longer implies unproven current coverage. |
| Narrow mobile layout | Implemented locally | Health control avoids top navigation and recorded-time rows reflow at 480px/320px. |
| Agent/architecture/runbook/recovery docs | Implemented locally | Current authority index and concise operating documents added; stale handoffs labeled. |
| Generated drift inventory | Implemented locally | Deterministic route/API/auth/job/config/migration inventory is checked by Phase 0 and CI. |
| Production release and repair | Complete with deferred queue work | Revision 153 is healthy and exact bounded repairs ran. Remaining source-incomplete manifests stay queued and fail closed; see `releases/2026-08-28-production-release-and-repair.md`. |
| Repository visibility and Pages | Owner decision | Make private/disable Pages if the repository is not intentionally public; then document the decision. |
| Commission/payroll cutoff | Complete — deferred | August publication is explicitly deferred while source completeness is false; July is also unpublished. See `releases/2026-08-28-commission-deferral.md`. |
| Backup restore exercise | Complete | A real isolated PITR restore passed exact schema/TLS checks and cleanup was independently proved; see `releases/2026-08-28-restore-drill-receipt.md`. |
| Today’s Profitability screen | Implemented locally | Daily completed-job revenue, gross profit, net profit, coverage, negative-job alerts, and job detail are implemented against app-owned PostgreSQL with 60-second refresh. See `approved-design/todays-profitability.md`. |
| Large-module split / IaC simplification / archive deletion | Deferred maintenance | Do only as bounded, behavior-preserving follow-ups after the stabilization release; no deletion before second-copy verification. |

The branch is ready for owner review only after the clean-install gate in `AGENTS.md` is rerun and its counts are added to the stabilization worklog.

Exact guarded procedures for every owner-authorized item are in [`owner-actions.md`](owner-actions.md).

The current sanitized pre-release Azure, PostgreSQL, queue, backup, and GitHub baseline is recorded in [`releases/2026-08-28-pre-release-production-baseline.md`](releases/2026-08-28-pre-release-production-baseline.md).
