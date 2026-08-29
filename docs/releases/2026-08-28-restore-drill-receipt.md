# PostgreSQL restore drill receipt

Status: passed. Times are UTC.

- Execution window: `2026-08-29T02:12:27.768Z` to `2026-08-29T02:25:09.673Z` (12 minutes 42 seconds).
- Restore point: `2026-08-29T02:02:24.520Z`, approximately 10 minutes before execution began.
- Source: PostgreSQL 17 production server with 35-day point-in-time retention.
- Restore target: isolated temporary PostgreSQL 17 server.
- Transport validation: TLS 1.3 with a 256-bit cipher.
- Schema validation: exact match across 1 schema, 71 tables, 1,106 columns, 263 constraints, 164 indexes, and all 51 applied migration records.
- Cleanup: temporary firewall removal attempted; Azure CLI ResourceNotFound and ARM HTTP 404 independently proved the temporary server was deleted.
- Source safety: the production source configuration was read back and proved unchanged.

The raw secret-free machine evidence remains outside Git under `.work/infra-evidence/`. This receipt intentionally excludes account identifiers, hostnames, IP addresses, and production row-level data.

