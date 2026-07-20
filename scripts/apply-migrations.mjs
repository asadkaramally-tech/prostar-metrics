import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { verifiedPostgresClientConfig } from "./postgres-tls.mjs";

const { Client } = pg;
const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required");

const root = resolve(import.meta.dirname, "..");
const migrationDir = resolve(root, "infra/db/migrations");
const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
const client = new Client(await verifiedPostgresClientConfig(connectionString));

await client.connect();
try {
  await client.query("select pg_advisory_lock(hashtext('prostar_metrics_schema_migrations'))");
  await client.query(`
    create table if not exists metrics.schema_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )`);

  for (const filename of files) {
    const sql = await readFile(resolve(migrationDir, filename), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query(
      "select sha256 from metrics.schema_migrations where filename = $1",
      [filename],
    );
    if (existing.rowCount) {
      if (existing.rows[0].sha256 !== sha256) {
        throw new Error(`Applied migration ${filename} hash differs from repository`);
      }
      continue;
    }

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into metrics.schema_migrations (filename, sha256) values ($1, $2)",
        [filename, sha256],
      );
      await client.query("commit");
      console.log(`Applied ${filename}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.query("select pg_advisory_unlock(hashtext('prostar_metrics_schema_migrations'))").catch(() => undefined);
  await client.end();
}
