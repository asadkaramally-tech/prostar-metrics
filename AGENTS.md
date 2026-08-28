# Agent operating contract

Read [docs/index.md](docs/index.md) before changing this repository. It identifies the current authorities and labels historical material.

- Never read Simpro from a dashboard request. Simpro access belongs in bounded workers; pages and APIs read app-owned PostgreSQL serving models.
- Never copy `.env.local`, Azure CLI profiles, tokens, connection strings, production exports, or generated release evidence into Git.
- Do not deploy an app, job, migration, or Bicep template separately. The only production entry point is `npm run deploy:prod`; changed inputs require `-- --full`.
- Repair production only through a narrowly scoped, dry-run-first command with explicit confirmation. Never broad-replay a queue to make health indicators green.
- Treat existing migrations as immutable. Add a new ordered migration and keep the migration compatibility gates green.
- `docs/inventory.generated.json` is generated. Change source, then run `npm run inventory:sync`; never hand-edit it.
- Before handoff run `npm ci`, `npm run phase0:check`, `npm run lint`, `npx tsc --noEmit`, `npm run build`, both npm audits, and `git diff --check`.

Current operational guides: [DEPLOY.md](DEPLOY.md), [docs/runbook.md](docs/runbook.md), and [docs/recovery.md](docs/recovery.md).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
