# Pro Star Metrics

Production owner dashboard for Pro Star Mechanical. The Next.js application serves the Today, Quotes, Jobs, Technicians, and Commissions views from an app-owned Azure PostgreSQL read store.

Simpro is read by bounded background workers, not by dashboard requests. The repository includes the complete web app, API routes, ingestion and rollup workers, database migrations, Azure infrastructure, monitoring definitions, release tooling, tests, and visual design references.

Start with [docs/index.md](docs/index.md) for the current documentation authority, architecture, generated inventory, operations runbook, recovery guide, and audit roadmap.

## Local Build

Use Node.js 24:

```bash
npm ci
npm run build
```

The complete local quality gate is:

```bash
npm ci
npm run phase0:check
npm run lint
npx tsc --noEmit
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

To run against data, provide the required variable names from `.env.example` through your local secret manager or an ignored environment file:

```bash
npm run dev
```

Production credentials are not stored in this repository. Runtime secrets are Azure Key Vault references configured on the Container App and scheduled jobs.

## Production

Changed code must use the full production release entry point:

```bash
npm run deploy:prod -- --full
```

An unflagged routine invocation is only an exact retry of a previously certified source/dependency snapshot. Do not deploy the Bicep files, web app, or individual jobs separately. See [DEPLOY.md](./DEPLOY.md).
