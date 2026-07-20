import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifiedPostgresClientConfig } from "../../scripts/postgres-tls.mjs";

const databaseScripts = [
  "apply-migrations.mjs",
  "audit-production-state.mjs",
  "test-migrations.mjs",
];

test("every production database script uses the shared verified TLS helper", async () => {
  for (const script of databaseScripts) {
    const source = await readFile(new URL(`../../scripts/${script}`, import.meta.url), "utf8");
    assert.match(source, /verifiedPostgresClientConfig/);
    assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false/);
  }
});

test("verified TLS strips connection-string overrides and keeps CA and hostname verification enabled", async () => {
  const config = await verifiedPostgresClientConfig(
    "postgresql://owner:secret@db.example.test:5432/metrics?sslmode=no-verify&uselibpqcompat=true",
    { env: {} },
  );
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal("checkServerIdentity" in config.ssl, false);
  assert.equal(new URL(config.connectionString).searchParams.has("sslmode"), false);
  assert.equal(new URL(config.connectionString).searchParams.has("uselibpqcompat"), false);
});

test("verified TLS loads an explicit PEM CA and rejects process-wide verification bypass", async () => {
  const pem = "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----";
  const inline = await verifiedPostgresClientConfig("postgres://db.example.test/metrics", {
    env: { AZURE_POSTGRES_CA_CERT: pem },
  });
  assert.equal(inline.ssl.ca, pem);

  const fromPath = await verifiedPostgresClientConfig("postgres://db.example.test/metrics", {
    env: { AZURE_POSTGRES_CA_CERT_PATH: "/secure/azure-ca.pem" },
    readFile: async (path, encoding) => {
      assert.equal(path, "/secure/azure-ca.pem");
      assert.equal(encoding, "utf8");
      return pem;
    },
  });
  assert.equal(fromPath.ssl.ca, pem);

  await assert.rejects(
    verifiedPostgresClientConfig("postgres://db.example.test/metrics", {
      env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    }),
    /forbidden/,
  );
});
