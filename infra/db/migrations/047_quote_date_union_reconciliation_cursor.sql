-- Quotes are reconciled as the deduplicated union of DateApproved and
-- DateIssued daily source pages. Persist the active date stream so a bounded
-- worker can resume safely between either stream and their paginated pages.
alter table metrics.reconciliation_continuations
  add column if not exists cursor_source_date text not null default 'date_approved';

alter table metrics.reconciliation_continuations
  drop constraint if exists reconciliation_continuation_cursor_source_date_check;

alter table metrics.reconciliation_continuations
  add constraint reconciliation_continuation_cursor_source_date_check check (
    cursor_source_date in ('date_approved', 'date_issued')
  );

comment on column metrics.reconciliation_continuations.cursor_source_date is
  'Current daily source stream. Quotes traverse DateApproved then DateIssued and deduplicate IDs; jobs use date_approved only.';
