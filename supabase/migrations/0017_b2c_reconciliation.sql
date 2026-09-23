-- Modern Talent Hub — B2C reconciliation safety layer (multi-attempt withdrawals).
-- Run after 0016_coach_b2c_withdrawal.sql. Run this file ONCE.
--
-- Fixes a real gap in 0016: it stored one conversation_id per withdrawal_requests row.
-- If a first B2C attempt goes ambiguous (we don't know whether Safaricom received it) and
-- an admin later authorizes a second attempt, overwriting conversation_id would make a
-- LATE callback from the first attempt unmatchable — or worse, matchable to the wrong
-- attempt. This migration makes "one withdrawal, many B2C attempts" an explicit
-- one-to-many relationship instead.
--
-- Financial invariant, UNCHANGED from 0016: the wallet is debited exactly once, at
-- reservation (withdrawal creation) — never per attempt. A withdrawal is reversed at most
-- once, when the PARENT finally, conclusively reaches 'failed' — never per attempt. No
-- function in this migration touches wallet_balance or inserts into wallet_ledger except
-- through the existing handle_withdrawal_status_change() trigger, reused, not duplicated.
--
-- Core rule that makes multi-attempt safety work: an attempt can affect its parent
-- withdrawal ONLY while its own status is still 'requested' or 'accepted'. The instant a
-- new attempt is created, every other non-terminal attempt for that withdrawal is
-- atomically marked 'superseded' in the same transaction — so a late callback for an old
-- attempt can still update ITS OWN row (for audit) but structurally cannot reach the
-- wallet or the parent's status once superseded.

-- ------------------------------------------------------------
-- 0. Safety pre-check
-- ------------------------------------------------------------

do $$
begin
  if exists (select 1 from withdrawal_requests where status = 'review') then
    raise exception '0017 refused: a withdrawal already has status ''review'', which does not exist before this migration.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. withdrawal_requests: the 'review' state and reconciliation bookkeeping
-- ------------------------------------------------------------

alter table withdrawal_requests drop constraint withdrawal_requests_status_check;
alter table withdrawal_requests add constraint withdrawal_requests_status_check
  check (status in ('pending', 'processing', 'review', 'successful', 'failed', 'reversed'));

alter table withdrawal_requests
  -- Set when a late/contradicting result arrives for an already-superseded attempt (e.g.
  -- it also reports success after a different attempt already finalized the withdrawal).
  -- The wallet ledger can never be wrong when this happens (it only ever reflects the one
  -- attempt that was actually authoritative) — but Safaricom may have sent real money
  -- twice, which software cannot undo. This is the loud, permanent flag for a human.
  add column needs_urgent_review boolean not null default false,
  -- Lease pair for the reconciliation sweep (below), so two sweep runs can't both grab
  -- the same stale row.
  add column reconciliation_claimed_at timestamptz,
  add column reconciliation_claimed_by uuid references profiles(id) on delete set null;

-- ------------------------------------------------------------
-- 2. withdrawal_b2c_attempts: one row per B2C request ever made for a withdrawal
-- ------------------------------------------------------------

create table withdrawal_b2c_attempts (
  id uuid primary key default gen_random_uuid(),
  withdrawal_request_id uuid not null references withdrawal_requests(id) on delete restrict,
  attempt_number int not null check (attempt_number >= 1),
  -- 'requested': we're about to call / have called Daraja and are waiting on its
  --   synchronous response. 'accepted': Daraja's synchronous response confirmed receipt
  --   (conversation_id is set). Both are "live" — see the partial unique index below.
  -- 'succeeded' / 'failed': this attempt was the one that resolved the withdrawal.
  -- 'ambiguous': we could not confirm Daraja even received the request (e.g. a network
  --   timeout calling paymentrequest) — distinct from 'failed', which means Daraja
  --   itself gave a definite rejection.
  -- 'superseded': a later attempt exists for the same withdrawal; this one can no longer
  --   affect the parent, no matter what result later arrives for it.
  status text not null default 'requested'
    check (status in ('requested', 'accepted', 'succeeded', 'failed', 'ambiguous', 'superseded')),
  conversation_id text,
  originator_conversation_id text,
  requested_at timestamptz not null default now(),
  accepted_at timestamptz,
  resolved_at timestamptz,
  provider_reference text,          -- TransactionReceipt from a success callback
  transaction_id text,              -- Daraja's top-level Result.TransactionID — not assumed
                                     -- identical to provider_reference; both are stored
  result_code integer,
  result_desc text,
  raw_response jsonb,               -- the callback payload (or initiation error), for audit
  created_at timestamptz not null default now()
);

create index withdrawal_b2c_attempts_withdrawal_idx on withdrawal_b2c_attempts (withdrawal_request_id, attempt_number);

-- A callback maps to exactly one attempt, ever, across every withdrawal — this is the
-- fix for 0016's flaw: the identifier lives on the attempt, permanently, never overwritten.
create unique index withdrawal_b2c_attempts_conversation_id_key
  on withdrawal_b2c_attempts (conversation_id) where conversation_id is not null;
create unique index withdrawal_b2c_attempts_originator_conversation_id_key
  on withdrawal_b2c_attempts (originator_conversation_id) where originator_conversation_id is not null;

create unique index withdrawal_b2c_attempts_number_key
  on withdrawal_b2c_attempts (withdrawal_request_id, attempt_number);

-- AT MOST ONE live (non-terminal, non-superseded) attempt per withdrawal at any moment.
-- This is what stops two concurrent retry authorizations from both creating a second
-- in-flight attempt — the second insert simply violates this index and rolls back.
create unique index withdrawal_b2c_attempts_one_live_key
  on withdrawal_b2c_attempts (withdrawal_request_id) where status in ('requested', 'accepted');

alter table withdrawal_b2c_attempts enable row level security;
create policy "withdrawal_b2c_attempts_admin_read" on withdrawal_b2c_attempts for select using (is_admin());
-- (No client write policy at all — every write goes through the SECURITY DEFINER
-- functions below, called with the service role.)
revoke all on withdrawal_b2c_attempts from anon, authenticated;
grant select on withdrawal_b2c_attempts to authenticated;

-- ------------------------------------------------------------
-- 3. withdrawal_reconciliation_log: append-only audit of every reconciliation decision
-- ------------------------------------------------------------

create table withdrawal_reconciliation_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  withdrawal_request_id uuid not null references withdrawal_requests(id) on delete restrict,
  attempt_id uuid references withdrawal_b2c_attempts(id) on delete restrict,
  event_type text not null check (event_type in (
    'attempt_created', 'attempt_resolved', 'attempt_superseded_late_result',
    'swept_to_review', 'retry_authorized', 'admin_resolved', 'urgent_review_flagged'
  )),
  actor uuid references profiles(id) on delete set null,  -- null for a service/system action
  reason text,                                             -- required for retry_authorized / admin_resolved
  detail jsonb
);

