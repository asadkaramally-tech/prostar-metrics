import { createHash } from "node:crypto";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type { CommissionReadModel, CommissionTechnicianResult } from "@/lib/metrics/commissions";
import { uploadCommissionExportBlob } from "@/lib/store/blob-exports";
import {
  commissionCanonicalRunSelect,
  verifyCommissionCanonicalRun,
  type CommissionCanonicalRunRow,
  type CommissionSourceEvidence,
  type CommissionVerifiedIdentity,
} from "@/lib/store/commission-integrity";
import {
  CommissionLifecycleError,
  CommissionRevisionConflictError,
  type CommissionLifecycleStatus,
  type CommissionQuery,
} from "@/lib/store/commission-lifecycle";
import { queryPostgres, withPostgresTransaction } from "@/lib/store/postgres";

export type CommissionExportType = "payroll_csv" | "worksheet_pdf" | "calculation_detail_csv";

export type CommissionRunForExport = {
  periodId: number;
  periodStart: string;
  periodEnd: string;
  periodRevision: number;
  editRevision: number;
  periodStatus: CommissionLifecycleStatus;
  calculationStale: boolean;
  runId: number;
  runRevision: number;
  runStatus: string;
  sourceComplete: boolean;
  sourceEvidence: CommissionSourceEvidence;
  inputManifestHash: string;
  sourceHash: string;
  configHash: string;
  overrideHash: string;
  calculationHash: string;
  createdAt: string;
  createdBy: string;
  readModel: CommissionReadModel;
  manifest: Array<{
    inputType: string;
    sourceIdentity: string;
    sourceVersion: string;
    sourceHash: string;
    input: unknown;
  }>;
  verifiedIdentity?: CommissionVerifiedIdentity;
};

export type CommissionExportRecord = {
  id: number;
  runId: number;
  type: CommissionExportType;
  filename: string;
  storageKey: string;
  fileHash: string;
  contentType: string;
  size: number;
  status: string;
  exportedBy: string;
  exportedAt: string;
  retainedUntil: string;
  downloadCount: number;
  lastDownloadedAt: string | null;
};

type ExportRow = {
  id: string;
  calculation_run_id: string;
  export_type: CommissionExportType;
  filename: string;
  storage_key: string;
  file_hash: string;
  content_type: string;
  file_size_bytes: string;
  status: string;
  exported_by: string;
  exported_at: string;
  retained_until: string;
  download_count: number;
  last_downloaded_at: string | null;
  content_bytes?: Buffer | Uint8Array | null;
  current_edit_revision?: number | null;
  failure_reason?: string | null;
};

const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;
const PAGE_MARGIN = 42;
const brandNavy = rgb(0.035, 0.137, 0.247);
const brandRed = rgb(0.78, 0.247, 0.184);
const ink = rgb(0.09, 0.125, 0.2);
const muted = rgb(0.39, 0.44, 0.52);
const line = rgb(0.82, 0.85, 0.89);
const soft = rgb(0.95, 0.96, 0.98);

export async function getCurrentCommissionRunForExport(
  periodStart: string,
  query: CommissionQuery = queryPostgres,
): Promise<CommissionRunForExport | null> {
  const result = await query<CommissionCanonicalRunRow>(
    `${commissionCanonicalRunSelect()}
      where p.period_start = $1::date
      order by p.revision desc
      limit 1`,
    [periodStart],
  );
  const row = result.rows[0];
  if (!row) return null;
  const verification = verifyCommissionCanonicalRun(row);
  if (!verification.ok) throw new CommissionLifecycleError(`The current commission run cannot be exported: ${verification.error}`);
  return exportRunFromCanonical(row, verification);
}

export async function createOrGetCommissionExport(params: {
  run: CommissionRunForExport;
  expectedRevision: number;
  exportType: CommissionExportType;
  actorEmail: string;
}, query: CommissionQuery = queryPostgres): Promise<{
  export: CommissionExportRecord;
  bytes: Uint8Array;
  idempotent: boolean;
  periodStatus: CommissionLifecycleStatus;
  editRevision: number;
}> {
  if (!params.run.verifiedIdentity) {
    throw new CommissionLifecycleError("The export request was not created from a canonically verified immutable run.");
  }
  const runInTransaction = query === queryPostgres
    ? withPostgresTransaction
    : async <T>(callback: (transactionQuery: CommissionQuery) => Promise<T>) => callback(query);
  return runInTransaction(async (transactionQuery) => {
    await transactionQuery(
      "select pg_advisory_xact_lock(hashtextextended('commission:' || $1, 0))",
      [params.run.periodStart],
    );
    const selected = await transactionQuery<CommissionCanonicalRunRow>(
      `${commissionCanonicalRunSelect()}
        where p.id = $1::bigint and p.period_start = $2::date
        for update of p`,
      [params.run.periodId, params.run.periodStart],
    );
    const row = selected.rows[0];
    if (!row) throw new CommissionLifecycleError("The current commission run is missing and cannot be exported.");
    if (row.edit_revision !== params.expectedRevision) {
      throw new CommissionRevisionConflictError(params.expectedRevision, row.edit_revision);
    }
    const verification = verifyCommissionCanonicalRun(row);
    if (!verification.ok) throw new CommissionLifecycleError(`The current commission run cannot be exported: ${verification.error}`);
    if (!sameVerifiedIdentity(params.run.verifiedIdentity!, verification.identity)) {
      throw new CommissionLifecycleError("The verified commission run changed before export.");
    }
    return createOrGetCommissionExportVerified({
      ...params,
      run: exportRunFromCanonical(row, verification),
    }, transactionQuery);
  });
}

