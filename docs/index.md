# Documentation authority

This page is the current index. When documents conflict, use this order:

1. Explicit owner decisions recorded in current code or a dated decision record.
2. This index and the current operational guides below.
3. Generated source inventory and tested source contracts.
4. Historical plans and handoffs, which are evidence only.

## Current authorities

| Subject | Authority |
|---|---|
| Agent safety and required checks | [`../AGENTS.md`](../AGENTS.md) |
| Architecture and data boundaries | [`architecture.md`](architecture.md) |
| Source-backed routes, jobs, configuration, migrations | [`inventory.generated.json`](inventory.generated.json), explained by [`inventory.md`](inventory.md) |
| Production release | [`../DEPLOY.md`](../DEPLOY.md) |
| Health triage and bounded repair | [`runbook.md`](runbook.md) |
| Backup and recovery | [`recovery.md`](recovery.md) |
| Audit closure and owner actions | [`roadmap.md`](roadmap.md) |
| Exact owner-authorized procedures | [`owner-actions.md`](owner-actions.md) |
| Product field definitions | [`prostar-metrics/data-dictionary.md`](prostar-metrics/data-dictionary.md) and [`prostar-metrics/canonical-table-mapping.md`](prostar-metrics/canonical-table-mapping.md) |
| Approved visual direction | [`approved-design/APPROVAL.md`](approved-design/APPROVAL.md) |
| Current feature evidence | [`prostar-metrics/feature-status.json`](prostar-metrics/feature-status.json) |

The 2026-08-28 audit is the evidence base for the current roadmap, not an execution command: [`audits/2026-08-28-metrics-application-audit-and-roadmap.md`](audits/2026-08-28-metrics-application-audit-and-roadmap.md).

## Historical or superseded material

- `docs/CODEX-DEPLOY-HANDOFF.md` is a historical July deployment handoff. Its direct-Bicep and secret-copy instructions are prohibited.
- `docs/prostar-metrics/execution-plan.md` is a historical product decision record. It is not the current operational authority.
- `docs/phase-0-execution.md` records an early implementation phase and is not a current readiness checklist.
- `docs/prostar-metrics/claude-design-visual-handoff.md` is a historical visual handoff; approved design files remain reference material only.
