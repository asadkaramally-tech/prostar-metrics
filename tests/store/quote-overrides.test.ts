import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  getQuoteOverrideHistory,
  persistQuoteOverrideAction,
  QuoteOverrideConflictError,
  QuoteOverrideIdempotencyConflictError,
  type QuoteOverrideQuery,
} from "../../src/lib/store/quote-overrides";
import { QUOTE_CLASSIFICATION_LOCK_KEY } from "../../src/lib/store/quote-classification-rebuild";

test("persistQuoteOverrideAction writes an atomic audited exclusion with caller idempotency", async () => {
  let capturedSql = "";
  let capturedValues: unknown[] = [];
  const query: QuoteOverrideQuery = async <T>(sql: string, values?: unknown[]) => {
    capturedSql = sql;
    capturedValues = values ?? [];
    return {
      rows: [{
        quote_found: true,
        current_revision: 0,
        id: 91,
        quote_id: 700,
        action: "exclude",
        outcome: "excluded",
        previous_outcome: "won",
        reason: "Confirmed duplicate quote excluded from reporting.",
        evidence_url: "https://example.test/evidence/700",
        actor_email: "operator@example.test",
        revision: 1,
        active: true,
        created_at: "2026-07-09T12:00:00Z",
        superseded_at: null,
        idempotent_match: true,
      } as T],
      rowCount: 1,
    };
  };

  const result = await persistQuoteOverrideAction({
    quoteId: 700,
    action: "exclude",
    expectedActiveExclusionRevision: 0,
    idempotencyKey: "quote-action-700-exclude-a",
    reason: "Confirmed duplicate quote excluded from reporting.",
    evidenceUrl: "https://example.test/evidence/700",
    previousDateApproved: "2026-06-12",
    actorEmail: "Operator@Example.Test",
  }, query);

  assert.equal(result.action, "exclude");
  assert.equal(result.revision, 1);
  assert.equal(result.active, true);
  assert.match(capturedSql, /pg_advisory_xact_lock/);
  assert.match(capturedSql, /\$2 = 'reinstate'/);
  assert.match(capturedSql, /manual_reinstated/);
  assert.match(capturedSql, /lower\(trim\(coalesce\(q\.status_name/);
  assert.match(capturedSql, /like 'quote:%'/);
  assert.match(capturedSql, /authoritative_quote_linked_job_id/);
  assert.match(capturedSql, /authoritative_job_source_quote_id/);
  assert.match(capturedSql, /complete_traversal = true/);
  assert.match(capturedSql, /source_deleted_at is null/);
  assert.match(capturedSql, /order by raw\.extracted_at desc, raw\.id desc/);
  assert.doesNotMatch(capturedSql, /q\.linked_job_id/);
  assert.doesNotMatch(capturedSql, /j\.job_no = q\.job_no/);
  assert.doesNotMatch(capturedSql, /j\.converted_from_id = q\.quote_id/);
  assert.match(capturedSql, /update metrics\.metrics_quotes/);
  assert.match(capturedSql, /update metrics\.quote_snapshots/);
  assert.match(capturedSql, /insert into metrics\.audit_events/);
  assert.match(capturedSql, /insert into metrics\.rollup_rebuild_queue/);
  assert.match(capturedSql, /idempotency_key = \$6\s+and \(select count\(\*\) from target\) >= 0/);
  assert.doesNotMatch(capturedSql, /reviewed_quote_exclusion_seeds/);
  assert.deepEqual(capturedValues, [
    700,
    "exclude",
    0,
    "Confirmed duplicate quote excluded from reporting.",
    "https://example.test/evidence/700",
    "quote-action-700-exclude-a",
    "operator@example.test",
    "2026-06-12",
    QUOTE_CLASSIFICATION_LOCK_KEY,
  ]);
});

test("store runtime rejects unsupported actions and malformed idempotency before querying", async () => {
  let queryCalls = 0;
  const query: QuoteOverrideQuery = async () => {
    queryCalls += 1;
    return { rows: [], rowCount: 0 };
  };

  await assert.rejects(
    persistQuoteOverrideAction({
      quoteId: 700,
      action: "accept" as never,
      expectedActiveExclusionRevision: 0,
      idempotencyKey: "quote-action-700-accept",
      reason: "Unsupported acceptance action.",
      actorEmail: "operator@example.test",
    }, query),
    /action must be exclude or reinstate/,
  );
  await assert.rejects(
    persistQuoteOverrideAction({
      quoteId: 700,
      action: "exclude",
      expectedActiveExclusionRevision: 0,
      idempotencyKey: "short",
      reason: "Valid exclusion reason.",
      actorEmail: "operator@example.test",
    }, query),
    /idempotencyKey must be 8 to 200/,
  );
  assert.equal(queryCalls, 0);
});

test("stale active-exclusion revisions and idempotency collisions are conflicts", async () => {
  const staleQuery: QuoteOverrideQuery = async <T>() => ({
    rows: [{
      quote_found: true,
      current_revision: 4,
      id: null,
      quote_id: null,
      action: null,
      outcome: null,
      previous_outcome: null,
      reason: null,
      evidence_url: null,
      actor_email: null,
      revision: null,
      active: null,
      created_at: null,
      superseded_at: null,
      idempotent_match: true,
    } as T],
    rowCount: 1,
  });
  await assert.rejects(
    persistQuoteOverrideAction({
      quoteId: 700,
      action: "reinstate",
      expectedActiveExclusionRevision: 3,
      idempotencyKey: "quote-action-700-reinstate-stale",
      reason: "Reinstate after duplicate review.",
      actorEmail: "operator@example.test",
    }, staleQuery),
    (error: unknown) => error instanceof QuoteOverrideConflictError && error.currentRevision === 4,
  );

  const collisionQuery: QuoteOverrideQuery = async <T>() => ({
    rows: [{
      quote_found: true,
      current_revision: 0,
      id: 11,
      quote_id: 700,
      action: "exclude",
      outcome: "excluded",
      previous_outcome: "lost",
      reason: "Original reason.",
      evidence_url: null,
      actor_email: "operator@example.test",
      revision: 1,
      active: true,
      created_at: "2026-07-09T12:00:00Z",
      superseded_at: null,
      idempotent_match: false,
    } as T],
    rowCount: 1,
  });
  await assert.rejects(
    persistQuoteOverrideAction({
      quoteId: 700,
      action: "exclude",
      expectedActiveExclusionRevision: 0,
      idempotencyKey: "quote-action-700-collision",
      reason: "Different reason using same key.",
      actorEmail: "operator@example.test",
    }, collisionQuery),
    QuoteOverrideIdempotencyConflictError,
  );
});

test("successful-looking rows with mismatched action, outcome, or revision are rejected", async () => {
  const base = {
    quote_found: true,
    current_revision: 1,
    id: 12,
    quote_id: 700,
    action: "reinstate",
    outcome: "manual_reinstated",
    previous_outcome: "excluded",
    reason: "Owner reinstated from current source evidence.",
    evidence_url: null,
    actor_email: "operator@example.test",
    revision: 2,
    active: false,
    created_at: "2026-07-09T12:00:00Z",
    superseded_at: "2026-07-09T12:00:00Z",
    idempotent_match: true,
  } as const;
  const malformed = [
    { ...base, action: "exclude" },
    { ...base, outcome: "excluded" },
    { ...base, revision: 3 },
  ];
  for (const row of malformed) {
    const query: QuoteOverrideQuery = async <T>() => ({ rows: [row as T], rowCount: 1 });
    await assert.rejects(
      persistQuoteOverrideAction({
        quoteId: 700,
        action: "reinstate",
        expectedActiveExclusionRevision: 1,
        idempotencyKey: "quote-action-700-exact-semantics",
        reason: "Owner reinstated from current source evidence.",
        actorEmail: "operator@example.test",
      }, query),
      QuoteOverrideIdempotencyConflictError,
    );
  }
});

test("history includes immutable reinstatement and legacy rows newest first", async () => {
  let capturedSql = "";
  const query: QuoteOverrideQuery = async <T>(sql: string, values?: unknown[]) => {
    capturedSql = sql;
    assert.deepEqual(values, [702]);
    return {
      rows: [
        { id: 13, quote_id: 702, action: "reinstate", outcome: "manual_reinstated", previous_outcome: "excluded", reason: "Source evidence restored.", evidence_url: null, actor_email: "admin@example.test", revision: 2, active: false, created_at: "2026-07-10T12:00:00Z", superseded_at: "2026-07-10T12:00:00Z" },
        { id: 12, quote_id: 702, action: "exclude", outcome: "excluded", previous_outcome: "lost", reason: "Duplicate quote.", evidence_url: null, actor_email: "admin@example.test", revision: 1, active: false, created_at: "2026-07-09T12:00:00Z", superseded_at: "2026-07-10T12:00:00Z" },
        { id: 11, quote_id: 702, action: null, outcome: "won", previous_outcome: "unknown", reason: "Legacy reviewed outcome.", evidence_url: null, actor_email: "operator@example.test", revision: 7, active: false, created_at: "2026-03-06T12:00:00Z", superseded_at: "2026-07-09T12:00:00Z" },
      ] as T[],
      rowCount: 3,
    };
  };

  const history = await getQuoteOverrideHistory(702, query);
  assert.deepEqual(history.map((item) => item.outcome), ["manual_reinstated", "excluded", "won"]);
  assert.equal(history[0].action, "reinstate");
  assert.match(capturedSql, /manual_reinstated/);
  assert.match(capturedSql, /order by revision desc, created_at desc, id desc/);
});

test("pre-034 exclusion and reinstatement stay compatible while ignoring legacy won/lost history", async () => {
  const db = new PGlite();
  const query: QuoteOverrideQuery = async <T>(sql: string, values?: unknown[]) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  try {
    await createOverrideTestSchema(db);
    await seedClassificationPaths(db);

    await db.exec(`
      insert into metrics.quote_classification_overrides (
        quote_id, category, action, outcome, previous_outcome, reason, actor_email,
        revision, idempotency_key, active
      ) values (
        700, 'HVAC', null, 'won', 'unknown', 'Historical migration-017 decision.',
        'legacy-reviewer@example.test', 99, 'legacy-key-collision-700', false
      )
    `);
    await assert.rejects(
      persistQuoteOverrideAction({
        quoteId: 700,
        action: "exclude",
        expectedActiveExclusionRevision: 0,
        idempotencyKey: "legacy-key-collision-700",
        reason: "Attempted exclusion using a legacy decision key.",
        actorEmail: "operator@example.test",
      }, query),
      QuoteOverrideIdempotencyConflictError,
    );

    for (const quoteId of [700, 701, 702, 703, 704]) {
      const exclusion = await persistQuoteOverrideAction({
        quoteId,
        action: "exclude",
        expectedActiveExclusionRevision: 0,
        idempotencyKey: `quote-action-${quoteId}-exclude-a`,
        reason: `Operator excluded quote ${quoteId} from reporting.`,
        actorEmail: "operator@example.test",
      }, query);
      assert.equal(exclusion.outcome, "excluded");
      assert.equal(exclusion.revision, 1);

      const reinstatementParams = {
        quoteId,
        action: "reinstate" as const,
        expectedActiveExclusionRevision: 1,
        idempotencyKey: `quote-action-${quoteId}-reinstate-a`,
        reason: `Operator reinstated quote ${quoteId} from source evidence.`,
        actorEmail: "operator@example.test",
      };
      const reinstatement = await persistQuoteOverrideAction(reinstatementParams, query);
      assert.equal(reinstatement.outcome, "manual_reinstated");
      assert.equal(reinstatement.revision, 2);
      assert.equal(reinstatement.active, false);

      const retry = await persistQuoteOverrideAction(reinstatementParams, query);
      assert.equal(retry.id, reinstatement.id);
    }

    const classifications = await db.query<{
      quote_id: number;
      outcome: string;
      outcome_reason: string;
      won: boolean;
      won_value: string;
    }>(`
      select q.quote_id::int, q.outcome, q.outcome_reason, s.won, s.won_value::text
        from metrics.metrics_quotes q
        join metrics.quote_snapshots s using (quote_id)
       order by q.quote_id
    `);
    assert.deepEqual(classifications.rows, [
      { quote_id: 700, outcome: "won", outcome_reason: "accepted_online", won: true, won_value: "1000.00" },
      { quote_id: 701, outcome: "won", outcome_reason: "converted_job", won: true, won_value: "1100.00" },
      { quote_id: 702, outcome: "lost", outcome_reason: "no_acceptance_evidence", won: false, won_value: "0.00" },
      { quote_id: 703, outcome: "won", outcome_reason: "converted_job", won: true, won_value: "1300.00" },
      { quote_id: 704, outcome: "lost", outcome_reason: "no_acceptance_evidence", won: false, won_value: "0.00" },
    ]);

    const history = await db.query<{ outcome: string; revision: number; active: boolean }>(`
      select outcome, revision, active
        from metrics.quote_classification_overrides
       where quote_id = 704
       order by created_at, id
    `);
    assert.deepEqual(history.rows, [
      { outcome: "won", revision: 7, active: true },
      { outcome: "excluded", revision: 1, active: false },
      { outcome: "manual_reinstated", revision: 2, active: false },
    ]);
    const audit = await db.query<{ count: number }>("select count(*)::int as count from metrics.audit_events");
    assert.equal(audit.rows[0]?.count, 10);
  } finally {
    await db.close();
  }
});

test("conflicting authoritative direct aliases abort an override without partial writes", async () => {
  const db = new PGlite();
  const query: QuoteOverrideQuery = async <T>(sql: string, values?: unknown[]) => {
    const result = await db.query<T>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  try {
    await createOverrideTestSchema(db);
    await seedClassificationPaths(db);
    await db.exec(`
      insert into metrics.raw_simpro_snapshots (
        entity_type, entity_id, payload, complete_traversal, extracted_at
      ) values (
        'quote_details', '702',
        '{"ID":702,"LinkedJobID":9001,"linkedJobId":9002}',
        true, '2026-07-02T00:00:00Z'
      )
    `);
    const before = await overrideWriteState(db, 702);

    await assert.rejects(
      persistQuoteOverrideAction({
        quoteId: 702,
        action: "exclude",
        expectedActiveExclusionRevision: 0,
        idempotencyKey: "quote-action-702-conflicting-source",
        reason: "Reviewer conflict attack must fail atomically.",
        actorEmail: "operator@example.test",
      }, query),
      /direct-link scalar fields conflict/,
    );

    assert.deepEqual(await overrideWriteState(db, 702), before);
  } finally {
    await db.close();
  }
});

async function overrideWriteState(db: PGlite, quoteId: number) {
  const result = await db.query(`
    select quote.outcome, quote.outcome_reason,
           snapshot.won, snapshot.win_loss_reason,
           (select count(*)::integer from metrics.quote_classification_overrides
             where quote_id = $1) as override_count,
           (select count(*)::integer from metrics.audit_events) as audit_count,
           (select count(*)::integer from metrics.rollup_rebuild_queue) as queue_count
      from metrics.metrics_quotes quote
      join metrics.quote_snapshots snapshot using (quote_id)
     where quote.quote_id = $1
  `, [quoteId]);
  return result.rows[0];
}

async function createOverrideTestSchema(db: PGlite) {
  await db.exec(`
    create schema metrics;
    create type metrics.quote_override_action as enum ('exclude', 'reinstate');
    create table metrics.metrics_quotes (
      quote_id bigint primary key,
      category text not null,
      status_name text,
      linked_job_id bigint,
      job_no text,
      outcome text not null default 'unknown',
      date_issued date,
      date_approved date,
      total numeric(14, 2) not null default 0,
      source_deleted_at timestamptz,
      outcome_reason text not null default 'unclassified',
      won_reason text not null default 'not_won',
      updated_from_source_at timestamptz not null default now()
    );
    create table metrics.metrics_jobs (
      job_id bigint primary key,
      job_no text,
      converted_from_type text,
      converted_from_id bigint,
      source_deleted_at timestamptz
    );
    create table metrics.raw_simpro_snapshots (
      id bigserial primary key,
      entity_type text not null,
      entity_id text not null,
      payload jsonb not null,
      complete_traversal boolean not null default false,
      source_deleted_at timestamptz,
      extracted_at timestamptz not null default now()
    );
    create table metrics.quote_snapshots (
      quote_id bigint primary key,
      won boolean,
      won_value numeric(14, 2),
      win_loss_reason text,
      updated_at timestamptz not null default now()
    );
    create table metrics.quote_classification_overrides (
      id bigserial primary key,
      quote_id bigint not null,
      category text not null,
      won_override boolean,
      action metrics.quote_override_action,
      outcome text,
      previous_outcome text,
      reason text not null,
      evidence_url text,
      actor_email text not null,
      revision integer not null default 1,
      idempotency_key text unique,
      active boolean not null default true,
      created_at timestamptz not null default now(),
      superseded_at timestamptz
    );
    create table metrics.audit_events (
      id bigserial primary key,
      actor_email text not null,
      action text not null,
      entity_type text not null,
      entity_id text not null,
      before_value jsonb,
      after_value jsonb,
      reason text
    );
    create table metrics.rollup_rebuild_queue (
      id bigserial primary key,
      metric_family text not null,
      period_grain text not null,
      period_start date not null,
      dimensions_json jsonb not null default '{}'::jsonb,
      reason text not null,
      idempotency_key text unique
    );
    create or replace function metrics.authoritative_relationship_scalar_id(
      p_value jsonb,
      p_context text
    ) returns bigint language plpgsql immutable as \$function\$
    declare
      scalar_text text;
      numeric_value numeric;
    begin
      if p_value is null or jsonb_typeof(p_value) = 'null' then return null; end if;
      if jsonb_typeof(p_value) = 'string' then
        scalar_text := trim(p_value #>> '{}');
      elsif jsonb_typeof(p_value) = 'number' then
        scalar_text := p_value::text;
      else
        raise exception '% is not a numeric or string scalar ID.', p_context using errcode = '22023';
      end if;
      begin
        numeric_value := scalar_text::numeric;
      exception when others then
        raise exception '% is not a positive scalar ID.', p_context using errcode = '22023';
      end;
      if numeric_value <> trunc(numeric_value) or numeric_value <= 0 or numeric_value > 9007199254740991 then
        raise exception '% is not a positive safe-integer scalar ID.', p_context using errcode = '22023';
      end if;
      return numeric_value::bigint;
    end;
    \$function\$;
    create or replace function metrics.authoritative_quote_linked_job_id(p_payload jsonb)
    returns bigint language plpgsql immutable as \$function\$
    declare
      field_name text;
      candidate_id bigint;
      resolved_id bigint;
    begin
      if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
        raise exception 'Authoritative raw quote payload is not an object.' using errcode = '22023';
      end if;
      foreach field_name in array array['LinkedJobID', 'linkedJobId', 'linked_job_id'] loop
        if not (p_payload ? field_name) then continue; end if;
        candidate_id := metrics.authoritative_relationship_scalar_id(p_payload -> field_name, 'Raw quote ' || field_name);
        if candidate_id is null then continue; end if;
        if resolved_id is not null and resolved_id <> candidate_id then
          raise exception 'Authoritative raw quote direct-link scalar fields conflict.' using errcode = '22023';
        end if;
        resolved_id := candidate_id;
      end loop;
      return resolved_id;
    end;
    \$function\$;
    create or replace function metrics.authoritative_job_source_quote_id(p_payload jsonb)
    returns bigint language plpgsql immutable as \$function\$
    declare
      converted_name text;
      type_name text;
      id_name text;
      candidate jsonb;
      candidate_type text;
      resolved_type text;
      candidate_id bigint;
      resolved_id bigint;
    begin
      if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
        raise exception 'Authoritative raw job payload is not an object.' using errcode = '22023';
      end if;
      foreach converted_name in array array['ConvertedFrom', 'convertedFrom', 'converted_from'] loop
        if not (p_payload ? converted_name) or jsonb_typeof(p_payload -> converted_name) = 'null' then continue; end if;
        candidate := p_payload -> converted_name;
        if jsonb_typeof(candidate) <> 'object' then
          raise exception 'Authoritative raw job provenance is not an object.' using errcode = '22023';
        end if;
        foreach type_name in array array['Type', 'type'] loop
          if not (candidate ? type_name) or jsonb_typeof(candidate -> type_name) = 'null' then continue; end if;
          if jsonb_typeof(candidate -> type_name) <> 'string' then
            raise exception 'Authoritative raw job type is not a string.' using errcode = '22023';
          end if;
          candidate_type := candidate ->> type_name;
          if resolved_type is not null and resolved_type <> candidate_type then
            raise exception 'Authoritative raw job ConvertedFrom type aliases conflict.' using errcode = '22023';
          end if;
          resolved_type := candidate_type;
        end loop;
        foreach id_name in array array['ID', 'Id', 'id'] loop
          if not (candidate ? id_name) then continue; end if;
          candidate_id := metrics.authoritative_relationship_scalar_id(candidate -> id_name, 'Raw job ConvertedFrom.' || id_name);
          if candidate_id is null then continue; end if;
          if resolved_id is not null and resolved_id <> candidate_id then
            raise exception 'Authoritative raw job ConvertedFrom ID aliases conflict.' using errcode = '22023';
          end if;
          resolved_id := candidate_id;
        end loop;
      end loop;
      if resolved_type is distinct from 'Quote' then return null; end if;
      if resolved_id is null then
        raise exception 'Authoritative raw job ConvertedFrom.Type is Quote but no valid ID is present.' using errcode = '22023';
      end if;
      return resolved_id;
    end;
    \$function\$;
  `);
}

async function seedClassificationPaths(db: PGlite) {
  await db.exec(`
    insert into metrics.metrics_jobs (job_id, job_no, converted_from_type, converted_from_id) values
      (9001, 'J-9001', null, null),
      (9002, '9002', null, null),
      (9003, 'J-9003', ' Quote ', 703);
    insert into metrics.metrics_quotes (
      quote_id, category, status_name, linked_job_id, job_no, outcome, date_issued, date_approved, total,
      outcome_reason, won_reason
    ) values
      (700, 'HVAC', ' Quote: Quote Accepted Online ', null, null, 'lost', '2026-06-10', '2026-06-10', 1000, 'manual_lost', 'manual_lost'),
      (701, 'HVAC', 'Other', 9001, null, 'lost', '2026-06-11', '2026-06-11', 1100, 'manual_lost', 'manual_lost'),
      (702, 'HVAC', 'Other', null, '9002', 'lost', '2026-06-12', '2026-06-12', 1200, 'manual_lost', 'manual_lost'),
      (703, 'HVAC', 'Other', null, null, 'lost', '2026-06-13', '2026-06-13', 1300, 'manual_lost', 'manual_lost'),
      (704, 'HVAC', 'Other', null, null, 'won', '2026-06-14', '2026-06-14', 1400, 'manual_won', 'manual_won');
    insert into metrics.raw_simpro_snapshots (
      entity_type, entity_id, payload, complete_traversal, extracted_at
    ) values
      ('quote_details', '700', '{"ID":700,"LinkedJobID":null}', true, '2026-07-01T00:00:00Z'),
      ('quote_details', '701', '{"ID":701,"LinkedJobID":9001}', true, '2026-07-01T00:00:00Z'),
      ('quote_details', '702', '{"ID":702,"LinkedJobID":null,"JobNo":"9002"}', true, '2026-07-01T00:00:00Z'),
      ('quote_details', '703', '{"ID":703,"LinkedJobID":null}', true, '2026-07-01T00:00:00Z'),
      ('quote_details', '704', '{"ID":704,"LinkedJobID":null}', true, '2026-07-01T00:00:00Z'),
      ('job_details', '9001', '{"ID":9001,"ConvertedFrom":null}', true, '2026-07-01T00:00:00Z'),
      ('job_details', '9002', '{"ID":9002,"ConvertedFrom":null}', true, '2026-07-01T00:00:00Z'),
      ('job_details', '9003', '{"ID":9003,"ConvertedFrom":{"Type":"Quote","ID":703}}', true, '2026-07-01T00:00:00Z');
    insert into metrics.quote_snapshots (quote_id, won, won_value, win_loss_reason)
    select quote_id, outcome = 'won', case when outcome = 'won' then total else 0 end, outcome_reason
      from metrics.metrics_quotes;
    insert into metrics.quote_classification_overrides (
      quote_id, category, action, outcome, previous_outcome, reason, actor_email,
      revision, idempotency_key, active, created_at
    ) values
      (704, 'HVAC', null, 'won', 'unknown', 'Migration 017 reviewed won decision.',
       'legacy-reviewer@example.test', 7, 'legacy-quote-review-2026-03-06:704', true,
       '2026-03-06T12:00:00Z');
  `);
}
