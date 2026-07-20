# Pro Star Metrics

Production owner dashboard for Pro Star Mechanical. The Next.js application serves the Today, Quotes, Jobs, Technicians, and Commissions views from an app-owned Azure PostgreSQL read store.

Simpro is read by bounded background workers, not by dashboard requests. The repository includes the complete web app, API routes, ingestion and rollup workers, database migrations, Azure infrastructure, monitoring definitions, release tooling, tests, and visual design references.

## Local Build

Use Node.js 24:

```bash
npm ci
npm run build
```

To run against data, provide the required variable names from `.env.example` through your local secret manager or an ignored environment file:

```bash
npm run dev
```

Production credentials are not stored in this repository. Runtime secrets are Azure Key Vault references configured on the Container App and scheduled jobs.

## Production

The only routine production release entry point is:

```bash
npm run deploy:prod
```

Do not deploy the Bicep files, web app, or individual jobs separately. See [DEPLOY.md](./DEPLOY.md) for prerequisites, the exact invocation, automated migration behavior, and release provenance.