async function createOrGetCommissionExportVerified(params: {
  run: CommissionRunForExport;
  expectedRevision: number;
  exportType: CommissionExportType;
  actorEmail: string;
}, query: CommissionQuery): Promise<{
  export: CommissionExportRecord;
  bytes: Uint8Array;
  idempotent: boolean;
  periodStatus: CommissionLifecycleStatus;
  editRevision: number;
}> {
  assertRunExportable(params.run);
  const bytes = await buildCommissionExportBytes(params.run, params.exportType);
  const fileHash = sha256(bytes);
  const filename = exportFilename(params.run, params.exportType);
  const contentType = contentTypeFor(params.exportType);
  const storageKey = `commission-exports/${params.run.periodStart.slice(0, 7)}/run-${params.run.runId}/${filename}`;
  const idempotencyKey = `commission:${params.run.runId}:${params.exportType}:${fileHash}`;
  const retainedUntil = retainedUntilDate(params.run.periodEnd);

  const result = await query<ExportRow>(
    `with target_lock as materialized (
       select pg_advisory_xact_lock(hashtextextended('commission:' || $1, 0))
     ), target as materialized (
       select p.*, r.run_status, r.source_complete, r.source_evidence, r.input_manifest_hash,
              r.source_hash, r.config_hash, r.override_hash as run_override_hash
         from metrics.commission_periods p
         cross join target_lock
       join metrics.commission_calculation_runs r on r.id = p.current_run_id
        where p.id = $2 and p.period_start = $1::date
          and p.current_run_id = $3::bigint
          and r.id = $3::bigint
          and r.revision = $15
          and r.immutable = true
          and lower(r.calculation_hash) = lower($16)
          and lower(r.input_manifest_hash) = lower($17)
          and lower(r.source_hash) = lower($18)
          and lower(r.config_hash) = lower($19)
          and lower(r.override_hash) = lower($20)
        for update of p
     ), existing as materialized (
       select e.*
         from metrics.commission_exports e
         cross join target t
        where e.idempotency_key = $11
          and e.calculation_run_id = t.current_run_id
          and t.edit_revision = $14
        limit 1
     ), inserted as (
       insert into metrics.commission_exports (
         calculation_run_id, export_type, filename, storage_key, file_hash,
         content_type, file_size_bytes, content_bytes, status, exported_by,
         retained_until, idempotency_key
       )
       select $3, $4::metrics.export_type, $5, $6, $7, $8, $9, $10, 'available', $12, $13::date, $11
         from target t
        where t.edit_revision = $14
          and t.current_run_id = $3
          and t.calculation_stale = false
          and t.run_status = 'succeeded'
          and t.source_complete = true
          and metrics.commission_source_evidence_complete(t.source_evidence)
          and t.input_manifest_hash is not null
          and t.source_hash is not null
          and t.config_hash is not null
          and t.run_override_hash = t.override_hash
          and t.status in ('reviewed', 'exported', 'locked')
          and not exists (select 1 from existing)
       returning *
     ), selected as materialized (
       select i.*, false as idempotent from inserted i
       union all
       select e.*, true as idempotent from existing e where not exists (select 1 from inserted)
     ), period_transition as (
       update metrics.commission_periods p
          set status = 'exported',
              edit_revision = p.edit_revision + 1,
              exported_by = $12,
              exported_at = now(),
              updated_at = now()
         from selected s
        where p.id = $2
          and p.current_run_id = $3
          and $4 = 'payroll_csv'
          and p.status = 'reviewed'
          and p.edit_revision = $14
          and not s.idempotent
       returning p.*
     ), period_selected as materialized (
       select * from period_transition
       union all
       select p.*
         from metrics.commission_periods p
         cross join selected s
        where p.id = $2
          and p.current_run_id = $3
          and not exists (select 1 from period_transition)
     ), audit_written as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, after_value, reason
       )
       select $12,
              case when s.idempotent then 'commission_export_redownloaded' else 'commission_export_generated' end,
              'commission_calculation_run', $3::text,
              jsonb_build_object('export_id', s.id, 'export_type', s.export_type,
                                 'file_hash', s.file_hash, 'period_revision', p.revision),
              case when s.idempotent then 'idempotent export request' else 'role-gated immutable-run export' end
         from selected s cross join period_selected p
       returning id
     )
     select s.id::text, s.calculation_run_id::text, s.export_type, s.filename,
            s.storage_key, s.file_hash, s.content_type, s.file_size_bytes::text,
            s.status, s.exported_by, s.exported_at::text, s.retained_until::text,
            s.download_count, s.last_downloaded_at::text, s.content_bytes,
            p.edit_revision as current_edit_revision, s.idempotent,
            null::text as failure_reason
       from selected s cross join period_selected p cross join audit_written
      union all
     select null, null, null, null, null, null, null, null, null, null, null, null,
            null, null, null, (select edit_revision from target), null,
            case when not exists (select 1 from target) then 'missing_run'
                 when (select edit_revision from target) <> $14 then 'stale_revision'
                 else 'not_exportable' end
      where not exists (select 1 from selected)
      limit 1`,
    [
      params.run.periodStart,
      params.run.periodId,
      params.run.runId,
      params.exportType,
      filename,
      storageKey,
      fileHash,
      contentType,
      bytes.byteLength,
      Buffer.from(bytes),
      idempotencyKey,
      params.actorEmail,
      retainedUntil,
      params.expectedRevision,
      params.run.runRevision,
      params.run.calculationHash,
      params.run.inputManifestHash,
      params.run.sourceHash,
      params.run.configHash,
      params.run.overrideHash,
    ],
  );
  const row = result.rows[0] as ExportRow & { idempotent?: boolean };
  if (!row?.id) {
    if (row?.failure_reason === "stale_revision") {
      throw new CommissionRevisionConflictError(params.expectedRevision, Number(row.current_edit_revision) || 0);
    }
    throw new CommissionLifecycleError("The current run is stale, incomplete, mismatched, unreviewed, or otherwise not exportable.");
  }

  const persistedBytes = row.content_bytes ? Uint8Array.from(row.content_bytes) : bytes;
  if (!row.idempotent) {
    await uploadCommissionExportBlob({ storageKey, content: persistedBytes, contentType, fileHash });
  }
  const editRevision = Number(row.current_edit_revision);
  return {
    export: mapExport(row),
    bytes: persistedBytes,
    idempotent: Boolean(row.idempotent),
    periodStatus: params.exportType === "payroll_csv" && params.run.periodStatus === "reviewed"
      ? "exported"
      : params.run.periodStatus,
    editRevision,
  };
}

