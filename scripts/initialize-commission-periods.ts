import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  commissionInitializationConfirmationToken,
  initializeHistoricalCommissionPeriods,
  LOCKED_COMMISSION_CONFIG_HASH,
  LOCKED_COMMISSION_POLICY_EVIDENCE,
  normalizeCommissionInitializationActor,
  resolveCommissionInitializationMonth,
} from "@/lib/store/commission-period-initialization";
import { closePostgresPool } from "@/lib/store/postgres";

export type CommissionInitializationCliArgs = {
  actorEmail: string;
  throughMonth: string;
  execute: boolean;
  confirmation?: string;
  help: boolean;
};

const usage = `Usage:
  npm run commissions:initialize-periods -- --through <YYYY-MM|current> --actor <Asad-or-Laila-email> [--dry-run]
  npm run commissions:initialize-periods -- --through <YYYY-MM|current> --actor <Asad-or-Laila-email> --execute --confirm <exact-token>

Dry-run is the default. --execute requires the exact confirmation token printed by dry-run.`;

export function parseCommissionInitializationArgs(
  argv: string[],
  now = new Date(),
): CommissionInitializationCliArgs {
  let actor: string | undefined;
  let through: string | undefined;
  let confirmation: string | undefined;
  let execute = false;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--actor") {
      if (actor !== undefined) throw new Error("--actor may only be provided once.");
      actor = requiredValue(argv, ++index, "--actor");
    } else if (arg === "--through") {
      if (through !== undefined) throw new Error("--through may only be provided once.");
      through = requiredValue(argv, ++index, "--through");
    } else if (arg === "--confirm") {
      if (confirmation !== undefined) throw new Error("--confirm may only be provided once.");
      confirmation = requiredValue(argv, ++index, "--confirm");
    } else if (arg === "--execute") {
      if (execute) throw new Error("--execute may only be provided once.");
      execute = true;
    } else if (arg === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may only be provided once.");
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }

  if (help) return { actorEmail: "", throughMonth: "", execute: false, help: true };
  if (!actor) throw new Error("--actor is required.");
  if (!through) throw new Error("--through is required and must be YYYY-MM or current.");
  if (execute && dryRun) throw new Error("--execute and --dry-run cannot be combined.");
  if (!execute && confirmation !== undefined) throw new Error("--confirm is only valid with --execute.");

  const actorEmail = normalizeCommissionInitializationActor(actor);
  const throughMonth = resolveCommissionInitializationMonth(through, now);
  if (execute) {
    const expected = commissionInitializationConfirmationToken(throughMonth);
    if (confirmation !== expected) throw new Error(`Execution requires --confirm ${expected}.`);
  }
  return { actorEmail, throughMonth, execute, confirmation, help: false };
}

export async function verifyLockedCommissionEvidenceFiles(): Promise<void> {
  const repositoryRoot = new URL("../", import.meta.url);
  const evidenceFiles = [
    LOCKED_COMMISSION_POLICY_EVIDENCE.priorDashboard,
    LOCKED_COMMISSION_POLICY_EVIDENCE.lockedPlan,
    LOCKED_COMMISSION_POLICY_EVIDENCE.rosterMigration,
    ...LOCKED_COMMISSION_POLICY_EVIDENCE.configMigrations,
    LOCKED_COMMISSION_POLICY_EVIDENCE.integrityMigration,
  ];
  for (const evidence of evidenceFiles) {
    const content = await readFile(new URL(evidence.path, repositoryRoot));
    verifyLockedCommissionEvidenceContent(evidence.path, content);
  }

  const manifest = JSON.parse(await readFile(
    new URL("docs/prostar-metrics/reference/manifest.json", repositoryRoot),
    "utf8",
  )) as { artifacts?: Array<{ copy?: string; sha256?: string }> };
  const priorDashboard = manifest.artifacts?.find((artifact) =>
    artifact.copy === LOCKED_COMMISSION_POLICY_EVIDENCE.priorDashboard.path);
  if (priorDashboard?.sha256 !== LOCKED_COMMISSION_POLICY_EVIDENCE.priorDashboard.sha256) {
    throw new Error("Reference manifest does not authenticate the locked prior commissions dashboard.");
  }

  if (!/^[0-9a-f]{64}$/.test(LOCKED_COMMISSION_CONFIG_HASH)) {
    throw new Error("Locked commission config hash is malformed.");
  }
}

export function verifyLockedCommissionEvidenceContent(path: string, content: string | Uint8Array): void {
  const evidenceFiles = [
    LOCKED_COMMISSION_POLICY_EVIDENCE.priorDashboard,
    LOCKED_COMMISSION_POLICY_EVIDENCE.lockedPlan,
    LOCKED_COMMISSION_POLICY_EVIDENCE.rosterMigration,
    ...LOCKED_COMMISSION_POLICY_EVIDENCE.configMigrations,
    LOCKED_COMMISSION_POLICY_EVIDENCE.integrityMigration,
  ];
  const evidence = evidenceFiles.find((entry) => entry.path === path);
  if (!evidence) throw new Error(`Unknown commission evidence path ${path}.`);
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== evidence.sha256) {
    throw new Error(`Locked evidence hash mismatch for ${evidence.path}: expected ${evidence.sha256}, received ${actual}.`);
  }
}

async function main() {
  const args = parseCommissionInitializationArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }
  await verifyLockedCommissionEvidenceFiles();
  const report = await initializeHistoricalCommissionPeriods({
    throughMonth: args.throughMonth,
    actorEmail: args.actorEmail,
    execute: args.execute,
    confirmation: args.confirmation,
  });
  console.log(JSON.stringify(report, null, 2));
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePostgresPool();
    });
}
