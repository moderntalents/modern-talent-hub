-- Modern Talent Hub — M-Pesa payment accounting foundation (Phase 1).
-- Run after 0010_age_and_guardian_consent.sql, and after 0012_lock_down_teacher_profiles.sql BEFORE payments
-- are ever switched on (0012 is what stops a browser from touching teacher wallets; this migration does not
-- depend on it to apply, but the payment system must not go live without it). Run this file ONCE.
--
-- What this adds — the DATABASE side only. No application code changes with it (see "Not in this migration").
--
--   1. A payment STATE MACHINE on payment_transactions, enforced in the database:
--        pending -> completed | failed | cancelled | expired | review
--        expired -> completed            (a late, verified success)
--      Nothing else. A completed payment is IMMUTABLE and can never become failed (or anything else) again.
--      A payment can only be completed with a verified result: result_code = 0, a stated way of confirming it
--      (callback or STK query) and — for a callback — the receipt number and a callback amount that equals the
--      amount we asked for. The amount and the parties of a payment can never change after it is created.
--   2. AUDIT COLUMNS on payment_transactions: expected amount, merchant request id, payer phone, result code and
--      description, callback amount and phone, paid_at, how it was confirmed, query bookkeeping, the split that
--      was applied, when it was credited, and review flags.
--   3. UNIQUENESS: checkout request id (already), receipt number, merchant request id, and only one pending
--      payment per subscription.
--   4. THE SPLIT, in one place: 70% coach / 30% platform, calculated from the expected amount in the database
--      (never from the callback, never from the browser). The two shares always add up to the amount exactly.
--   5. A PLATFORM (admin) WALLET, and an APPEND-ONLY WALLET LEDGER. When a payment completes, in ONE atomic
--      step: the coach wallet and the platform wallet are both credited and both ledger entries are written.
--      A unique key on the ledger makes a second credit for the same payment impossible.
--   6. An append-only mpesa_callbacks table, ready for callback auditing (nothing writes to it yet).
--   7. payment_transactions.subscription_id no longer CASCADES on delete: payment history cannot vanish.
--   8. A whole-shilling price rule on activities (added NOT VALID, so existing rows are checked separately).
--
-- What is deliberately UNCHANGED: the coach wallet (teacher_profiles.wallet_balance) and the whole withdrawal
-- system, the existing subscription-activation logic (copied verbatim into the new completion function), the
-- 0012 protections, Stage 2, and every browser write restriction (payment tables have no client write policies;
-- privileges are revoked as well).
--
-- Not in this migration (Phase 2): Buy Goods / Till changes, STK Query, reconciliation, the callback route, UI,
-- admin pages, withdrawal ledger entries (the ledger is shaped for them), and hiding payer phone numbers from
-- teachers (see the note on payment_transactions.phone below).
--
-- IMPORTANT compatibility note: completing a payment now REQUIRES the verified fields above. The current
-- callback route (which only sets status and receipt) will therefore be REFUSED by the database — that is
-- intended (fail closed) and is why Phase 2 rewrites the route. Payments are switched off in the meantime.

-- ------------------------------------------------------------
-- 0. Safety pre-check: refuse to run over data this migration cannot vouch for
-- ------------------------------------------------------------

do $$
begin
  if exists (select 1 from payment_transactions where status = 'completed') then
    raise exception '0013 refused: completed payments already exist. They need a ledger backfill first.';
  end if;
  if exists (select 1 from payment_transactions where amount <> trunc(amount) or amount < 1) then
    raise exception '0013 refused: existing payments have a fractional or zero amount. Review them first.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. The split — one function, one place
-- ------------------------------------------------------------

-- The coach's share, in whole percent. The platform receives the rest. Changing the split means changing this
-- function in a migration; it can never be changed from the app or a browser.
create or replace function payment_split_teacher_pct()
returns int
language sql immutable as $$ select 70 $$;

-- ------------------------------------------------------------
-- 2. payment_transactions: audit columns
-- ------------------------------------------------------------

alter table payment_transactions
  add column expected_amount integer,                 -- whole KES we asked Daraja to collect (snapshot)
  add column merchant_request_id text,                -- Daraja MerchantRequestID, verified on callback
  add column phone text,                              -- payer's number (2547… / 2541…)
  add column result_code integer,                     -- Daraja ResultCode (0 = success)
  add column result_desc text,
  add column callback_amount numeric(10,2),           -- Amount the callback reported
  add column callback_phone text,                     -- PhoneNumber the callback reported (may be masked)
  add column paid_at timestamptz,                     -- TransactionDate from Daraja
  add column confirmed_via text,                      -- 'callback' or 'query'
  add column callback_received_at timestamptz,
  add column last_queried_at timestamptz,
  add column query_attempts integer not null default 0,
  add column teacher_pct smallint,                    -- the split that was actually applied
  add column platform_pct smallint,
  add column credited_at timestamptz,                 -- when both wallets were credited
  add column needs_review boolean not null default false,
  add column phone_mismatch boolean not null default false;

