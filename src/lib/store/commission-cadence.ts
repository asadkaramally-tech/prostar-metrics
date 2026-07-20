import { enqueueRollupRebuild } from "@/lib/store/read-model-rebuilds";

const PACIFIC_TIME_ZONE = "America/Los_Angeles";

export type CommissionCadenceResult = {
  localDate: string;
  localHour: number;
  periodStart: string;
  enqueued: boolean;
  queueJobId: number | null;
  queueStatus: string | null;
};

type CommissionCadenceDependencies = {
  now?: Date;
  enqueue?: typeof enqueueRollupRebuild;
};

export async function enqueueCurrentPacificCommissionRebuild(
  localHour = 3,
  dependencies: CommissionCadenceDependencies = {},
): Promise<CommissionCadenceResult> {
  if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) {
    throw new Error("Commission cadence localHour must be an integer from 0 through 23.");
  }

  const local = pacificDateTime(dependencies.now ?? new Date());
  const periodStart = `${local.localDate.slice(0, 7)}-01`;
  if (local.hour !== localHour) {
    return {
      localDate: local.localDate,
      localHour: local.hour,
      periodStart,
      enqueued: false,
      queueJobId: null,
      queueStatus: null,
    };
  }

  const enqueue = dependencies.enqueue ?? enqueueRollupRebuild;
  const queueJob = await enqueue({
    metricFamily: "commissions",
    periodStart,
    reason: `Nightly commission rebuild for Pacific business date ${local.localDate}`,
    idempotencyKey: `commissions:nightly:${local.localDate}`,
    preserveSucceeded: true,
  });

  return {
    localDate: local.localDate,
    localHour: local.hour,
    periodStart,
    enqueued: queueJob !== null,
    queueJobId: queueJob?.id ?? null,
    queueStatus: queueJob?.status ?? null,
  };
}

export function pacificDateTime(date: Date): { localDate: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = Number(value("hour"));
  if (!year || !month || !day || !Number.isInteger(hour)) {
    throw new Error("Unable to determine the current Pacific business date and hour.");
  }
  return { localDate: `${year}-${month}-${day}`, hour };
}
