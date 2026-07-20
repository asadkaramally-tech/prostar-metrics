import { readFile } from "node:fs/promises";

const tlsQueryParameters = [
  "ssl",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "uselibpqcompat",
];

export async function verifiedPostgresClientConfig(connectionString, options = {}) {
  const env = options.env ?? process.env;
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden for PostgreSQL connections.");
  }

  const url = new URL(connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("PostgreSQL connection string must use postgres:// or postgresql://.");
  }
  if (!url.hostname) throw new Error("PostgreSQL connection string must include a hostname for TLS verification.");

  const connectionCaPath = url.searchParams.get("sslrootcert");
  if (url.searchParams.has("sslcert") || url.searchParams.has("sslkey")) {
    throw new Error("Client certificate parameters are not supported by the verified PostgreSQL TLS helper.");
  }
  for (const parameter of tlsQueryParameters) url.searchParams.delete(parameter);

  const inlineCa = env.AZURE_POSTGRES_CA_CERT?.replaceAll("\\n", "\n").trim();
  const caPath = env.AZURE_POSTGRES_CA_CERT_PATH || env.PGSSLROOTCERT || connectionCaPath;
  if (inlineCa && caPath) {
    throw new Error("Configure PostgreSQL CA trust with either AZURE_POSTGRES_CA_CERT or a CA path, not both.");
  }

  const ca = inlineCa || (caPath
    ? (await (options.readFile ?? readFile)(caPath, "utf8")).trim()
    : undefined);
  if (ca !== undefined && !ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("Configured PostgreSQL CA does not contain a PEM certificate.");
  }

  return {
    connectionString: url.toString(),
    ssl: {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
    },
  };
}
