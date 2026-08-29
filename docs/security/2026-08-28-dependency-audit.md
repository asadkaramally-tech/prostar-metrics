# Dependency security review — 2026-08-28

## Outcome

The installed dependency tree now has **zero known npm advisories** in both the complete and production-only scans. This is a point-in-time advisory result, not a permanent guarantee.

The first clean install reported eight affected packages: seven high-severity and one moderate-severity. The fixes stayed within compatible releases; no force-fix or semver-major upgrade was used.

## Changes

| Package or chain | Before | After | Reason |
|---|---:|---:|---|
| `next` | 16.2.9 | 16.3.3 | Patched Next.js authorization, request handling, disclosure, and denial-of-service advisories |
| `eslint-config-next` | 16.2.9 | 16.3.3 | Kept the lint rules aligned with Next.js |
| `postcss` | 8.5.16 | 8.5.26 | Patched source-map path traversal/disclosure |
| `sharp` | 0.34.5 | 0.35.4 | Patched inherited image-library vulnerabilities through the Next.js update |
| `fast-xml-parser` | 5.9.3 | 5.11.1 | Patched repeated-DOCTYPE entity expansion |
| `brace-expansion` | 1.1.15 / 5.0.6 | 1.1.18 / 5.0.9 | Patched unbounded/exponential expansion denial of service |
| `js-yaml` | 4.3.0 | 4.3.2 | Patched quadratic `!!omap` parsing |
| `nanoid` | 3.3.15 | 3.3.18 | Patched nonterminating custom/nonsecure generator inputs |

The project now records Node `24.x`, npm `11.x`, and `npm@11.6.2`; the local verification used Node `24.13.0` and npm `11.6.2`.

## Verification

- `npm audit --json`: 0 vulnerabilities.
- `npm audit --omit=dev --json`: 0 vulnerabilities.
- `npm test`: 1,035 passed, 0 failed.
- `npm run test:scripts`: 397 concrete assertions passed.
- `npm run test:infra`: 165 concrete assertions passed.
- `npm run lint`: 0 errors and 3 warnings.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed on Next.js 16.3.3.

The lint warnings are nonblocking: two are in historical design fixtures, and one is a newly surfaced recommendation to replace internal `window.location.href` navigation in the Materials dashboard with the Next router. That navigation change is intentionally left for a focused component refactor because the component is also rendered without a router in server-side tests.