export async function downloadCommissionExport(
  params: { exportId: number; actorEmail: string },
  query: CommissionQuery = queryPostgres,
): Promise<{ export: CommissionExportRecord; bytes: Uint8Array }> {
  const result = await query<ExportRow>(
    `with downloaded as (
       update metrics.commission_exports e
          set download_count = e.download_count + 1,
              last_downloaded_at = now()
        where e.id = $1
          and e.status = 'available'
          and e.retained_until >= current_date
          and e.content_bytes is not null
       returning e.*
     ), audit_written as (
       insert into metrics.audit_events (
         actor_email, action, entity_type, entity_id, after_value, reason
       )
       select $2, 'commission_export_downloaded', 'commission_calculation_run',
              d.calculation_run_id::text,
              jsonb_build_object('export_id', d.id, 'export_type', d.export_type,
                                 'download_count', d.download_count),
              'authorized export re-download'
         from downloaded d
       returning id
     )
     select d.id::text, d.calculation_run_id::text, d.export_type, d.filename,
            d.storage_key, d.file_hash, d.content_type, d.file_size_bytes::text,
            d.status, d.exported_by, d.exported_at::text, d.retained_until::text,
            d.download_count, d.last_downloaded_at::text, d.content_bytes
       from downloaded d cross join audit_written`,
    [params.exportId, params.actorEmail],
  );
  const row = result.rows[0];
  if (!row?.content_bytes) throw new CommissionLifecycleError("Export is unavailable or outside its retention window.");
  return { export: mapExport(row), bytes: Uint8Array.from(row.content_bytes) };
}

export async function buildCommissionExportBytes(run: CommissionRunForExport, type: CommissionExportType) {
  if (type === "worksheet_pdf") return buildCommissionWorksheetPdf(run);
  const content = type === "payroll_csv" ? buildPayrollCsv(run) : buildCalculationDetailCsv(run);
  return new TextEncoder().encode(content);
}