-- NOTE (privacy, Phase 2): the existing read policy lets the coach read their payments' rows, and the app
-- selects "*" in three places, so `phone` / `callback_phone` would be readable by the coach once they are
-- populated. Nothing writes them yet. Phase 2 must restrict them (explicit column lists in those pages plus
-- column-level privileges) in the same release that starts storing them.

-- Existing rows (none in production; the pre-check above guarantees they are whole amounts).
update payment_transactions set expected_amount = amount::int where expected_amount is null;
alter table payment_transactions alter column expected_amount set not null;

-- Status set: adds cancelled, expired, review.
alter table payment_transactions drop constraint payment_transactions_status_check;
alter table payment_transactions add constraint payment_transactions_status_check
  check (status in ('pending', 'completed', 'failed', 'cancelled', 'expired', 'review'));

alter table payment_transactions
  -- What we ask Daraja for is a whole number of shillings, and always equals the recorded price.
  add constraint payment_transactions_expected_amount_valid check (expected_amount between 1 and 250000),
  add constraint payment_transactions_expected_amount_matches check (expected_amount = amount),
  add constraint payment_transactions_confirmed_via_valid check (confirmed_via is null or confirmed_via in ('callback', 'query')),
  add constraint payment_transactions_query_attempts_valid check (query_attempts >= 0),
  add constraint payment_transactions_split_valid check (
    (teacher_pct is null and platform_pct is null)
    or (teacher_pct between 0 and 100 and platform_pct between 0 and 100 and teacher_pct + platform_pct = 100)
  ),
  add constraint payment_transactions_phone_valid check (phone is null or phone ~ '^254[17][0-9]{8}$' or phone = 'removed'),
  -- A completed payment always carries its full verification and accounting.
  add constraint payment_transactions_completed_complete check (
    status <> 'completed' or (
      result_code = 0 and confirmed_via is not null
      and teacher_pct is not null and platform_pct is not null
      and teacher_share is not null and platform_share is not null
      and credited_at is not null and completed_at is not null and paid_at is not null
      and not needs_review
    )
  ),
  -- Nothing is credited before completion.
  add constraint payment_transactions_credit_only_when_completed check (status = 'completed' or credited_at is null),
  -- (The share columns default to 0 until completion, so this applies to completed payments only.)
  add constraint payment_transactions_shares_sum check (
    status <> 'completed' or teacher_share + platform_share = expected_amount
  );

-- ------------------------------------------------------------
-- 3. Uniqueness
-- ------------------------------------------------------------

-- (Already in 0001: payment_transactions_checkout_request_id_key — one row per Daraja request.)

-- One M-Pesa receipt can back only one payment.
create unique index payment_transactions_provider_reference_key
  on payment_transactions (provider_reference)
  where provider_reference is not null and provider_reference <> '';

create unique index payment_transactions_merchant_request_id_key
  on payment_transactions (merchant_request_id)
  where merchant_request_id is not null;

-- At most one payment prompt in flight per subscription (a double click or second tab cannot start another).
create unique index payment_transactions_one_pending_per_subscription
  on payment_transactions (subscription_id)
  where status = 'pending';

-- ------------------------------------------------------------
-- 4. Payment history can no longer disappear
-- ------------------------------------------------------------

-- Was ON DELETE CASCADE: deleting a subscription (or the activity/person behind it) silently deleted the payments.
-- WARNING for Phase 2: deleting an activity that has paid subscriptions is now refused by the database; the app
-- should show a clear message instead of the raw error.
alter table payment_transactions drop constraint payment_transactions_subscription_id_fkey;
alter table payment_transactions add constraint payment_transactions_subscription_id_fkey
  foreign key (subscription_id) references subscriptions(id) on delete restrict;

-- ------------------------------------------------------------
-- 5. Whole-shilling prices (M-Pesa collects whole shillings)
-- ------------------------------------------------------------

-- NOT VALID: existing rows are not rejected; every NEW or UPDATED row must satisfy it. Validate separately with
--   alter table activities validate constraint activities_price_whole_kes;
alter table activities add constraint activities_price_whole_kes check (price = trunc(price)) not valid;

-- ------------------------------------------------------------
-- 6. Wallets and ledger
-- ------------------------------------------------------------

