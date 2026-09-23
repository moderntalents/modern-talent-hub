-- Modern Talent Hub — coach withdrawal: atomic reservation + M-Pesa B2C payout.
-- Run after 0015_hide_payer_phone.sql. Run this file ONCE.
--
-- Financial lifecycle for an M-Pesa withdrawal:
--   available wallet -> atomic reservation + withdrawal_debit ledger row -> processing
--   -> B2C -> either: successful (debit stands, no further wallet change)
--                   or failed (exactly one withdrawal_reversal ledger row, balance restored)
--
-- The bank withdrawal method is UNTOUCHED by this migration — it keeps its existing
-- 0001 behavior exactly (manual, admin-reviewed, debited at 'successful', no ledger row).
-- Only method = 'mpesa' gets the new atomic-reservation/B2C/ledger behavior below.
--
-- Why reservation happens at insert time, not at approval time: the previous design
-- (0001) only checked the balance at insert and only ever debited it when an admin later
-- marked the row 'successful' — safe only because a human serialized every payout by
-- reviewing it first. An automated flow that calls B2C immediately has no such human
-- gate, so two withdrawal requests submitted back-to-back could each pass the "amount <=
-- balance" check (neither had debited yet) and both trigger a real payout — a genuine
-- double-spend. The fix: the same atomic, guarded UPDATE the 'successful' trigger already
-- used (`wallet_balance >= amount`, raise if not found) now runs at INSERT time for an
-- mpesa withdrawal, inside the same transaction as the insert itself. Postgres serializes
-- concurrent UPDATEs to the same teacher_profiles row, so a second concurrent request
-- correctly sees the reduced balance and fails cleanly — no separate "one withdrawal in
-- flight" constraint is needed, and a coach keeps the ability to run several withdrawals
-- at once as long as they don't collectively exceed the balance.

-- ------------------------------------------------------------
-- 0. Safety pre-check
-- ------------------------------------------------------------

do $$
begin
  if exists (select 1 from withdrawal_requests where status not in ('pending', 'processing', 'successful', 'failed', 'reversed')) then
    raise exception '0016 refused: an existing withdrawal_requests row has an unrecognised status.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. withdrawal_requests: B2C audit columns
-- ------------------------------------------------------------

alter table withdrawal_requests
  add column conversation_id text,               -- Daraja ConversationID (B2C request + result correlate on this)
  add column originator_conversation_id text,     -- Daraja OriginatorConversationID (our own request id, echoed back)
  add column result_code integer,                 -- Daraja ResultCode (0 = success)
  add column result_desc text,
  add column reserved_at timestamptz;             -- when the atomic reservation happened (mpesa only)

create unique index withdrawal_requests_conversation_id_key
  on withdrawal_requests (conversation_id)
  where conversation_id is not null;

create unique index withdrawal_requests_originator_conversation_id_key
  on withdrawal_requests (originator_conversation_id)
  where originator_conversation_id is not null;

-- ------------------------------------------------------------
-- 2. Atomic reservation at insert time (mpesa only)
-- ------------------------------------------------------------

-- Replaces check_withdrawal_amount() (same name — 0001's BEFORE INSERT trigger already
-- points at it, so this upgrades that trigger's behavior without redefining the trigger).
-- bank: unchanged — only validates, does not reserve, leaves status as inserted ('pending').
-- mpesa: looks up the coach's OWN registered number (never trusts new.destination — a
-- client-supplied destination is silently overridden), atomically reserves the amount
-- from the wallet, writes the withdrawal_debit ledger row, and marks the row 'processing'
-- — all inside the same INSERT, so a failure at any step rolls back the whole insert and
-- no withdrawal_requests row is left behind.
create or replace function check_withdrawal_amount()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_mpesa_number text;
  v_balance numeric(12,2);
begin
  if new.method = 'bank' then
    select wallet_balance into v_balance from teacher_profiles where profile_id = new.teacher_id;
    if v_balance is null or new.amount > v_balance then
      raise exception 'Withdrawal amount exceeds available wallet balance';
    end if;
    return new;
  end if;

  -- method = 'mpesa': the payout destination is always the coach's OWN registered
  -- number — never whatever the client sent as `destination`.
  select mpesa_number into v_mpesa_number from teacher_profiles where profile_id = new.teacher_id;
  if v_mpesa_number is null or v_mpesa_number = '' then
    raise exception 'No M-Pesa number is registered for this coach.';
  end if;
  new.destination := v_mpesa_number;

  -- The atomic reservation: same guarded-UPDATE pattern as the existing 'successful'
  -- debit (below), just moved to happen now instead of later. The wallet_ledger row
  -- itself can't be written here — withdrawal_ledger.withdrawal_request_id has a
  -- foreign key to withdrawal_requests(id), and this row doesn't exist yet inside its
  -- own BEFORE INSERT trigger — so trg_withdrawal_reservation_ledger (AFTER INSERT,
  -- below) writes it once the row is real. Between the two, the reservation itself is
  -- already final and atomic: if this UPDATE doesn't find a large enough balance, the
  -- whole INSERT raises and rolls back before any row (or ledger entry) exists.
  update teacher_profiles
    set wallet_balance = wallet_balance - new.amount
    where profile_id = new.teacher_id and wallet_balance >= new.amount;
  if not found then
    raise exception 'Withdrawal amount exceeds available wallet balance';
  end if;

  new.status := 'processing';
  new.reserved_at := now();
  return new;
end;
$$;

-- (trg_check_withdrawal_amount already exists from 0001 and now runs the function above.)