create index withdrawal_reconciliation_log_withdrawal_idx on withdrawal_reconciliation_log (withdrawal_request_id, created_at);

alter table withdrawal_reconciliation_log enable row level security;
create policy "withdrawal_reconciliation_log_admin_read" on withdrawal_reconciliation_log for select using (is_admin());
revoke all on withdrawal_reconciliation_log from anon, authenticated;
grant select on withdrawal_reconciliation_log to authenticated;

create or replace function log_withdrawal_reconciliation_event(
  p_withdrawal_id uuid, p_attempt_id uuid, p_event_type text, p_actor uuid, p_reason text, p_detail jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into withdrawal_reconciliation_log (withdrawal_request_id, attempt_id, event_type, actor, reason, detail)
  values (p_withdrawal_id, p_attempt_id, p_event_type, p_actor, p_reason, p_detail);
end;
$$;

-- ------------------------------------------------------------
-- 4. State machine: add review, and the transitions around it
-- ------------------------------------------------------------

-- Replaces handle_withdrawal_status_change() (same name — 0001/0016's trigger already
-- points at it). Adds: processing -> review (stale/ambiguous), review -> processing
-- (admin-authorized retry — no wallet effect, the reservation is untouched), and
-- review -> successful/failed (a late callback for the attempt that was still active
-- when review was entered, or a direct admin override). Everything else is exactly as
-- 0016 left it.
create or replace function handle_withdrawal_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- needs_urgent_review / reconciliation_claimed_at / reconciliation_claimed_by are
  -- bookkeeping-only flags (0017), never financial state — they must stay settable even
  -- on a terminal row: a late, contradicting callback for a superseded/ambiguous attempt
  -- can arrive AFTER the parent has already finalized (see resolve_b2c_attempt), and that
  -- is exactly when a human most needs to be flagged. Excluding just these three columns
  -- from the immutability check (rather than comparing the whole row) keeps every
  -- financial/status field permanently frozen once terminal, while letting the flag through.
  if old.status in ('failed', 'reversed') then
    if (to_jsonb(new) - 'needs_urgent_review' - 'reconciliation_claimed_at' - 'reconciliation_claimed_by')
       is distinct from
       (to_jsonb(old) - 'needs_urgent_review' - 'reconciliation_claimed_at' - 'reconciliation_claimed_by') then
      raise exception 'A % withdrawal is final and cannot be changed (attempted: % -> %).', old.status, old.status, new.status;
    end if;
    return new;
  end if;

  if old.status = 'successful' and new.status is distinct from 'reversed' then
    if (to_jsonb(new) - 'needs_urgent_review' - 'reconciliation_claimed_at' - 'reconciliation_claimed_by')
       is distinct from
       (to_jsonb(old) - 'needs_urgent_review' - 'reconciliation_claimed_at' - 'reconciliation_claimed_by') then
      raise exception 'A successful withdrawal is final and cannot be changed (attempted: successful -> %).', new.status;
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending' and new.status in ('processing', 'successful', 'failed'))
      or (old.status = 'processing' and new.status in ('successful', 'failed', 'review'))
      or (old.status = 'review' and new.status in ('processing', 'successful', 'failed'))
      or (old.status = 'successful' and new.status = 'reversed')
    ) then
      raise exception 'Illegal withdrawal status change: % -> %.', old.status, new.status;
    end if;
  end if;

  if new.status = 'successful' and old.status is distinct from 'successful' then
    new.processed_at := now();
    if new.method = 'bank' then
      update teacher_profiles
        set wallet_balance = wallet_balance - new.amount
        where profile_id = new.teacher_id and wallet_balance >= new.amount;
      if not found then
        raise exception 'Insufficient wallet balance for withdrawal %', new.id;
      end if;
    end if;

  elsif new.status = 'failed' and old.status in ('processing', 'review') and new.method = 'mpesa' then
    new.processed_at := now();
    update teacher_profiles
      set wallet_balance = wallet_balance + new.amount
      where profile_id = new.teacher_id;
    insert into wallet_ledger (account_type, teacher_id, entry_type, amount, balance_after, withdrawal_request_id)
    select 'teacher', new.teacher_id, 'withdrawal_reversal', new.amount, wallet_balance, new.id
    from teacher_profiles where profile_id = new.teacher_id;

  elsif new.status = 'failed' and old.status = 'pending' then
    new.processed_at := now();

  elsif new.status = 'reversed' and old.status = 'successful' then
    new.processed_at := now();
    update teacher_profiles
      set wallet_balance = wallet_balance + new.amount
      where profile_id = new.teacher_id;
    if new.method = 'mpesa' then
      insert into wallet_ledger (account_type, teacher_id, entry_type, amount, balance_after, withdrawal_request_id)
      select 'teacher', new.teacher_id, 'withdrawal_reversal', new.amount, wallet_balance, new.id
      from teacher_profiles where profile_id = new.teacher_id;
    end if;
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------
-- 5. create_b2c_attempt: atomically start a new attempt, superseding any live one
-- ------------------------------------------------------------