export function buildPayrollCsv(run: CommissionRunForExport) {
  const rows: Array<Array<string | number | boolean | null>> = [
    ["period_start", "period_end", "period_revision", "run_id", "run_revision", "employee_id", "display_name", "tier", "inside_pool_bonus", "outside_pool_adjustment", "payroll_bonus"],
    ...run.readModel.technicians.map((technician) => [
      run.periodStart,
      run.periodEnd,
      run.periodRevision,
      run.runId,
      run.runRevision,
      technician.employeeId,
      technician.displayName,
      technician.tier ?? "",
      moneyValue(technician.finalBonus),
      moneyValue(technician.outsidePoolAdjustment ?? 0),
      moneyValue(technician.payrollBonus ?? technician.finalBonus + (technician.outsidePoolAdjustment ?? 0)),
    ]),
    [run.periodStart, run.periodEnd, run.periodRevision, run.runId, run.runRevision, "TEAM_TOTAL", "Team Total", "", moneyValue(run.readModel.insidePoolTotal), moneyValue(run.readModel.outsidePoolTotal), moneyValue(run.readModel.payrollTotal)],
  ];
  return toCsv(rows);
}

export function buildCalculationDetailCsv(run: CommissionRunForExport) {
  const rows: Array<Array<string | number | boolean | null>> = [[
    "record_type", "period_start", "period_revision", "run_id", "run_revision",
    "employee_id", "display_name", "job_id", "field", "value", "detail", "source_hash",
  ]];
  const context = [run.periodStart, run.periodRevision, run.runId, run.runRevision] as const;
  rows.push(["run", ...context, "", "", "", "status", run.periodStatus, `pool=${moneyValue(run.readModel.poolAmount)}; payroll=${moneyValue(run.readModel.payrollTotal)}`, run.calculationHash]);
  for (const [field, value] of Object.entries(run.readModel.config)) {
    rows.push(["config", ...context, "", "", "", field, String(value), "", run.configHash]);
  }
  for (const technician of run.readModel.technicians) {
    const employee = [technician.employeeId, technician.displayName] as const;
    for (const [field, value] of Object.entries({
      rank: technician.rank,
      tier: technician.tier,
      tierMultiplier: technician.tierMultiplier,
      included: technician.included,
      allocatedWorkValue: technician.allocatedWorkValue,
      effectiveAllocatedWorkValue: technician.effectiveAllocatedWorkValue,
      baseBonus: technician.baseBonus,
      rawBonus: technician.rawBonus,
      belowMinimum: technician.belowMinimum,
      forfeitedBonus: technician.forfeitedBonus,
      reallocationReceived: technician.reallocationReceived,
      postForfeitureBonus: technician.postForfeitureBonus,
      efficiencyEnabled: technician.efficiency?.enabled,
      efficiencyMaxAdjustmentPercent: technician.efficiency?.maxAdjustmentPercent,
      efficiencyQuoteJobs: technician.efficiency?.quoteJobs,
      efficiencyQuotedHours: technician.efficiency?.quotedHours,
      efficiencyActualHours: technician.efficiency?.actualHours,
      efficiencyRatio: technician.efficiency?.efficiencyRatio,
      efficiencyPotentialMultiplier: technician.efficiency?.potentialMultiplier,
      efficiencyEffect: technician.efficiency?.effect,
      efficiencyMultiplier: technician.efficiency?.multiplier,
      efficiencyNeutralReason: technician.efficiency?.neutralReason,
      insidePoolAdjustment: technician.insidePoolAdjustment,
      overrideRedistribution: technician.overrideRedistribution,
      finalBonusLocked: technician.finalBonusLocked,
      finalBonus: technician.finalBonus,
      outsidePoolAdjustment: technician.outsidePoolAdjustment,
      payrollBonus: technician.payrollBonus,
      notes: JSON.stringify(technician.notes ?? []),
    })) {
      rows.push(["technician", ...context, ...employee, "", field, value === undefined ? "" : String(value), "", run.calculationHash]);
    }
  }
  for (const allocation of run.readModel.jobAllocations) {
    rows.push([
      "job_allocation", ...context, allocation.employeeId, "", allocation.jobId,
      "allocatedValue", moneyValue(allocation.allocatedValue),
      `jobTotal=${moneyValue(allocation.jobTotal)}; employeeHours=${allocation.employeeHours}; jobHours=${allocation.jobTotalHours}; share=${allocation.share}; included=${allocation.included}`,
      run.sourceHash,
    ]);
  }
  for (const [field, value] of Object.entries(run.readModel.coverage)) {
    rows.push(["coverage", ...context, "", "", "", field, typeof value === "object" ? JSON.stringify(value) : String(value), "", run.sourceHash]);
  }
  const quoteLabor = run.readModel.coverage.quoteLabor;
  for (const [field, value] of Object.entries({
    status: quoteLabor?.status ?? "unavailable",
    required: quoteLabor?.required ?? "",
    quoteSourcedJobs: quoteLabor?.quoteSourcedJobs ?? "",
    jobsWithLaborRows: quoteLabor?.jobsWithLaborRows ?? "",
    qualifyingJobs: quoteLabor?.qualifyingJobs ?? "",
    jobsWithNoQualifyingWork: quoteLabor?.jobsWithNoQualifyingWork ?? "",
    laborRows: quoteLabor?.laborRows ?? "",
    incompleteJobIds: JSON.stringify(quoteLabor?.incompleteJobIds ?? []),
  })) {
    rows.push(["efficiency_coverage", ...context, "", "", "", field, String(value), "", run.sourceHash]);
  }
  for (const input of run.manifest) {
    rows.push(["manifest", ...context, "", "", input.sourceIdentity, input.inputType, input.sourceVersion, JSON.stringify(input.input), input.sourceHash]);
  }
  rows.push(["team_total", ...context, "TEAM_TOTAL", "Team Total", "", "inside_pool", moneyValue(run.readModel.insidePoolTotal), `outside=${moneyValue(run.readModel.outsidePoolTotal)}; payroll=${moneyValue(run.readModel.payrollTotal)}`, run.calculationHash]);
  rows.push(["team_total", ...context, "TEAM_TOTAL", "Team Total", "", "outside_pool", moneyValue(run.readModel.outsidePoolTotal), "", run.calculationHash]);
  rows.push(["team_total", ...context, "TEAM_TOTAL", "Team Total", "", "payroll", moneyValue(run.readModel.payrollTotal), "", run.calculationHash]);
  return toCsv(rows);
}

