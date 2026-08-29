# Generated project inventory

[`inventory.generated.json`](inventory.generated.json) is the deterministic, source-backed inventory of pages, API methods and authorization class, the exact 24 production jobs and cadences, configuration variable names, and ordered migration hashes.

Generate it after changing any inventoried source:

```bash
npm run inventory:sync
```

Verify drift without writing:

```bash
npm run inventory:check
```

`npm run phase0:check` includes the drift check. The JSON contains names and hashes, never configuration values. Reviewers should treat a changed inventory as a deliberate contract change requiring review, not as a formatting update.
