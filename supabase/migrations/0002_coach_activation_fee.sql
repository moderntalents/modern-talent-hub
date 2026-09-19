-- Modern Talent Hub — dynamic coach activation fee
-- Run after 0001_init.sql (SQL Editor, or `supabase db push`).
--
-- Adds:
--   1. platform_settings          admin-editable key/value config (holds the activation fee)
--   2. platform_settings_history  audit trail of every value change
--   3. coach_activation_payments  ledger of activation STK pushes (one row per attempt)
--   4. teacher_profiles.activated set only by a confirmed M-Pesa payment
--
-- The fee is NOT seeded on purpose: no price is invented for you. Until an admin
-- sets it at /admin/settings, the activation endpoint answers "fee not set" (503)
-- instead of charging a made-up amount.

-- ============================================================
-- PLATFORM SETTINGS
-- ============================================================

create table platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null,
  -- Daraja's Amount must be a whole number of shillings; M-Pesa caps a single
  -- transaction at 250,000. Enforced here so a bad value can never be stored,
  -- whichever code path (or manual SQL) writes it.
  constraint coach_activation_fee_valid check (
    key <> 'coach_activation_fee_kes'
    or (case when value::text ~ '^[0-9]{1,6}$'
             then value::text::int between 1 and 250000
             else false end)
  )
);

comment on table platform_settings is
  'Admin-editable platform configuration. Key coach_activation_fee_kes = coach activation price in whole KES.';

create table platform_settings_history (
  id bigint generated always as identity primary key,
  key text not null,
  old_value jsonb,
  new_value jsonb not null,
  changed_by uuid references profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index platform_settings_history_key_changed_at_idx
  on platform_settings_history (key, changed_at desc);

-- Stamp who/when on every write (auth.uid() is null for service-role/SQL writes).
create or replace function stamp_platform_setting()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger trg_platform_settings_stamp
  before insert or update on platform_settings
  for each row execute function stamp_platform_setting();

create or replace function log_platform_setting_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.value is distinct from old.value then
    insert into platform_settings_history (key, old_value, new_value, changed_by)
    values (
      new.key,
      case when tg_op = 'UPDATE' then old.value else null end,
      new.value,
      auth.uid()
    );
  end if;
  return new;
end;
$$;

create trigger trg_platform_settings_history
  after insert or update on platform_settings
  for each row execute function log_platform_setting_change();

alter table platform_settings enable row level security;
alter table platform_settings_history enable row level security;

-- Admin only. The server reads the fee for coaches with the service role, so
-- coaches never need (or get) direct read access to this table.
create policy "platform_settings_admin_all" on platform_settings for all
  using (is_admin()) with check (is_admin());
create policy "platform_settings_history_admin_read" on platform_settings_history for select
  using (is_admin());

-- ============================================================
-- COACH ACTIVATION STATE
-- ============================================================

alter table teacher_profiles
  add column activated boolean not null default false,
  add column activated_at timestamptz;

-- Optional: grandfather coaches who were already approved before this fee existed.
-- Left commented out — that's a business decision, not a technical one.
-- update teacher_profiles set activated = true, activated_at = now() where approved;

-- teacher_profiles has an owner "for all" RLS policy (0001), so without this a
-- coach could flip their own `activated` flag from the browser and skip the fee.
-- Only the payment system (service role / SQL) may change it.
create or replace function guard_teacher_activation_columns()
returns trigger language plpgsql as $$
begin
  if (new.activated is distinct from old.activated
      or new.activated_at is distinct from old.activated_at)
     and auth.role() in ('anon', 'authenticated') then
    raise exception 'Coach activation can only be changed by a confirmed payment.';
  end if;
  return new;
end;
$$;

create trigger trg_guard_teacher_activation
  before update on teacher_profiles
  for each row execute function guard_teacher_activation_columns();

-- ============================================================
-- ACTIVATION PAYMENTS
-- ============================================================

create table coach_activation_payments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references profiles(id) on delete cascade,
  -- The fee actually charged: a snapshot of platform_settings at request time,
  -- so later price changes never rewrite history.
  amount numeric(10,2) not null check (amount >= 1),
  currency text not null default 'KES',
  phone text not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed', 'expired')),
  checkout_request_id text,
  merchant_request_id text,
  provider_reference text,
  result_desc text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- One row per Daraja request; a retried callback can never match twice.
create unique index coach_activation_payments_checkout_key
  on coach_activation_payments (checkout_request_id)
  where checkout_request_id is not null;

-- At most one in-flight prompt per coach, and at most one successful payment
-- (a coach can't be charged for activation twice through the normal flow).
create unique index coach_activation_payments_one_pending
  on coach_activation_payments (teacher_id) where status = 'pending';
create unique index coach_activation_payments_one_completed
  on coach_activation_payments (teacher_id) where status = 'completed';

create or replace function handle_activation_completed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'completed' and (old.status is distinct from 'completed') then
    new.completed_at := now();
    update teacher_profiles
      set activated = true,
          activated_at = coalesce(activated_at, now())
      where profile_id = new.teacher_id;
  end if;
  return new;
end;
$$;

create trigger trg_activation_completed
  before update on coach_activation_payments
  for each row execute function handle_activation_completed();

alter table coach_activation_payments enable row level security;

-- Read-only for the coach and admins; every write is server-side (service role)
-- so a "completed" payment can't be forged from the browser.
create policy "activation_payments_read_own" on coach_activation_payments for select
  using (teacher_id = auth.uid() or is_admin());
