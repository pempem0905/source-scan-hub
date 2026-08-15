-- PROMO durable writer v1
-- Core invariant: many producers may enqueue, but only one transactional commit path advances master state.

create extension if not exists pgcrypto;

create table if not exists public.promo_candidate_queue (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  source_worker text not null,
  source_url text,
  candidate jsonb not null,
  status text not null default 'READY' check (status in ('READY','COMMITTED','REJECTED')),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  commit_id uuid
);

create index if not exists promo_candidate_queue_status_created_idx
  on public.promo_candidate_queue(status, created_at);

create table if not exists public.promo_master_state (
  singleton boolean primary key default true check (singleton),
  batch_no integer not null,
  checkpoint text not null,
  registered_sources integer not null check (registered_sources >= 0),
  scanned_sources integer not null check (scanned_sources >= 0),
  actionable_offers integer not null check (actionable_offers >= 0),
  literal_codes integer not null check (literal_codes >= 0),
  value_filter_version text not null default 'actionable-value-v2',
  last_successful_commit timestamptz not null,
  updated_at timestamptz not null default now()
);

insert into public.promo_master_state (
  singleton,batch_no,checkpoint,registered_sources,scanned_sources,
  actionable_offers,literal_codes,last_successful_commit
)
values (
  true,48,'B48 / SRC-296',275,131,124,26,'2026-08-15T12:56:48+07:00'::timestamptz
)
on conflict (singleton) do nothing;

create table if not exists public.promo_master_commits (
  commit_id uuid primary key default gen_random_uuid(),
  batch_no integer not null unique,
  previous_batch_no integer not null,
  checkpoint text not null,
  queue_ids uuid[] not null,
  registered_delta integer not null default 0 check (registered_delta >= 0),
  scanned_delta integer not null default 0 check (scanned_delta >= 0),
  offers_delta integer not null default 0 check (offers_delta >= 0),
  codes_delta integer not null default 0 check (codes_delta >= 0),
  created_at timestamptz not null default now()
);

alter table public.promo_candidate_queue enable row level security;
alter table public.promo_master_state enable row level security;
alter table public.promo_master_commits enable row level security;

-- Explicitly keep durable writer tables private even if project default grants change later.
revoke all on table public.promo_candidate_queue from public, anon, authenticated;
revoke all on table public.promo_master_state from public, anon, authenticated;
revoke all on table public.promo_master_commits from public, anon, authenticated;
grant all on table public.promo_candidate_queue to service_role;
grant all on table public.promo_master_state to service_role;
grant all on table public.promo_master_commits to service_role;

create or replace function public.commit_promo_queue(
  p_expected_batch integer,
  p_next_batch integer,
  p_checkpoint text,
  p_queue_ids uuid[],
  p_registered_delta integer,
  p_scanned_delta integer,
  p_offers_delta integer,
  p_codes_delta integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.promo_master_state%rowtype;
  v_commit_id uuid := gen_random_uuid();
  v_ready_count integer;
begin
  if p_next_batch <> p_expected_batch + 1 then
    raise exception 'non-monotonic batch transition: expected %, got %', p_expected_batch + 1, p_next_batch;
  end if;

  if p_registered_delta < 0 or p_scanned_delta < 0 or p_offers_delta < 0 or p_codes_delta < 0 then
    raise exception 'commit deltas must be nonnegative';
  end if;

  if coalesce(array_length(p_queue_ids, 1), 0) = 0 then
    raise exception 'queue_ids must not be empty';
  end if;

  select * into v_state
  from public.promo_master_state
  where singleton = true
  for update;

  if not found then
    raise exception 'promo_master_state singleton missing';
  end if;

  if v_state.batch_no <> p_expected_batch then
    raise exception 'stale batch: current %, expected %', v_state.batch_no, p_expected_batch;
  end if;

  select count(*) into v_ready_count
  from public.promo_candidate_queue
  where id = any(p_queue_ids) and status = 'READY';

  if v_ready_count <> array_length(p_queue_ids, 1) then
    raise exception 'queue set contains missing, duplicate, or non-READY rows';
  end if;

  insert into public.promo_master_commits (
    commit_id,batch_no,previous_batch_no,checkpoint,queue_ids,
    registered_delta,scanned_delta,offers_delta,codes_delta
  ) values (
    v_commit_id,p_next_batch,p_expected_batch,p_checkpoint,p_queue_ids,
    p_registered_delta,p_scanned_delta,p_offers_delta,p_codes_delta
  );

  update public.promo_candidate_queue
  set status = 'COMMITTED', committed_at = now(), commit_id = v_commit_id
  where id = any(p_queue_ids);

  update public.promo_master_state
  set batch_no = p_next_batch,
      checkpoint = p_checkpoint,
      registered_sources = registered_sources + p_registered_delta,
      scanned_sources = scanned_sources + p_scanned_delta,
      actionable_offers = actionable_offers + p_offers_delta,
      literal_codes = literal_codes + p_codes_delta,
      last_successful_commit = now(),
      updated_at = now()
  where singleton = true;

  return v_commit_id;
end;
$$;

revoke all on function public.commit_promo_queue(integer,integer,text,uuid[],integer,integer,integer,integer) from public;
revoke all on function public.commit_promo_queue(integer,integer,text,uuid[],integer,integer,integer,integer) from anon;
revoke all on function public.commit_promo_queue(integer,integer,text,uuid[],integer,integer,integer,integer) from authenticated;
grant execute on function public.commit_promo_queue(integer,integer,text,uuid[],integer,integer,integer,integer) to service_role;

create or replace view public.promo_writer_health
with (security_invoker = true)
as
select
  s.batch_no,
  s.checkpoint,
  s.registered_sources,
  s.scanned_sources,
  s.actionable_offers,
  s.literal_codes,
  s.last_successful_commit,
  s.value_filter_version,
  (select count(*) from public.promo_candidate_queue q where q.status = 'READY') as ready_backlog,
  (select count(*) from public.promo_candidate_queue q where q.status = 'COMMITTED') as committed_rows
from public.promo_master_state s
where s.singleton = true;

revoke all on table public.promo_writer_health from public, anon, authenticated;
grant select on table public.promo_writer_health to service_role;