export async function buildCommissionWorksheetPdf(run: CommissionRunForExport): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  document.setTitle(`Pro Star Mechanical Commission Worksheet ${run.periodStart.slice(0, 7)}`);
  document.setAuthor("Pro Star Mechanical");
  document.setSubject(`Run ${run.runId}; revision ${run.periodRevision}; calculated commission due ${moneyValue(run.readModel.payrollTotal)}; payment not confirmed`);
  document.setKeywords(["commission", `run-${run.runId}`, `revision-${run.periodRevision}`, `total-${moneyValue(run.readModel.payrollTotal)}`]);
  document.setCreator("Pro Star Metrics Dashboard");
  document.setProducer("Pro Star Metrics Dashboard / pdf-lib");

  let page = addPdfPage(document);
  let y = drawPdfHeader(page, regular, bold, run, "Monthly Commission Review Worksheet");
  y = drawConfigBlock(page, regular, bold, run, y);
  y = drawTeamTotals(page, regular, bold, run, y);
  y = drawTechnicianTableHeader(page, regular, bold, y);
  for (const technician of run.readModel.technicians) {
    if (y < 104) {
      page = addPdfPage(document);
      y = drawPdfHeader(page, regular, bold, run, "Calculated Commission Detail (continued)");
      y = drawTechnicianTableHeader(page, regular, bold, y);
    }
    y = drawTechnicianRow(page, regular, technician, y);
  }
  y -= 14;
  if (y < 178) {
    page = addPdfPage(document);
    y = drawPdfHeader(page, regular, bold, run, "Review and Approval");
  }
  y = drawReconciliationBlock(page, regular, bold, run, y);
  drawSignatureBlock(page, regular, bold, y - 18);
  for (const [index, currentPage] of document.getPages().entries()) {
    drawPdfFooter(currentPage, regular, run, index + 1, document.getPageCount());
  }
  return document.save({ useObjectStreams: false });
}

export async function validateCommissionWorksheetPdf(bytes: Uint8Array, expected: {
  runId: number;
  periodRevision: number;
  payrollTotal: number;
}) {
  const document = await PDFDocument.load(bytes);
  const errors: string[] = [];
  if (document.getPageCount() < 1) errors.push("PDF has no pages.");
  document.getPages().forEach((page, index) => {
    const { width, height } = page.getSize();
    if (Math.abs(width - LETTER_WIDTH) > 0.01 || Math.abs(height - LETTER_HEIGHT) > 0.01) {
      errors.push(`Page ${index + 1} is not US Letter.`);
    }
  });
  const subject = document.getSubject() ?? "";
  if (!subject.includes(`Run ${expected.runId}`)) errors.push("PDF metadata is missing the immutable run ID.");
  if (!subject.includes(`revision ${expected.periodRevision}`)) errors.push("PDF metadata is missing the period revision.");
  if (!subject.includes(`calculated commission due ${moneyValue(expected.payrollTotal)}`)) errors.push("PDF metadata team total does not match the run.");
  if (!subject.includes("payment not confirmed")) errors.push("PDF metadata does not disclose payment status.");
  if (bytes.byteLength < 2_000) errors.push("PDF is unexpectedly small and may be blank.");
  return { valid: errors.length === 0, errors, pageCount: document.getPageCount() };
}

