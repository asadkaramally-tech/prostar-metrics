CODEX DESIGN PACKAGE — pixel-perfect implementation of the Pro Star Metrics redesign

CONTENTS
- CODEX-DESIGN-IMPLEMENTATION-BRIEF.md  → the full spec (tokens, layout, charts, per-route,
  §12 PIXEL REDLINE with exact measured values, §13 per-route notes).
- reference-styles.css  → the exact stylesheet extracted from the canonical mockup. Every value
  is real; port it into globals.css + the shared components.
- fonts/*.woff2  → the exact Inter assets. Drop into /public/fonts (referenced by reference-styles.css).
- mockups/*.html  → SELF-CONTAINED, pixel-perfect renders (fonts embedded). jobs.CANONICAL.html is
  the authoritative language; the other three show per-route layout. OPEN THESE IN CHROME and use
  DevTools → Computed to read any exact value.
- mockups/*.png  → reference screenshots.

HOW TO HIT PIXEL-PERFECT
1. Open mockups/jobs.CANONICAL.html in Chrome. This is the target.
2. Port reference-styles.css tokens + component rules into src/app/globals.css and the shared UI
   components. Copy fonts/ into public/fonts.
3. Build each route's markup to match its mockup HTML; style Recharts per §6 + §12 (the star metric
   is the ONLY accent-colored series; supporting series neutral; gradient+glow on the star line;
   waterfall result bar = accent).
4. Diff your rendered route against the mockup PNG at 1440 wide; iterate until it matches.

RULES THAT MATTER MOST
- One accent (#5b63d3), used only for the star metric + focus/active nav. Everything else neutral.
  Green/red only for semantic up/down. If in doubt, remove color.
- Frontend/presentation only. Preserve every metric, chart, testid, filter, action, export, audit,
  N/A/coverage/provisional state, RBAC, and the commission "calculated ≠ paid" honesty. Do not touch
  infra/ workers/ scripts/ src/lib/ src/app/api/ src/proxy.ts or package.json (except adding the
  self-hosted Inter fonts). Existing tests must still pass.