-- Locks the PARENT withdrawal row first (this is the concurrency backbone: every
-- function in this migration that can affect a withdrawal's attempts locks the parent
-- row before doing anything, so Postgres's own row-lock queueing serializes them —
-- see resolve_b2c_attempt below for the other half of this). Requires the withdrawal to
-- currently be 'processing' — for attempt 1 this is true immediately after reservation;
-- for a retry, the caller flips 'review' -> 'processing' in the SAME transaction as this
-- call (see authorize_b2c_retry).
create or replace function create_b2c_attempt(p_withdrawal_id uuid)
returns withdrawal_b2c_attempts
language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_next_number int;
  v_attempt withdrawal_b2c_attempts;
begin
  select status into v_status from withdrawal_requests where id = p_withdrawal_id for update;
  if not found then
    raise exception 'Withdrawal % not found.', p_withdrawal_id;
  end if;
  if v_status <> 'processing' then
    raise exception 'Cannot start a B2C attempt for withdrawal % in status %.', p_withdrawal_id, v_status;
  end if;

  -- Supersede any attempt still live — normally none for attempt 1; for a retry, this is
  -- exactly what makes the previous attempt's late callback harmless (its status is no
  -- longer 'requested'/'accepted', so resolve_b2c_attempt below will only ever record
  -- its result for audit, never touch the wallet or the parent again).
  update withdrawal_b2c_attempts
    set status = 'superseded'
    where withdrawal_request_id = p_withdrawal_id and status in ('requested', 'accepted');

  select coalesce(max(attempt_number), 0) + 1 into v_next_number
    from withdrawal_b2c_attempts where withdrawal_request_id = p_withdrawal_id;

  insert into withdrawal_b2c_attempts (withdrawal_request_id, attempt_number, status)
    values (p_withdrawal_id, v_next_number, 'requested')
    returning * into v_attempt;

  perform log_withdrawal_reconciliation_event(p_withdrawal_id, v_attempt.id, 'attempt_created', null, null,
    jsonb_build_object('attempt_number', v_next_number));

  return v_attempt;