function drawPdfHeader(page: PDFPage, regular: PDFFont, bold: PDFFont, run: CommissionRunForExport, subtitle: string) {
  page.drawRectangle({ x: 0, y: LETTER_HEIGHT - 82, width: LETTER_WIDTH, height: 82, color: brandNavy });
  page.drawRectangle({ x: 0, y: LETTER_HEIGHT - 86, width: LETTER_WIDTH, height: 4, color: brandRed });
  drawTextChecked(page, bold, "PRO STAR", 44, 754, 22, rgb(1, 1, 1), 180);
  drawTextChecked(page, regular, "MECHANICAL", 45, 739, 9, rgb(0.85, 0.9, 0.95), 180);
  drawTextChecked(page, bold, subtitle, 252, 752, 13, rgb(1, 1, 1), 316, "right");
  drawTextChecked(page, regular, `${periodLabel(run.periodStart)} | Run ${run.runId} | Revision ${run.periodRevision}`, 252, 734, 9, rgb(0.85, 0.9, 0.95), 316, "right");
  return 685;
}

function drawConfigBlock(page: PDFPage, regular: PDFFont, bold: PDFFont, run: CommissionRunForExport, y: number) {
  page.drawRectangle({ x: PAGE_MARGIN, y: y - 62, width: LETTER_WIDTH - PAGE_MARGIN * 2, height: 62, color: soft });
  drawTextChecked(page, bold, "RUN CONTROLS", PAGE_MARGIN + 12, y - 17, 8, brandNavy, 100);
  const values = [
    ["Status", run.periodStatus.toUpperCase()],
    ["Pool", `${run.readModel.config.poolPercent.toFixed(2)}%`],
    ["Minimum", `${run.readModel.config.minBonusPercent.toFixed(2)}%`],
    ["Efficiency", run.readModel.config.efficiencyEnabled ? `Enabled (+/-${run.readModel.config.maxEfficiencyAdjustmentPercent}%)` : "Disabled"],
    ["Source", run.sourceComplete ? "Complete" : "Incomplete"],
  ];
  values.forEach(([label, value], index) => {
    const x = PAGE_MARGIN + 12 + index * 103;
    drawTextChecked(page, regular, label, x, y - 34, 7, muted, 96);
    drawTextChecked(page, bold, value, x, y - 48, 9, ink, 96);
  });
  return y - 80;
}

function drawTeamTotals(page: PDFPage, regular: PDFFont, bold: PDFFont, run: CommissionRunForExport, y: number) {
  drawTextChecked(page, bold, "TEAM RECONCILIATION", PAGE_MARGIN, y, 9, brandNavy, 180);
  const values = [
    ["Completed jobs", String(run.readModel.completedJobs)],
    ["Work value", usd(run.readModel.totalWorkValue)],
    ["Inside pool", usd(run.readModel.insidePoolTotal)],
    ["Outside adjustments", usd(run.readModel.outsidePoolTotal)],
    ["Calculated due", usd(run.readModel.payrollTotal)],
  ];
  values.forEach(([label, value], index) => {
    const x = PAGE_MARGIN + index * 105;
    drawTextChecked(page, regular, label, x, y - 17, 7, muted, 100);
    drawTextChecked(page, bold, value, x, y - 32, 10, index === 4 ? brandRed : ink, 100);
  });
  return y - 52;
}

function drawTechnicianTableHeader(page: PDFPage, regular: PDFFont, bold: PDFFont, y: number) {
  drawTextChecked(page, bold, "CALCULATED COMMISSION DUE", PAGE_MARGIN, y, 9, brandNavy, 220);
  const top = y - 16;
  page.drawRectangle({ x: PAGE_MARGIN, y: top - 18, width: LETTER_WIDTH - PAGE_MARGIN * 2, height: 18, color: brandNavy });
  [
    ["Rank / Technician", PAGE_MARGIN + 7, 170, "left"],
    ["Tier", 226, 55, "left"],
    ["Work value", 286, 82, "right"],
    ["Raw", 372, 63, "right"],
    ["Adjustments", 440, 65, "right"],
    ["Calc. due", 510, 58, "right"],
  ].forEach(([label, x, width, align]) => drawTextChecked(page, regular, String(label), Number(x), top - 12, 7, rgb(1, 1, 1), Number(width), align as "left" | "right"));
  return top - 25;
}

