# Baseline validation (pre-change, cloud workspace, 2026-07-13)

- npm run guard:no-mirror — PASS
- npm run plan:check — PASS (98 feature records)
- npm run reference:check — PASS (4 artifacts, 5 sidecar hashes)
- npm exec tsc --noEmit — PASS
- npm run lint --max-warnings=0 — PASS
- npm test — 700/702 pass; 2 PRE-EXISTING failures, both in
  tests/workers/emit-operational-telemetry.test.ts (backend worker telemetry;
  missing exports 'acknowledgeOperationalTelemetrySignal' and
  'writeOperationalTelemetryLine'). Unrelated to any frontend file.
- npm run test:integration / npm run build — to be run after implementation
  (build wraps scripts/run-evidence-build.mjs).

Baseline git commit: bdb910a "Baseline snapshot (pre-redesign)".
New unreferenced files added post-baseline (no rendering impact):
src/components/ui/{status-pill,panel,empty-state,kpi-tile,table-bits,chart-bits}.tsx,
.design/* docs.