end;
$$;

-- ------------------------------------------------------------
-- 6. resolve_b2c_attempt: apply a B2C result to the attempt (and, only if it's still
--    the live one, to the parent withdrawal)
-- ------------------------------------------------------------

-- p_result_code null means "Daraja accepted the request but we don't yet have a final
-- result" — used to record accepted_at/conversation_id right after initiation, without
-- resolving anything.
create or replace function resolve_b2c_attempt(
  p_attempt_id uuid,
  p_conversation_id text,
  p_originator_conversation_id text,
  p_result_code int,
  p_result_desc text,
  p_provider_reference text,
  p_transaction_id text,
  p_raw_response jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_attempt withdrawal_b2c_attempts;
  v_withdrawal_id uuid;
  v_withdrawal_status text;
  v_method text;
begin
  select withdrawal_request_id into v_withdrawal_id from withdrawal_b2c_attempts where id = p_attempt_id;
  if not found then
    raise exception 'B2C attempt % not found.', p_attempt_id;
  end if;

  -- Lock the PARENT first — the other half of the concurrency guarantee described in
  -- create_b2c_attempt above. Whichever of {this function, create_b2c_attempt} gets
  -- here first for a given withdrawal completes entirely before the other proceeds.
  select status, method into v_withdrawal_status, v_method from withdrawal_requests where id = v_withdrawal_id for update;

  -- Re-read the attempt AFTER acquiring the lock: if a concurrent retry authorization
  -- won the race, it already marked this attempt 'superseded' before we got here.
  select * into v_attempt from withdrawal_b2c_attempts where id = p_attempt_id;

  if v_attempt.conversation_id is null and p_conversation_id is not null then
    update withdrawal_b2c_attempts set conversation_id = p_conversation_id where id = p_attempt_id;
  end if;
  if v_attempt.originator_conversation_id is null and p_originator_conversation_id is not null then
    update withdrawal_b2c_attempts set originator_conversation_id = p_originator_conversation_id where id = p_attempt_id;
  end if;

  -- p_result_code null: this call is only attaching identifiers right after Daraja's
  -- synchronous accept (no result yet) — mark 'accepted' if still live, change nothing else.
  if p_result_code is null then
    if v_attempt.status = 'requested' then
      update withdrawal_b2c_attempts set status = 'accepted', accepted_at = now() where id = p_attempt_id;
      return 'accepted';
    end if;
    return 'no_op';
  end if;

  if v_attempt.status not in ('requested', 'accepted') then
    -- Not the live attempt (already superseded, or already resolved by a duplicate
    -- delivery of this same callback) — record the result for audit only.
    update withdrawal_b2c_attempts
      set result_code = p_result_code, result_desc = p_result_desc,
          provider_reference = coalesce(provider_reference, p_provider_reference),
          transaction_id = coalesce(transaction_id, p_transaction_id),
          raw_response = p_raw_response, resolved_at = coalesce(resolved_at, now())
      where id = p_attempt_id;

    if p_result_code = 0 and v_attempt.status <> 'succeeded' then
      -- A non-live attempt claiming success, when it wasn't already known to have
      -- succeeded, is exactly the dangerous contradiction — whether it was 'superseded'
      -- (a later attempt may also complete), 'ambiguous' (we assumed the worst and may
      -- have since resolved this withdrawal another way), or even 'failed' (a late
      -- success reversing an earlier recorded failure). Software cannot know whether
      -- Safaricom actually paid out twice, or paid out after being told it hadn't. Flag
      -- loudly rather than silently discarding it.
      update withdrawal_requests set needs_urgent_review = true where id = v_withdrawal_id;
      perform log_withdrawal_reconciliation_event(v_withdrawal_id, p_attempt_id, 'urgent_review_flagged', null,
        format('A non-live B2C attempt (previously %s) reported success — this withdrawal may have already been resolved another way.', v_attempt.status),
        p_raw_response);
    else
      perform log_withdrawal_reconciliation_event(v_withdrawal_id, p_attempt_id, 'attempt_superseded_late_result', null, null, p_raw_response);
    end if;
    return 'superseded_recorded';
  end if;

  -- This IS the live attempt. Resolve it, and only it can move the parent. The parent's
  -- own conversation_id/provider_reference/result_code/result_desc columns (from 0016)
  -- are kept in sync with the resolving attempt too — the admin/teacher UI (e.g.
  -- app/admin/withdrawals/page.tsx) reads provider_reference straight off
  -- withdrawal_requests, same as it does for bank withdrawals, and shouldn't need to know
  -- about the attempts table to show a receipt.
  if p_result_code = 0 then
    update withdrawal_b2c_attempts
      set status = 'succeeded', result_code = 0, result_desc = p_result_desc,
          provider_reference = p_provider_reference, transaction_id = p_transaction_id,
          raw_response = p_raw_response, resolved_at = now()
      where id = p_attempt_id;
    update withdrawal_requests
      set status = 'successful', conversation_id = coalesce(v_attempt.conversation_id, p_conversation_id),
          originator_conversation_id = coalesce(v_attempt.originator_conversation_id, p_originator_conversation_id),
          provider_reference = p_provider_reference, result_code = 0, result_desc = p_result_desc
      where id = v_withdrawal_id;
  else
    update withdrawal_b2c_attempts
      set status = 'failed', result_code = p_result_code, result_desc = p_result_desc,
          raw_response = p_raw_response, resolved_at = now()
      where id = p_attempt_id;
    update withdrawal_requests
      set status = 'failed', conversation_id = coalesce(v_attempt.conversation_id, p_conversation_id),
          originator_conversation_id = coalesce(v_attempt.originator_conversation_id, p_originator_conversation_id),
          result_code = p_result_code, result_desc = p_result_desc
      where id = v_withdrawal_id;
  end if;

  perform log_withdrawal_reconciliation_event(v_withdrawal_id, p_attempt_id, 'attempt_resolved', null, null,
    jsonb_build_object('result_code', p_result_code));

  return case when p_result_code = 0 then 'resolved_successful' else 'resolved_failed' end;
end;
$$;

-- ------------------------------------------------------------
-- 7. mark_attempt_ambiguous: attempt 1 (or a retry) failed to even get a confirmed
--    response from Daraja — record it, but do NOT touch the parent (we don't know
--    whether Daraja received it). The parent stays 'processing'; the reconciliation
--    sweep (application-side, see lib/mpesa-withdrawals.ts) will later move it to 'review'.
-- ------------------------------------------------------------

create or replace function mark_attempt_ambiguous(p_attempt_id uuid, p_detail text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_withdrawal_id uuid;
begin
  select withdrawal_request_id into v_withdrawal_id from withdrawal_b2c_attempts where id = p_attempt_id;
  update withdrawal_b2c_attempts
    set status = 'ambiguous', result_desc = p_detail, resolved_at = now()
    where id = p_attempt_id and status in ('requested', 'accepted');
  perform log_withdrawal_reconciliation_event(v_withdrawal_id, p_attempt_id, 'attempt_resolved', null,
    'B2C request could not be confirmed (network/timeout) — withdrawal left processing pending reconciliation.', null);
end;
$$;

-- ------------------------------------------------------------
-- 8. authorize_b2c_retry: admin-only, requires 'review', requires a reason
-- ------------------------------------------------------------

create or replace function authorize_b2c_retry(p_withdrawal_id uuid, p_admin_id uuid, p_reason text)
returns withdrawal_b2c_attempts
language plpgsql security definer set search_path = public as $$
declare
  v_attempt withdrawal_b2c_attempts;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'A written justification (at least 10 characters) is required to authorize a B2C retry.';
  end if;

  update withdrawal_requests set status = 'processing' where id = p_withdrawal_id and status = 'review';
  if not found then
    raise exception 'Withdrawal % is not in review — cannot authorize a retry.', p_withdrawal_id;
  end if;

  v_attempt := create_b2c_attempt(p_withdrawal_id);

  perform log_withdrawal_reconciliation_event(p_withdrawal_id, v_attempt.id, 'retry_authorized', p_admin_id, p_reason, null);

  return v_attempt;
end;
$$;

-- ------------------------------------------------------------
-- 9. admin_resolve_withdrawal: a direct admin override with no new B2C attempt —
--    e.g. the admin confirmed via Safaricom's own records that a prior attempt did (or
--    did not) actually pay, without needing to send anything new.
-- ------------------------------------------------------------

create or replace function admin_resolve_withdrawal(
  p_withdrawal_id uuid, p_outcome text, p_admin_id uuid, p_reason text, p_provider_reference text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_live_attempt_id uuid;
begin
  if p_outcome not in ('successful', 'failed') then
    raise exception 'admin_resolve_withdrawal outcome must be ''successful'' or ''failed''.';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'A written justification (at least 10 characters) is required to resolve a withdrawal manually.';
  end if;

  -- Prefer a still-live attempt, but an 'ambiguous' one (the common real-world case — a
  -- timeout is exactly when an admin needs to step in) is also the "current" attempt as
  -- far as this withdrawal is concerned, and should be closed out with the admin's
  -- determination too, not left permanently unresolved in its own record.
  select id into v_live_attempt_id from withdrawal_b2c_attempts
    where withdrawal_request_id = p_withdrawal_id and status in ('requested', 'accepted', 'ambiguous')
    order by attempt_number desc limit 1;

  if v_live_attempt_id is not null then
    update withdrawal_b2c_attempts
      set status = (case when p_outcome = 'successful' then 'succeeded' else 'failed' end),
          provider_reference = coalesce(provider_reference, p_provider_reference),
          resolved_at = now(), result_desc = 'Resolved manually by admin: ' || p_reason
      where id = v_live_attempt_id;
  end if;

  update withdrawal_requests set status = p_outcome,
    provider_reference = coalesce(provider_reference, p_provider_reference)
    where id = p_withdrawal_id and status = 'review';
  if not found then
    raise exception 'Withdrawal % is not in review — cannot resolve manually.', p_withdrawal_id;
  end if;

  perform log_withdrawal_reconciliation_event(p_withdrawal_id, v_live_attempt_id, 'admin_resolved', p_admin_id, p_reason,
    jsonb_build_object('outcome', p_outcome));
end;
$$;

-- ------------------------------------------------------------
-- 10. sweep claim: one guarded UPDATE, called repeatedly by the application with a list
--     of candidate ids (found via a plain SELECT, no function needed for that part —
--     the concurrency-critical piece is this claim, not the candidate search).
-- ------------------------------------------------------------

create or replace function claim_withdrawal_for_reconciliation(p_withdrawal_id uuid, p_actor uuid, p_lease_minutes int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update withdrawal_requests
    set reconciliation_claimed_at = now(), reconciliation_claimed_by = p_actor
    where id = p_withdrawal_id
      and status = 'processing'
      and (reconciliation_claimed_at is null or reconciliation_claimed_at < now() - make_interval(mins => p_lease_minutes));
  return found;
end;
$$;

create or replace function sweep_withdrawal_to_review(p_withdrawal_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_live_attempt_id uuid;
begin
  update withdrawal_requests set status = 'review' where id = p_withdrawal_id and status = 'processing';
  if not found then
    return false;
  end if;

  select id into v_live_attempt_id from withdrawal_b2c_attempts
    where withdrawal_request_id = p_withdrawal_id and status in ('requested', 'accepted');

  perform log_withdrawal_reconciliation_event(p_withdrawal_id, v_live_attempt_id, 'swept_to_review', null, p_reason, null);
  return true;
end;
$$;

-- ------------------------------------------------------------
-- 11. Privileges
-- ------------------------------------------------------------

revoke all on function log_withdrawal_reconciliation_event(uuid, uuid, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function create_b2c_attempt(uuid) from public, anon, authenticated;
revoke all on function resolve_b2c_attempt(uuid, text, text, int, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function mark_attempt_ambiguous(uuid, text) from public, anon, authenticated;
revoke all on function authorize_b2c_retry(uuid, uuid, text) from public, anon, authenticated;
revoke all on function admin_resolve_withdrawal(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function claim_withdrawal_for_reconciliation(uuid, uuid, int) from public, anon, authenticated;
revoke all on function sweep_withdrawal_to_review(uuid, text) from public, anon, authenticated;
