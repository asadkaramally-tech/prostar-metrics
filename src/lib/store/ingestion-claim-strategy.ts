import type { IngestionEntity } from "@/lib/simpro/ingest";

const candidateFamilies = ["quote_nested", "job_nested", "schedules"] as const satisfies readonly IngestionEntity[];

export function preferredCandidateFamily(claimIndex: number): IngestionEntity {
  const index = Math.max(0, Math.trunc(claimIndex));
  return candidateFamilies[index % candidateFamilies.length];
}