function drawTechnicianRow(page: PDFPage, regular: PDFFont, technician: CommissionTechnicianResult, y: number) {
  const rowHeight = 25;
  page.drawLine({ start: { x: PAGE_MARGIN, y: y - rowHeight + 3 }, end: { x: LETTER_WIDTH - PAGE_MARGIN, y: y - rowHeight + 3 }, thickness: 0.5, color: line });
  drawTextChecked(page, regular, `${technician.rank ?? "-"}. ${technician.displayName}`, PAGE_MARGIN + 7, y - 11, 8, ink, 170);
  drawTextChecked(page, regular, `${technician.tier ?? "Standard"}${technician.belowMinimum ? " / below min" : ""}`, 226, y - 11, 7, technician.belowMinimum ? brandRed : ink, 55);
  drawTextChecked(page, regular, usd(technician.effectiveAllocatedWorkValue ?? technician.allocatedWorkValue ?? 0), 286, y - 11, 8, ink, 82, "right");
  drawTextChecked(page, regular, usd(technician.rawBonus), 372, y - 11, 8, ink, 63, "right");
  const adjustments = (technician.efficiency?.effect ?? 0)
    + (technician.insidePoolAdjustment ?? 0)
    + (technician.overrideRedistribution ?? 0)
    + (technician.outsidePoolAdjustment ?? 0);
  drawTextChecked(page, regular, usd(adjustments), 440, y - 11, 8, ink, 65, "right");
  drawTextChecked(page, regular, usd(technician.payrollBonus ?? technician.finalBonus), 510, y - 11, 8, brandNavy, 58, "right");
  drawTextChecked(page, regular, `Final inside ${usd(technician.finalBonus)} | Forfeited ${usd(technician.forfeitedBonus)} | Reallocated ${usd(technician.reallocationReceived)}`, PAGE_MARGIN + 7, y - 20, 6, muted, 430);
  return y - rowHeight;
}

function drawReconciliationBlock(page: PDFPage, regular: PDFFont, bold: PDFFont, run: CommissionRunForExport, y: number) {
  drawTextChecked(page, bold, "VALIDATION", PAGE_MARGIN, y, 9, brandNavy, 100);
  const checks = [
    ["Inside-pool calculation equals pool", run.readModel.invariants.insidePoolReconciles],
    ["Outside-pool adjustments reconcile", run.readModel.invariants.outsidePoolReconciles],
    ["Job allocations reconcile", run.readModel.invariants.jobAllocationsReconcile],
    ["Calculated due amounts are nonnegative", run.readModel.invariants.nonnegativePayroll],
  ];
  checks.forEach(([label, valid], index) => {
    const rowY = y - 18 - index * 15;
    page.drawRectangle({ x: PAGE_MARGIN, y: rowY - 2, width: 8, height: 8, color: valid ? rgb(0.12, 0.48, 0.3) : brandRed });
    drawTextChecked(page, regular, `${valid ? "PASS" : "FAIL"}  ${label}`, PAGE_MARGIN + 15, rowY - 1, 8, ink, 250);
  });
  drawTextChecked(page, regular, `Manifest ${run.inputManifestHash.slice(0, 18)} | Calculation ${run.calculationHash.slice(0, 18)}`, 330, y - 18, 7, muted, 238, "right");
  drawTextChecked(page, regular, `Export identity: run-${run.runId}/worksheet-pdf/rev-${run.periodRevision}`, 330, y - 34, 7, muted, 238, "right");
  return y - 84;
}

function drawSignatureBlock(page: PDFPage, regular: PDFFont, bold: PDFFont, y: number) {
  drawTextChecked(page, bold, "REVIEW APPROVAL", PAGE_MARGIN, y, 9, brandNavy, 120);
  const fields = [["Prepared by", PAGE_MARGIN], ["Reviewed by", 220], ["Approved / locked by", 398]] as const;
  fields.forEach(([label, x]) => {
    page.drawLine({ start: { x, y: y - 42 }, end: { x: x + 145, y: y - 42 }, thickness: 0.7, color: muted });
    drawTextChecked(page, regular, label, x, y - 54, 7, muted, 100);
    page.drawLine({ start: { x, y: y - 78 }, end: { x: x + 145, y: y - 78 }, thickness: 0.7, color: muted });
    drawTextChecked(page, regular, "Date", x, y - 90, 7, muted, 100);
  });
}

function drawPdfFooter(page: PDFPage, regular: PDFFont, run: CommissionRunForExport, pageNumber: number, pageCount?: number) {
  page.drawLine({ start: { x: PAGE_MARGIN, y: 32 }, end: { x: LETTER_WIDTH - PAGE_MARGIN, y: 32 }, thickness: 0.5, color: line });
  drawTextChecked(page, regular, "CONFIDENTIAL - CALCULATED COMMISSION; PAYMENT NOT CONFIRMED", PAGE_MARGIN, 19, 6, muted, 330);
  drawTextChecked(page, regular, `Run ${run.runId} | Page ${pageNumber}${pageCount ? ` of ${pageCount}` : ""}`, 390, 19, 6, muted, 178, "right");
}

function addPdfPage(document: PDFDocument) {
  return document.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
}