-- The coach wallet stays teacher_profiles.wallet_balance (unchanged). This is the platform (admin) wallet: exactly
-- one row, ever.
create table platform_wallet (
  id boolean primary key default true check (id),
  balance numeric(14,2) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);
insert into platform_wallet (id) values (true);

create trigger trg_platform_wallet_updated_at
  before update on platform_wallet
  for each row execute function set_updated_at();

-- Append-only record of every credit and debit, for BOTH kinds of wallet. Only the completion function below
-- (and, later, the withdrawal triggers) can insert; nobody can update, delete or truncate.
create table wallet_ledger (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  account_type text not null check (account_type in ('teacher', 'platform')),
  teacher_id uuid references profiles(id) on delete restrict,
  entry_type text not null check (entry_type in ('payment_credit', 'withdrawal_debit', 'withdrawal_reversal')),
  amount numeric(12,2) not null check (amount <> 0),          -- signed: credits positive, debits negative
  balance_after numeric(14,2) not null check (balance_after >= 0),
  payment_transaction_id uuid references payment_transactions(id) on delete restrict,
  withdrawal_request_id uuid references withdrawal_requests(id) on delete restrict,
  constraint wallet_ledger_owner check ((account_type = 'teacher') = (teacher_id is not null)),
  constraint wallet_ledger_one_source check (((payment_transaction_id is not null)::int + (withdrawal_request_id is not null)::int) = 1),
  constraint wallet_ledger_entry_matches_source check (
    (entry_type = 'payment_credit' and payment_transaction_id is not null and amount > 0)
    or (entry_type = 'withdrawal_debit' and withdrawal_request_id is not null and account_type = 'teacher' and amount < 0)
    or (entry_type = 'withdrawal_reversal' and withdrawal_request_id is not null and account_type = 'teacher' and amount > 0)
  )
);

-- THE idempotency guarantee: one credit per payment per wallet. A second attempt raises, which rolls back the
-- whole completion (status change and both balances included).
create unique index wallet_ledger_payment_credit_key
  on wallet_ledger (payment_transaction_id, account_type)
  where entry_type = 'payment_credit';

-- (For the future withdrawal entries: one debit and one reversal per withdrawal.)
create unique index wallet_ledger_withdrawal_key
  on wallet_ledger (withdrawal_request_id, entry_type)
  where withdrawal_request_id is not null;

create index wallet_ledger_teacher_idx on wallet_ledger (teacher_id, created_at desc) where teacher_id is not null;

-- Append-only, enforced twice: privileges (below) and these triggers (which also stop the database owner).
create or replace function reject_append_only_change()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception '% is append-only: rows cannot be changed or removed.', tg_table_name;
end;
$$;

create trigger trg_wallet_ledger_append_only
  before update or delete on wallet_ledger
  for each row execute function reject_append_only_change();
create trigger trg_wallet_ledger_no_truncate
  before truncate on wallet_ledger
  for each statement execute function reject_append_only_change();

-- The platform wallet can never be removed, and no browser session can change its balance (same idea as 0012).
create or replace function guard_platform_wallet()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'The platform wallet cannot be removed.';
  end if;
  if auth.role() in ('anon', 'authenticated') then
    raise exception 'The platform wallet can only be changed by the payment system.';
  end if;
  return new;
end;
$$;

create trigger trg_platform_wallet_guard
  before update or delete on platform_wallet
  for each row execute function guard_platform_wallet();
create trigger trg_platform_wallet_no_truncate
  before truncate on platform_wallet
  for each statement execute function guard_platform_wallet();

-- Append-only audit of every M-Pesa callback. Nothing writes to it yet (Phase 2 wires the callback route to it).
-- Contains phone data (as delivered by Safaricom): needs a retention decision before it is populated.
-- Being append-only, a callback's story is a series of rows: 'received' first, then one outcome row that points
-- back at it through parent_id.
create table mpesa_callbacks (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  parent_id bigint references mpesa_callbacks(id) on delete restrict,
  outcome text not null check (outcome in (
    'received', 'credited', 'duplicate', 'failed_recorded', 'amount_mismatch', 'merchant_mismatch',
    'unmatched', 'query_unavailable', 'rejected'
  )),
  outcome_detail text,
  checkout_request_id text,
  merchant_request_id text,
  result_code integer,
  payload jsonb not null,
  payment_transaction_id uuid references payment_transactions(id) on delete restrict
);

create index mpesa_callbacks_checkout_idx on mpesa_callbacks (checkout_request_id);
create index mpesa_callbacks_received_idx on mpesa_callbacks (received_at desc);

