import { queryPostgres, type PostgresQuery } from "@/lib/store/postgres";

export type CommissionInitializationPrerequisiteStatus = {
  throughMonth: string;
  ready: boolean;
  sourceUnitsExpected: number;
  sourceUnitsAccepted: number;
  reconciliationsExpected: number;
  reconciliationsAccepted: number;
  rejected: Array<{ month: string; evidence: string }>;
};

type PrerequisiteRow = {
  month: string;
  evidence: string;
  accepted: boolean;
};

export async function readCommissionInitializationPrerequisites(
  startMonth: string,
  throughMonth: string,
  query: PostgresQuery = queryPostgres,
): Promise<CommissionInitializationPrerequisiteStatus> {
  const result = await query<PrerequisiteRow>(
    `select month.month_start::text as month, prerequisite.evidence, prerequisite.accepted
       from generate_series($1::date, $2::date, interval '1 month') month(month_start)
       cross join lateral metrics.commission_initialization_prerequisite_status(month.month_start::date) prerequisite
      order by month.month_start, prerequisite.evidence`,
    [`${startMonth}-01`, `${throughMonth}-01`],
  );
  const sourceRows = result.rows.filter((row) => row.evidence.startsWith("backfill:"));
  const reconciliationRows = result.rows.filter((row) => row.evidence.startsWith("reconciliation:"));
  const rejected = result.rows
    .filter((row) => row.accepted !== true)
    .map((row) => ({ month: row.month.slice(0, 7), evidence: row.evidence }));
  return {
    throughMonth,
    ready: rejected.length === 0,
    sourceUnitsExpected: sourceRows.length,
    sourceUnitsAccepted: sourceRows.filter((row) => row.accepted === true).length,
    reconciliationsExpected: reconciliationRows.length,
    reconciliationsAccepted: reconciliationRows.filter((row) => row.accepted === true).length,
    rejected,
  };
}

export function prerequisiteConflictMessages(report: CommissionInitializationPrerequisiteStatus): string[] {
  return report.rejected.map(({ month, evidence }) =>
    `${month} source reconciliation prerequisite ${evidence} is not accepted.`);
}
