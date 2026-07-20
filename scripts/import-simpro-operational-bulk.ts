import path from "node:path";
import pg from "pg";
import { buildPostgresSslConfig } from "@/lib/store/postgres";
import {
  importVerifiedOperationalArtifact,
  verifyOperationalBulkArtifact,
} from "@/lib/store/bulk-operational-bootstrap";

async function main() {
  const inputDirectory = path.resolve(
    argumentValue("--input") ?? path.join(".work", "simpro-operational-bulk-export"),
  );
  const artifact = await verifyOperationalBulkArtifact(inputDirectory);
  const summary = {
    inputDirectory,
    manifestSha256: artifact.manifestSha256,
    completedAt: artifact.manifest.completedAt,
    requestsUsed: artifact.manifest.requestsUsed,
    sources: artifact.manifest.sources.map((source) => ({
      family: source.family,
      rowCount: source.rowCount,
      requests: source.requestCount,
      sha256: source.sha256,
    })),
  };

  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify({ mode: "verified-dry-run", ...summary }, null, 2));
    return;
  }

  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString) throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required with --execute");
  const client = new pg.Client({ connectionString, ssl: buildPostgresSslConfig() });
  await client.connect();
  try {
    const result = await importVerifiedOperationalArtifact(client, artifact);
    console.log(JSON.stringify({ mode: "executed", ...summary, result }, null, 2));
  } finally {
    await client.end();
  }
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