create trigger trg_mpesa_callbacks_append_only
  before update or delete on mpesa_callbacks
  for each row execute function reject_append_only_change();
create trigger trg_mpesa_callbacks_no_truncate
  before truncate on mpesa_callbacks
  for each statement execute function reject_append_only_change();

-- ------------------------------------------------------------
-- 7. The payment state machine
-- ------------------------------------------------------------

-- Fires BEFORE the completion function below (triggers on one event run in name order: "trg_payment_…" sorts
-- before "trg_transaction_…"), so an illegal change is refused before any wallet is touched.
create or replace function payment_state_machine()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Who paid whom, for what, and how much, is fixed at creation — in every status.
  if new.student_id is distinct from old.student_id
     or new.teacher_id is distinct from old.teacher_id
     or new.subscription_id is distinct from old.subscription_id
     or new.amount is distinct from old.amount
     or new.expected_amount is distinct from old.expected_amount
     or new.currency is distinct from old.currency
     or new.provider is distinct from old.provider
     or new.created_at is distinct from old.created_at then
    raise exception 'A payment''s amount and parties cannot be changed after it is created.';
  end if;

  -- A completed payment is final. Re-sending the very same values is a harmless no-op (a replayed callback);
  -- anything that would change it is refused.
  if old.status = 'completed' then
    if new is distinct from old then
      raise exception 'A completed payment is immutable and cannot be changed (attempted: % -> %).', old.status, new.status;
    end if;
    return new;
  end if;

  -- Failed and cancelled are final too. (expired and review may still gain bookkeeping, below.)
  if old.status in ('failed', 'cancelled') then
    if new is distinct from old then
      raise exception 'A % payment is final and cannot be changed.', old.status;
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
      old.status = 'pending' and new.status in ('completed', 'failed', 'cancelled', 'expired', 'review')
      or old.status = 'expired' and new.status = 'completed'
    ) then
      raise exception 'Illegal payment status change: % -> %.', old.status, new.status;
    end if;
  elsif old.status = 'review' then
    -- A payment under review is frozen for everyone except a future, explicit resolution step.
    if new is distinct from old then
      raise exception 'A payment under review cannot be changed.';
    end if;
    return new;
  end if;

  if new.status = 'review' then
    new.needs_review := true;
  end if;

  -- Completing requires a VERIFIED success.
  if new.status = 'completed' then
    if new.result_code is distinct from 0 then
      raise exception 'A payment can only be completed with Daraja result code 0.';
    end if;
    if new.confirmed_via is null then
      raise exception 'A payment can only be completed once it is confirmed (callback or query).';
    end if;
    if new.needs_review then
      raise exception 'A payment flagged for review cannot be completed.';
    end if;
    if new.confirmed_via = 'callback' then
      if new.provider_reference is null or new.provider_reference = '' then
        raise exception 'A callback-confirmed payment needs its M-Pesa receipt number.';
      end if;
      if new.callback_amount is distinct from new.expected_amount::numeric then
        raise exception 'Payment amount mismatch: the callback reported % but % was expected.', new.callback_amount, new.expected_amount;
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_payment_state_machine
  before update on payment_transactions
  for each row execute function payment_state_machine();

-- Every new payment starts pending with no result, and expected_amount defaults to the recorded price (so the
-- current initiation code keeps working). A fractional or zero price is rejected by the CHECK constraints above.
create or replace function payment_before_insert()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status is distinct from 'pending' then
    raise exception 'A payment must be created as pending.';
  end if;
  if new.expected_amount is null then
    new.expected_amount := round(new.amount)::int;
  end if;
  return new;
end;
$$;

create trigger trg_payment_before_insert
  before insert on payment_transactions
  for each row execute function payment_before_insert();

-- Completed payments cannot be deleted.
create or replace function payment_no_delete_completed()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'completed' or old.status = 'review' then
    raise exception 'A % payment cannot be deleted.', old.status;
  end if;
  return old;
end;
$$;

create trigger trg_payment_no_delete_completed
  before delete on payment_transactions
  for each row execute function payment_no_delete_completed();

-- ------------------------------------------------------------
-- 8. Crediting: replaces handle_transaction_completed (same name, same trigger)
-- ------------------------------------------------------------

-- Same trigger as before (trg_transaction_completed, BEFORE UPDATE), now: 70/30 from the EXPECTED amount, both
-- wallets and both ledger rows in one atomic step, and the existing subscription activation kept exactly as it was.
-- It runs with the database owner's rights, but the 0012 guard on teacher_profiles still looks at WHO CALLED (the
-- server key), so a browser session still cannot trigger a credit: it cannot complete a payment at all.
create or replace function handle_transaction_completed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_teacher_pct int := payment_split_teacher_pct();
  v_platform_pct int := 100 - payment_split_teacher_pct();
  v_teacher_balance numeric;
  v_platform_balance numeric;