function drawTextChecked(
  page: PDFPage,
  font: PDFFont,
  value: string,
  x: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
  maxWidth: number,
  align: "left" | "right" = "left",
) {
  if (y < 10 || y > LETTER_HEIGHT - 10 || x < 0 || x + maxWidth > LETTER_WIDTH + 0.01) {
    throw new Error(`PDF layout bounds violation for text: ${value}`);
  }
  const text = fitText(font, value, size, maxWidth);
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: align === "right" ? x + maxWidth - width : x, y, size, font, color });
}

function fitText(font: PDFFont, value: string, size: number, maxWidth: number) {
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let result = value;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}...`, size) > maxWidth) result = result.slice(0, -1);
  return `${result}...`;
}

function assertRunExportable(run: CommissionRunForExport) {
  if (
    run.runStatus !== "succeeded"
    || run.calculationStale
    || !run.sourceComplete
    || !run.verifiedIdentity
    || !["reviewed", "exported", "locked"].includes(run.periodStatus)
  ) {
    throw new CommissionLifecycleError("Only a canonically verified, current, successful, source-complete commission run can be exported.");
  }
  if (!run.inputManifestHash || !run.sourceHash || !run.configHash || !run.overrideHash) {
    throw new CommissionLifecycleError("The run is missing immutable provenance hashes.");
  }
  if (!run.readModel.invariants.insidePoolReconciles || !run.readModel.invariants.nonnegativePayroll) {
    throw new CommissionLifecycleError("The run does not satisfy payout reconciliation invariants.");
  }
}

function exportRunFromCanonical(
  row: CommissionCanonicalRunRow,
  verification: Extract<ReturnType<typeof verifyCommissionCanonicalRun>, { ok: true }>,
): CommissionRunForExport {
  return {
    periodId: Number(row.period_id), periodStart: row.period_start, periodEnd: row.period_end,
    periodRevision: row.revision, editRevision: row.edit_revision,
    periodStatus: row.status as CommissionLifecycleStatus, calculationStale: row.calculation_stale,
    runId: Number(verification.identity.runId), runRevision: verification.identity.runRevision,
    runStatus: row.run_status!, sourceComplete: true,
    sourceEvidence: row.source_evidence as CommissionSourceEvidence,
    inputManifestHash: verification.identity.inputManifestHash,
    sourceHash: verification.identity.sourceHash, configHash: verification.identity.configHash,
    overrideHash: verification.identity.overrideHash,
    calculationHash: verification.identity.calculationHash,
    createdAt: row.calculated_at!, createdBy: row.calculated_by!,
    readModel: verification.readModel, manifest: verification.manifest,
    verifiedIdentity: verification.identity,
  };
}

function sameVerifiedIdentity(left: CommissionVerifiedIdentity, right: CommissionVerifiedIdentity) {
  return left.periodId === right.periodId
    && left.periodRevision === right.periodRevision
    && left.editRevision === right.editRevision
    && left.runId === right.runId
    && left.runRevision === right.runRevision
    && left.immutable === right.immutable
    && left.calculationHash.toLowerCase() === right.calculationHash.toLowerCase()
    && left.inputManifestHash.toLowerCase() === right.inputManifestHash.toLowerCase()
    && left.sourceHash.toLowerCase() === right.sourceHash.toLowerCase()
    && left.configHash.toLowerCase() === right.configHash.toLowerCase()
    && left.overrideHash.toLowerCase() === right.overrideHash.toLowerCase();
}

function mapExport(row: ExportRow): CommissionExportRecord {
  return {
    id: Number(row.id),
    runId: Number(row.calculation_run_id),
    type: row.export_type,
    filename: row.filename,
    storageKey: row.storage_key,
    fileHash: row.file_hash,
    contentType: row.content_type,
    size: Number(row.file_size_bytes),
    status: row.status,
    exportedBy: row.exported_by,
    exportedAt: row.exported_at,
    retainedUntil: row.retained_until,
    downloadCount: row.download_count,
    lastDownloadedAt: row.last_downloaded_at,
  };
}

function exportFilename(run: CommissionRunForExport, type: CommissionExportType) {
  const base = `pro-star-commissions-${run.periodStart.slice(0, 7)}-run-${run.runId}-rev-${run.periodRevision}`;
  return `${base}-${type.replaceAll("_", "-")}.${type === "worksheet_pdf" ? "pdf" : "csv"}`;
}

function contentTypeFor(type: CommissionExportType) {
  return type === "worksheet_pdf" ? "application/pdf" : "text/csv; charset=utf-8";
}

function retainedUntilDate(periodEnd: string) {
  const date = new Date(`${periodEnd}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + 7);
  return date.toISOString().slice(0, 10);
}

function periodLabel(periodStart: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${periodStart}T00:00:00Z`));
}

function usd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
}

function moneyValue(value: number) {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function toCsv(rows: Array<Array<string | number | boolean | null>>) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function csvCell(value: string | number | boolean | null) {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