-- Writes the withdrawal_debit ledger row once the withdrawal_requests row genuinely
-- exists (AFTER INSERT). Only for a reservation that actually happened: new.reserved_at
-- being set is exactly the marker check_withdrawal_amount() left behind above.
create or replace function write_withdrawal_reservation_ledger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric(12,2);
begin
  if new.method = 'mpesa' and new.reserved_at is not null then
    select wallet_balance into v_balance from teacher_profiles where profile_id = new.teacher_id;
    insert into wallet_ledger (account_type, teacher_id, entry_type, amount, balance_after, withdrawal_request_id)
    values ('teacher', new.teacher_id, 'withdrawal_debit', -new.amount, v_balance, new.id);
  end if;
  return new;
end;
$$;

create trigger trg_withdrawal_reservation_ledger
  after insert on withdrawal_requests
  for each row execute function write_withdrawal_reservation_ledger();

-- ------------------------------------------------------------
-- 3. The withdrawal state machine (mirrors 0013's payment_state_machine)
-- ------------------------------------------------------------

-- Replaces handle_withdrawal_status_change() (same name — 0001's BEFORE UPDATE trigger
-- already points at it). Enforces legal transitions and makes every terminal state
-- (failed, reversed, and successful except for one further legal move) immutable except
-- for a harmless identical-value replay — exactly what makes a duplicate B2C callback
-- idempotent: the second delivery either changes nothing (accepted as a no-op) or tries
-- to change something (rejected outright). Mirrors exactly how 0013's
-- payment_state_machine() treats its own semi-terminal 'expired' state (fully immutable
-- except for one specific onward transition), applied here to 'successful' -> 'reversed'
-- (an admin claw-back).
create or replace function handle_withdrawal_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- failed and reversed are fully terminal. Re-sending the very same values is a
  -- harmless no-op (a replayed callback); anything that would actually change it is
  -- refused.
  if old.status in ('failed', 'reversed') then
    if new is distinct from old then
      raise exception 'A % withdrawal is final and cannot be changed (attempted: % -> %).', old.status, old.status, new.status;
    end if;
    return new;
  end if;

  -- successful is terminal too, except for the one legal admin claw-back move below.
  if old.status = 'successful' and new.status is distinct from 'reversed' then
    if new is distinct from old then
      raise exception 'A successful withdrawal is final and cannot be changed (attempted: successful -> %).', new.status;
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
      -- bank: manual admin review — unchanged from 0001, which let an admin mark a
      -- pending request 'processing', 'successful' or 'failed' directly, in any order
      -- they chose ('processing' was always informational, never mandatory).
      (old.status = 'pending' and new.status in ('processing', 'successful', 'failed'))
      or (old.status = 'processing' and new.status in ('successful', 'failed'))      -- both methods
      or (old.status = 'successful' and new.status = 'reversed')                     -- admin claw-back, either method
    ) then
      raise exception 'Illegal withdrawal status change: % -> %.', old.status, new.status;
    end if;
  end if;

  if new.status = 'successful' and old.status is distinct from 'successful' then
    new.processed_at := now();
    if new.method = 'bank' then
      -- Unchanged from 0001: bank debits here, at approval, because it was never reserved.
      update teacher_profiles
        set wallet_balance = wallet_balance - new.amount
        where profile_id = new.teacher_id and wallet_balance >= new.amount;
      if not found then
        raise exception 'Insufficient wallet balance for withdrawal %', new.id;
      end if;
    end if;
    -- mpesa: nothing to debit — the amount was already reserved when this row was
    -- created (see check_withdrawal_amount above). No second ledger entry, ever.

  elsif new.status = 'failed' and old.status = 'processing' and new.method = 'mpesa' then
    -- The reservation must be released exactly once. wallet_ledger_withdrawal_key
    -- (0013) already makes a second withdrawal_reversal row for this withdrawal
    -- impossible even if this branch somehow ran twice.
    new.processed_at := now();
    update teacher_profiles
      set wallet_balance = wallet_balance + new.amount
      where profile_id = new.teacher_id;
    insert into wallet_ledger (account_type, teacher_id, entry_type, amount, balance_after, withdrawal_request_id)
    select 'teacher', new.teacher_id, 'withdrawal_reversal', new.amount, wallet_balance, new.id
    from teacher_profiles where profile_id = new.teacher_id;

  elsif new.status = 'failed' and old.status in ('pending', 'processing') then
    -- bank rejected before ever being reserved: nothing to release.
    new.processed_at := now();

  elsif new.status = 'reversed' and old.status = 'successful' then
    new.processed_at := now();
    update teacher_profiles
      set wallet_balance = wallet_balance + new.amount
      where profile_id = new.teacher_id;
    -- Ledger entry only for mpesa: bank's reversed path is intentionally left exactly
    -- as it was in 0001 (credit back, no ledger row) — bank is untouched by this phase.
    if new.method = 'mpesa' then
      insert into wallet_ledger (account_type, teacher_id, entry_type, amount, balance_after, withdrawal_request_id)
      select 'teacher', new.teacher_id, 'withdrawal_reversal', new.amount, wallet_balance, new.id
      from teacher_profiles where profile_id = new.teacher_id;
    end if;
  end if;

  return new;
end;
$$;

-- (trg_withdrawal_status_change already exists from 0001 and now runs the function above.)

-- Allow updating conversation_id / originator_conversation_id / result_code / result_desc
-- on an in-flight ('processing') row without that counting as a "status change" — the
-- B2C route attaches these right after Daraja accepts the request, before any result is
-- known. The state-machine trigger above only restricts STATUS transitions, so this needs
-- no extra rule — a same-status update already passes through untouched.

-- ------------------------------------------------------------
-- 4. Privileges
-- ------------------------------------------------------------

revoke all on function write_withdrawal_reservation_ledger() from public, anon, authenticated;