begin
  if new.status = 'completed' and (old.status is distinct from 'completed') then
    new.teacher_pct := v_teacher_pct;
    new.platform_pct := v_platform_pct;
    new.teacher_share := round(new.expected_amount * v_teacher_pct / 100.0, 2);
    new.platform_share := new.expected_amount - new.teacher_share;     -- the remainder, so the two are exact
    if new.teacher_share + new.platform_share <> new.expected_amount then
      raise exception 'Split error: % + % is not %.', new.teacher_share, new.platform_share, new.expected_amount;
    end if;
    new.completed_at := now();
    new.credited_at := now();
    new.paid_at := coalesce(new.paid_at, now());

    -- Coach wallet (unchanged column) and its ledger entry.
    update teacher_profiles
      set wallet_balance = wallet_balance + new.teacher_share
      where profile_id = new.teacher_id
      returning wallet_balance into v_teacher_balance;
    if not found then
      raise exception 'The coach''s wallet was not found, so payment % cannot be credited.', new.id;
    end if;
    insert into wallet_ledger (account_type, teacher_id, entry_type, amount, balance_after, payment_transaction_id)
    values ('teacher', new.teacher_id, 'payment_credit', new.teacher_share, v_teacher_balance, new.id);

    -- Platform wallet and its ledger entry.
    update platform_wallet set balance = balance + new.platform_share
      where id returning balance into v_platform_balance;
    if not found then
      raise exception 'The platform wallet was not found, so payment % cannot be credited.', new.id;
    end if;
    insert into wallet_ledger (account_type, teacher_id, entry_type, amount, balance_after, payment_transaction_id)
    values ('platform', null, 'payment_credit', new.platform_share, v_platform_balance, new.id);

    -- Existing subscription activation — unchanged from 0001.
    update subscriptions
      set status = 'active',
          current_period_end = case
            when (select billing from activities where id = subscriptions.activity_id) = 'month' then now() + interval '30 days'
            when (select billing from activities where id = subscriptions.activity_id) = 'week' then now() + interval '7 days'
            when (select billing from activities where id = subscriptions.activity_id) = 'day' then now() + interval '1 day'
            else null
          end
      where id = new.subscription_id;
  end if;
  return new;
end;
$$;

-- (trg_transaction_completed already exists from 0001 and now runs the function above.)

-- ------------------------------------------------------------
-- 9. Row level security, privileges and grants
-- ------------------------------------------------------------

alter table platform_wallet enable row level security;
alter table wallet_ledger enable row level security;
alter table mpesa_callbacks enable row level security;

-- The platform wallet and everything about callbacks: administrators only.
create policy "platform_wallet_admin_read" on platform_wallet for select using (is_admin());
create policy "mpesa_callbacks_admin_read" on mpesa_callbacks for select using (is_admin());
-- A coach reads their own ledger entries; administrators read all (including the platform's).
create policy "wallet_ledger_read" on wallet_ledger for select
  using ((account_type = 'teacher' and teacher_id = auth.uid()) or is_admin());

-- Browsers can read what the policies allow and nothing else. (payment_transactions keeps its existing read-only
-- policy; it never had a write policy, and the privileges are now revoked too.)
revoke all on platform_wallet, wallet_ledger, mpesa_callbacks from anon, authenticated;
grant select on platform_wallet, wallet_ledger, mpesa_callbacks to authenticated;
revoke all on payment_transactions from anon;
revoke insert, update, delete, truncate on payment_transactions from authenticated;

-- The server: read everything, write only what it must. Ledger and callback rows can be inserted only by the
-- completion function (ledger) — the server itself cannot forge, change or delete an entry.
revoke all on wallet_ledger from service_role;
grant select on wallet_ledger to service_role;
revoke update, delete, truncate on mpesa_callbacks from service_role;
revoke delete, truncate on platform_wallet from service_role;

-- Supabase also grants EXECUTE on new functions to the API roles. None of these is for browsers.
revoke all on function payment_split_teacher_pct() from public, anon, authenticated;
revoke all on function reject_append_only_change() from public, anon, authenticated;
revoke all on function guard_platform_wallet() from public, anon, authenticated;
revoke all on function payment_state_machine() from public, anon, authenticated;
revoke all on function payment_before_insert() from public, anon, authenticated;
revoke all on function payment_no_delete_completed() from public, anon, authenticated;
grant execute on function payment_split_teacher_pct() to service_role;
