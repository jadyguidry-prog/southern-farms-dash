-- Persist Square Labor timecards (shifts) so labor cost survives a restart.
--
-- Why this table exists
-- --------------------
-- Labor data was previously only ever read live from the Square API, so nothing
-- about hours or wage rates survived a process restart and every question about
-- labor cost required a network round trip. Orders and payments are already
-- persisted; this closes the gap for labor.
--
-- Additive and idempotent: creates one new table plus its indexes and policies.
-- Nothing existing is renamed, altered or dropped. Safe to re-run.
--
-- Naming follows the existing Square tables exactly: the Square id is the
-- primary key (as in square_payments.square_payment_id), timestamps are
-- timestamptz, money is numeric, the untouched API object is kept in `raw`,
-- and `synced_at` records when we last wrote the row.

create table if not exists public.square_shifts (
  -- Square's UUID for the timecard. Primary key, so every write is an upsert
  -- on a natural key and re-running a sync can never duplicate a shift.
  square_shift_id text primary key,

  square_team_member_id text not null,
  square_location_id text not null,

  -- Square returns start/end already shifted to the location's timezone and
  -- truncated to the minute. Stored as timestamptz so range queries are exact,
  -- with the originating zone kept alongside for local-day bucketing.
  start_at timestamptz not null,
  end_at timestamptz,
  timezone text,

  -- Job/pay information recorded *on the shift*. This is deliberately a
  -- snapshot, not a lookup: a team member's current wage tells you nothing
  -- about what an eight-month-old shift actually cost.
  job_id text,
  job_title text,
  hourly_rate numeric(12, 4),
  wage_currency text,
  tip_eligible boolean,
  declared_cash_tips numeric(12, 2),

  -- OPEN means the team member has clocked in but not out, so end_at is null
  -- and the shift has no computable duration yet.
  status text,

  -- Breaks arrive as a nested list and are needed to separate paid from unpaid
  -- time, so they are kept structurally rather than flattened into a count.
  breaks jsonb not null default '[]'::jsonb,
  break_count integer not null default 0,
  unpaid_break_minutes integer not null default 0,
  paid_break_minutes integer not null default 0,

  -- Square increments `version` on every edit. Kept so an out-of-order page can
  -- be detected instead of letting a stale copy overwrite a newer one.
  version integer,

  -- Square's own audit timestamps, distinct from our synced_at. updated_at
  -- drives the incremental watermark.
  square_created_at timestamptz,
  square_updated_at timestamptz,

  -- Square hard-deletes timecards, so a deleted shift simply stops appearing in
  -- search results. Dropping it locally would silently reduce historical labor
  -- cost, so it is flagged instead and excluded by readers.
  is_deleted boolean not null default false,
  deleted_detected_at timestamptz,

  raw jsonb,
  synced_at timestamptz not null default now()
);

-- Reporting reads labor by person and by period; both are covered here.
create index if not exists square_shifts_team_member_idx
  on public.square_shifts (square_team_member_id, start_at desc);

create index if not exists square_shifts_start_at_idx
  on public.square_shifts (start_at desc);

-- The incremental sync orders by Square's updated_at to find its watermark.
create index if not exists square_shifts_updated_at_idx
  on public.square_shifts (square_updated_at desc);

-- Deletion reconciliation and every reader filter on is_deleted, and the live
-- rows are the overwhelming majority, so the index is partial.
create index if not exists square_shifts_active_idx
  on public.square_shifts (start_at desc)
  where is_deleted = false;

-- Access model copied verbatim from 012_square_rls.sql: RLS on, four permissive
-- policies scoped to `authenticated` with a `true` predicate. This is a single
-- business with one shared set of books, so there is no per-user ownership.
alter table public.square_shifts enable row level security;

drop policy if exists square_shifts_select on public.square_shifts;
create policy square_shifts_select on public.square_shifts
  for select to authenticated using (true);

drop policy if exists square_shifts_insert on public.square_shifts;
create policy square_shifts_insert on public.square_shifts
  for insert to authenticated with check (true);

drop policy if exists square_shifts_update on public.square_shifts;
create policy square_shifts_update on public.square_shifts
  for update to authenticated using (true) with check (true);

drop policy if exists square_shifts_delete on public.square_shifts;
create policy square_shifts_delete on public.square_shifts
  for delete to authenticated using (true);

-- Register the resource so the settings screen can show its sync state next to
-- orders and payments. Additive: leaves any existing row untouched.
insert into public.square_sync_state (resource, status)
values ('shifts', 'never_run')
on conflict (resource) do nothing;
