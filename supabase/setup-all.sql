-- ============================================================================
-- Modern Talent Hub — ONE-SHOT DATABASE SETUP
--
-- Paste this whole file into the Supabase SQL Editor (the project whose URL is
-- NEXT_PUBLIC_SUPABASE_URL in Vercel) and click Run ONCE, on an EMPTY database.
-- It is the concatenation of, in order:
--   migrations/0001_init.sql, seed.sql, 0002 ... 0011, 0014
-- (0012 and 0013 belong to the separate M-Pesa payment work and are not included here.)
-- (the individual files remain the source of truth — regenerate this file if
-- they change). Running it twice will error on "already exists"; that's safe,
-- just don't re-run it. Already set up? Run only the newest migration files.
-- ============================================================================


-- ############################################################################
-- ## migrations/0001_init.sql
-- ############################################################################

-- Modern Talent Hub — production schema
-- Run this against a Supabase Postgres project (SQL Editor, or `supabase db push`).
-- Assumes Supabase Auth (auth.users) is enabled.

create extension if not exists "pgcrypto";

-- ============================================================
-- ROLES & PROFILES
-- ============================================================

create type user_role as enum ('student', 'teacher', 'admin');

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'student',
  full_name text not null,
  phone text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table student_profiles (
  profile_id uuid primary key references profiles(id) on delete cascade,
  grade text,
  school_name text,
  parent_phone text
);

create table teacher_profiles (
  profile_id uuid primary key references profiles(id) on delete cascade,
  bio text,
  specialty text,
  approved boolean not null default false,
  payout_method text not null default 'mpesa' check (payout_method in ('mpesa', 'bank')),
  mpesa_number text,
  bank_name text,
  bank_account text,
  wallet_balance numeric(12,2) not null default 0 check (wallet_balance >= 0)
);

-- Keep profiles.updated_at fresh
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- Auto-create a profile row when a new auth user signs up.
-- Expects role/full_name to be passed in auth.users.raw_user_meta_data at signup.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role user_role;
begin
  v_role := coalesce((new.raw_user_meta_data->>'role')::user_role, 'student');

  insert into profiles (id, role, full_name, phone)
  values (
    new.id,
    v_role,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'phone'
  );

  if v_role = 'student' then
    insert into student_profiles (profile_id, grade, school_name, parent_phone)
    values (new.id, new.raw_user_meta_data->>'grade', new.raw_user_meta_data->>'school_name', new.raw_user_meta_data->>'parent_phone');
  elsif v_role = 'teacher' then
    insert into teacher_profiles (profile_id, bio, specialty, mpesa_number)
    values (new.id, new.raw_user_meta_data->>'bio', new.raw_user_meta_data->>'specialty', new.raw_user_meta_data->>'phone');
  end if;

  return new;
end;
$$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- CBC SUBJECTS & LESSONS
-- ============================================================

create table subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  color text not null default 'cyan',
  order_index int not null default 0
);

create table lessons (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  teacher_id uuid references profiles(id) on delete set null,
  title text not null,
  description text,
  video_url text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  order_index int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_lessons_updated_at
  before update on lessons
  for each row execute function set_updated_at();

create table lesson_materials (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  file_type text,
  file_size bigint,
  uploaded_at timestamptz not null default now()
);

create table assignments (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  title text not null,
  instructions text,
  due_date timestamptz,
  max_score int not null default 100,
  created_at timestamptz not null default now()
);

create table assignment_submissions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references assignments(id) on delete cascade,
  student_id uuid not null references profiles(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  submitted_at timestamptz not null default now(),
  grade numeric,
  feedback text,
  graded_at timestamptz,
  unique (assignment_id, student_id)
);

-- ============================================================
-- CO-CURRICULAR MARKETPLACE (Sports / Martial Arts / Performing Arts & Music / Creative Tech & Mind Games)
-- ============================================================

create type activity_category as enum ('sports', 'martial', 'performing', 'creative');
create type billing_cycle as enum ('month', 'week', 'lesson', 'day', 'one-time', 'free');

create table activities (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references profiles(id) on delete cascade,
  category activity_category not null,
  activity_type text not null,
  sub_type text,
  title text not null,
  description text,
  level text,
  age_range text,
  location text,
  price numeric(10,2) not null default 0 check (price >= 0),
  billing billing_cycle not null default 'month',
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_activities_updated_at
  before update on activities
  for each row execute function set_updated_at();

create table activity_materials (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  file_type text,
  file_size bigint,
  uploaded_at timestamptz not null default now()
);

-- ============================================================
-- SUBSCRIPTIONS, PAYMENTS & WALLET (real ledger — no simulated success)
-- ============================================================

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles(id) on delete cascade,
  activity_id uuid not null references activities(id) on delete cascade,
  teacher_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'active', 'cancelled', 'expired')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  unique (student_id, activity_id)
);

create table payment_transactions (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  student_id uuid not null references profiles(id),
  teacher_id uuid not null references profiles(id),
  amount numeric(10,2) not null check (amount >= 0),
  currency text not null default 'KES',
  provider text not null default 'mpesa',
  provider_reference text,
  checkout_request_id text,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  teacher_share numeric(10,2) not null default 0,
  platform_share numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- One transaction row per Daraja STK push request. Combined with the
-- pending-only guard in the /api/mpesa/callback handler and the
-- old.status-is-distinct-from check below, this makes it impossible for a
-- retried/duplicated Safaricom callback to credit a teacher's wallet twice
-- for the same payment.
create unique index payment_transactions_checkout_request_id_key
  on payment_transactions (checkout_request_id)
  where checkout_request_id is not null;

create table withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references profiles(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  method text not null default 'mpesa' check (method in ('mpesa', 'bank')),
  destination text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'successful', 'failed', 'reversed')),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  provider_reference text,
  notes text
);

-- Revenue split constants (kept in one place; also mirrored in application code)
-- teacher_share = amount * 0.70, platform_share = amount * 0.30

-- When a transaction is marked completed, atomically credit the teacher's wallet
-- and activate the subscription. This runs regardless of which code path updates
-- the row, so the wallet balance can never drift from the transaction ledger.
create or replace function handle_transaction_completed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'completed' and (old.status is distinct from 'completed') then
    new.teacher_share := round(new.amount * 0.70, 2);
    new.platform_share := round(new.amount - new.teacher_share, 2);
    new.completed_at := now();

    update teacher_profiles
      set wallet_balance = wallet_balance + new.teacher_share
      where profile_id = new.teacher_id;

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

create trigger trg_transaction_completed
  before update on payment_transactions
  for each row execute function handle_transaction_completed();

-- Debit the teacher's wallet only once a withdrawal is actually sent by the
-- payout provider (never on request — a pending/processing request does not
-- move money). If a successful payout is later reversed (e.g. the provider
-- claws it back), credit the wallet back so the ledger always reflects what
-- the teacher can actually access.
create or replace function handle_withdrawal_status_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'successful' and (old.status is distinct from 'successful') then
    new.processed_at := now();
    update teacher_profiles
      set wallet_balance = wallet_balance - new.amount
      where profile_id = new.teacher_id and wallet_balance >= new.amount;
    if not found then
      raise exception 'Insufficient wallet balance for withdrawal %', new.id;
    end if;
  elsif new.status = 'failed' and old.status in ('pending', 'processing') then
    new.processed_at := now();
  elsif new.status = 'reversed' and old.status = 'successful' then
    new.processed_at := now();
    update teacher_profiles
      set wallet_balance = wallet_balance + new.amount
      where profile_id = new.teacher_id;
  end if;
  return new;
end;
$$;

create trigger trg_withdrawal_status_change
  before update on withdrawal_requests
  for each row execute function handle_withdrawal_status_change();

-- Prevent a teacher from requesting a withdrawal larger than their current balance.
create or replace function check_withdrawal_amount()
returns trigger language plpgsql as $$
declare
  v_balance numeric(12,2);
begin
  select wallet_balance into v_balance from teacher_profiles where profile_id = new.teacher_id;
  if v_balance is null or new.amount > v_balance then
    raise exception 'Withdrawal amount exceeds available wallet balance';
  end if;
  return new;
end;
$$;

create trigger trg_check_withdrawal_amount
  before insert on withdrawal_requests
  for each row execute function check_withdrawal_amount();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table profiles enable row level security;
alter table student_profiles enable row level security;
alter table teacher_profiles enable row level security;
alter table subjects enable row level security;
alter table lessons enable row level security;
alter table lesson_materials enable row level security;
alter table assignments enable row level security;
alter table assignment_submissions enable row level security;
alter table activities enable row level security;
alter table activity_materials enable row level security;
alter table subscriptions enable row level security;
alter table payment_transactions enable row level security;
alter table withdrawal_requests enable row level security;

create or replace function is_admin()
returns boolean language sql stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- profiles
create policy "profiles_select_own_or_admin" on profiles for select
  using (id = auth.uid() or is_admin());
create policy "profiles_update_own" on profiles for update
  using (id = auth.uid());
create policy "profiles_select_public_teacher" on profiles for select
  using (role = 'teacher');

-- student_profiles
create policy "student_profile_owner" on student_profiles for all
  using (profile_id = auth.uid() or is_admin());

-- teacher_profiles: owner full access; everyone else can read the public columns
-- (wallet_balance/payout fields are only ever selected server-side with the
-- service role, so no separate column-level policy is required here).
create policy "teacher_profile_owner" on teacher_profiles for all
  using (profile_id = auth.uid() or is_admin());
create policy "teacher_profile_public_read" on teacher_profiles for select
  using (true);

-- subjects: readable by any signed-in user; writable by admin only
create policy "subjects_read_all" on subjects for select using (auth.role() = 'authenticated');
create policy "subjects_admin_write" on subjects for all using (is_admin());

-- lessons: published lessons readable by all signed-in users; owning teacher full access
create policy "lessons_read_published_or_own" on lessons for select
  using (status = 'published' or teacher_id = auth.uid() or is_admin());
create policy "lessons_teacher_write" on lessons for insert
  with check (teacher_id = auth.uid());
create policy "lessons_teacher_update" on lessons for update
  using (teacher_id = auth.uid() or is_admin());
create policy "lessons_teacher_delete" on lessons for delete
  using (teacher_id = auth.uid() or is_admin());

-- lesson_materials follow the parent lesson's visibility
create policy "lesson_materials_read" on lesson_materials for select
  using (exists (
    select 1 from lessons l where l.id = lesson_id
    and (l.status = 'published' or l.teacher_id = auth.uid() or is_admin())
  ));
create policy "lesson_materials_teacher_write" on lesson_materials for all
  using (exists (select 1 from lessons l where l.id = lesson_id and l.teacher_id = auth.uid()));

-- assignments follow the parent lesson
create policy "assignments_read" on assignments for select
  using (exists (
    select 1 from lessons l where l.id = lesson_id
    and (l.status = 'published' or l.teacher_id = auth.uid() or is_admin())
  ));
create policy "assignments_teacher_write" on assignments for all
  using (exists (select 1 from lessons l where l.id = lesson_id and l.teacher_id = auth.uid()));

-- assignment_submissions: student owns their submission; teacher of the lesson can read/grade
create policy "submissions_student_insert" on assignment_submissions for insert
  with check (student_id = auth.uid());
create policy "submissions_student_read_own" on assignment_submissions for select
  using (student_id = auth.uid());
-- Students may replace their own file up until it has been graded.
create policy "submissions_student_update_own" on assignment_submissions for update
  using (student_id = auth.uid() and grade is null);
create policy "submissions_teacher_read_grade" on assignment_submissions for select
  using (exists (
    select 1 from assignments a join lessons l on l.id = a.lesson_id
    where a.id = assignment_id and l.teacher_id = auth.uid()
  ));
create policy "submissions_teacher_update_grade" on assignment_submissions for update
  using (exists (
    select 1 from assignments a join lessons l on l.id = a.lesson_id
    where a.id = assignment_id and l.teacher_id = auth.uid()
  ));

-- activities: published readable by all signed-in users; owning teacher full access
create policy "activities_read_published_or_own" on activities for select
  using (status = 'published' or teacher_id = auth.uid() or is_admin());
create policy "activities_teacher_write" on activities for insert
  with check (teacher_id = auth.uid());
create policy "activities_teacher_update" on activities for update
  using (teacher_id = auth.uid() or is_admin());
create policy "activities_teacher_delete" on activities for delete
  using (teacher_id = auth.uid() or is_admin());

create policy "activity_materials_read" on activity_materials for select
  using (exists (
    select 1 from activities a where a.id = activity_id
    and (a.status = 'published' or a.teacher_id = auth.uid() or is_admin())
  ));
create policy "activity_materials_teacher_write" on activity_materials for all
  using (exists (select 1 from activities a where a.id = activity_id and a.teacher_id = auth.uid()));

-- subscriptions: student and teacher can read their own; student can create a
-- pending_payment row for themselves, but only server code (service role) may
-- ever move a subscription to 'active' — see handle_transaction_completed().
create policy "subscriptions_student_read" on subscriptions for select
  using (student_id = auth.uid() or teacher_id = auth.uid() or is_admin());
-- Clients may only ever create a subscription in "pending_payment" state —
-- flipping it to "active" happens exclusively via the service role, either
-- from handle_transaction_completed() after a real M-Pesa payment, or from
-- the enrolFree server action for genuinely free (price = 0) activities.
create policy "subscriptions_student_insert" on subscriptions for insert
  with check (student_id = auth.uid() and status = 'pending_payment');

-- payment_transactions: read-only for the parties involved; all writes happen
-- server-side with the service role key (see /api/mpesa routes) so a client
-- can never fabricate a "completed" payment.
create policy "transactions_read_own" on payment_transactions for select
  using (student_id = auth.uid() or teacher_id = auth.uid() or is_admin());

-- withdrawal_requests: teacher can create + read their own; status changes are
-- restricted to the service role (admin/payout processing), never the teacher.
create policy "withdrawals_teacher_read" on withdrawal_requests for select
  using (teacher_id = auth.uid() or is_admin());
create policy "withdrawals_teacher_insert" on withdrawal_requests for insert
  with check (teacher_id = auth.uid());

-- ============================================================
-- STORAGE BUCKETS
-- ============================================================

insert into storage.buckets (id, name, public)
values
  ('lesson-materials', 'lesson-materials', false),
  ('activity-materials', 'activity-materials', false),
  ('assignment-submissions', 'assignment-submissions', false),
  ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Teachers manage files under their own lesson/activity folders (path prefix = lesson_id/activity_id).
create policy "lesson_materials_storage_teacher" on storage.objects for all
  using (bucket_id = 'lesson-materials' and exists (
    select 1 from lessons l where l.id::text = (storage.foldername(name))[1] and l.teacher_id = auth.uid()
  ));
create policy "lesson_materials_storage_read" on storage.objects for select
  using (bucket_id = 'lesson-materials' and auth.role() = 'authenticated');

create policy "activity_materials_storage_teacher" on storage.objects for all
  using (bucket_id = 'activity-materials' and exists (
    select 1 from activities a where a.id::text = (storage.foldername(name))[1] and a.teacher_id = auth.uid()
  ));
create policy "activity_materials_storage_read" on storage.objects for select
  using (bucket_id = 'activity-materials' and auth.role() = 'authenticated');

-- Students upload/read their own submissions; the lesson's teacher can read them.
create policy "submissions_storage_student" on storage.objects for all
  using (bucket_id = 'assignment-submissions' and (storage.foldername(name))[2] = auth.uid()::text);
create policy "submissions_storage_teacher_read" on storage.objects for select
  using (bucket_id = 'assignment-submissions' and exists (
    select 1 from assignments a join lessons l on l.id = a.lesson_id
    where a.id::text = (storage.foldername(name))[1] and l.teacher_id = auth.uid()
  ));

create policy "avatars_public_read" on storage.objects for select using (bucket_id = 'avatars');
create policy "avatars_owner_write" on storage.objects for all
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);


-- ############################################################################
-- ## seed.sql
-- ############################################################################

-- Seed data preserving the real content model from the original MTH prototype.
-- Run after 0001_init.sql. Safe to re-run (idempotent on name).

insert into subjects (name, color, order_index) values
  ('Mathematics', 'cyan', 1),
  ('English', 'orange', 2),
  ('Kiswahili', 'red', 3),
  ('Science & Technology', 'blue', 4),
  ('Social Studies', 'cyan', 5),
  ('Christian Religious Education', 'orange', 6),
  ('Agriculture', 'red', 7),
  ('Creative Arts', 'blue', 8)
on conflict (name) do nothing;

-- Co-curricular categories/activities are represented directly as `activities.category`
-- and `activities.activity_type` values (enforced by the activity_category enum and
-- validated in the app's activity form). The full set offered through Modern Talent Hub:
--
--   sports     -> skating, football, archery, rugby, tennis, athletics, swimming
--   martial    -> karate, taekwondo, kickboxing
--   performing -> ballet, moderndance, gymnastics, music (sub_type: Piano/Guitar/Drums/Violin)
--   creative   -> coding, robotics, artcraft, chess
--
-- These aren't a separate lookup table because each activity is a real, teacher-owned
-- listing (title, price, billing cycle) rather than a static catalog entry — teachers
-- create them from the dashboard, choosing category + activity type from this fixed set
-- (see lib/constants.ts ACTIVITY_CATEGORIES, kept in sync with this comment).


-- ############################################################################
-- ## migrations/0002_coach_activation_fee.sql
-- ############################################################################

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


-- ############################################################################
-- ## migrations/0003_payments_toggle.sql
-- ############################################################################

-- Modern Talent Hub — global payments on/off switch
-- Run after 0002_coach_activation_fee.sql.
--
-- While payments_enabled is false the whole app is free: coaches activate
-- without paying, students enrol in any published activity without paying,
-- and the M-Pesa STK Push endpoints refuse to start a charge. Flip it on at
-- /admin/settings when you're ready to take payments — no code change.
--
-- Safe default: a missing row is treated as "payments off".

alter table platform_settings
  add constraint payments_enabled_valid check (
    key <> 'payments_enabled' or jsonb_typeof(value) = 'boolean'
  );

insert into platform_settings (key, value)
values ('payments_enabled', 'false'::jsonb)
on conflict (key) do nothing;


-- ############################################################################
-- ## migrations/0004_lock_down_roles.sql
-- ############################################################################

-- Modern Talent Hub — close the self-promote-to-admin holes
-- Run after 0003_payments_toggle.sql. RUN THIS BEFORE GOING PUBLIC.
--
-- Two ways existed for anyone to become an admin using only the public anon key:
--   1. Signup:  supabase.auth.signUp({ options: { data: { role: 'admin' } } })
--      handle_new_user() cast that client-supplied metadata straight into the enum.
--   2. Update:  the "profiles_update_own" RLS policy has no column restriction, so a
--      signed-in user could run  update profiles set role = 'admin'  on themselves.
--
-- After this migration the only ways to get an admin are SQL / the service role
-- (see the README, "Creating the first admin").

-- ------------------------------------------------------------
-- 1. Signup: only 'student' and 'teacher' are ever accepted from metadata.
--    Anything else (including 'admin' or garbage that would make the enum cast
--    throw) becomes 'student'. Body is otherwise identical to 0001.
-- ------------------------------------------------------------
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_role user_role;
begin
  v_role := case new.raw_user_meta_data->>'role'
    when 'teacher' then 'teacher'::user_role
    else 'student'::user_role
  end;

  insert into profiles (id, role, full_name, phone)
  values (
    new.id,
    v_role,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'phone'
  );

  if v_role = 'student' then
    insert into student_profiles (profile_id, grade, school_name, parent_phone)
    values (new.id, new.raw_user_meta_data->>'grade', new.raw_user_meta_data->>'school_name', new.raw_user_meta_data->>'parent_phone');
  elsif v_role = 'teacher' then
    insert into teacher_profiles (profile_id, bio, specialty, mpesa_number)
    values (new.id, new.raw_user_meta_data->>'bio', new.raw_user_meta_data->>'specialty', new.raw_user_meta_data->>'phone');
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------
-- 2. Updates: a role can never be changed from a browser session, by anyone
--    (admins included — the app has no role-management feature). Direct SQL
--    (SQL Editor / psql) and the service role are unaffected: auth.role() is
--    null there, or 'service_role'.
-- ------------------------------------------------------------
create or replace function guard_profile_role()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role and auth.role() in ('anon', 'authenticated') then
    raise exception 'A profile role can only be changed with SQL or the service role.';
  end if;
  return new;
end;
$$;

create trigger trg_guard_profile_role
  before update on profiles
  for each row execute function guard_profile_role();

-- ------------------------------------------------------------
-- 3. AUDIT — do this now. If the hole was exploited before this migration,
--    the attacker is already an admin and still will be after it. List every
--    admin and confirm each one is really you or someone you trust:
--
--      select p.id, u.email, p.full_name, p.created_at
--      from profiles p join auth.users u on u.id = p.id
--      where p.role = 'admin'
--      order by p.created_at;
--
--    Demote anyone unexpected (runs fine from the SQL Editor):
--
--      update profiles set role = 'student' where id = '<uuid from above>';
--
--    Then check what an unexpected admin could have done: teachers approved
--    (teacher_profiles.approved), and withdrawal_requests moved out of
--    'pending' (processed_at is set on those).
-- ------------------------------------------------------------


-- ############################################################################
-- ## migrations/0005_registration_codes.sql
-- ############################################################################

-- Modern Talent Hub — 5-digit email verification codes for registration
-- Run after 0004_lock_down_roles.sql.
--
-- Supabase's own email OTP can't be 5 digits (minimum is 6), so registration
-- verification is handled by our server routes:
--   POST /api/auth/send-code            issues + emails a code
--   POST /api/auth/verify-registration  checks the code, THEN creates the account
--
-- The auth user is only created after the code is proven, so nobody can
-- pre-register (squat) someone else's email address.
--
-- Everything below is reachable ONLY with the service role: RLS is on with no
-- policies, and the functions are revoked from anon/authenticated. A 5-digit
-- code has just 90,000 possibilities, so security rests on these limits:
--   * codes are stored as an HMAC (keyed with a server secret), never in clear
--   * a code expires after 10 minutes
--   * at most 5 wrong guesses per code, counted atomically in the database
--   * one new code per email per 60s, at most 5 per hour
--   * per-IP request limits (hit_rate_limit)

create table registration_codes (
  email text primary key,                 -- lower-cased
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  send_count int not null default 1,
  window_start timestamptz not null default now(),
  last_sent_at timestamptz not null default now()
);

create table auth_rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits int not null default 0
);

alter table registration_codes enable row level security;
alter table auth_rate_limits enable row level security;
-- (no policies on purpose: anon/authenticated can read and write nothing)

-- Is this email already registered, and has it been confirmed?
create or replace function auth_email_status(p_email text)
returns table (id uuid, confirmed boolean)
language sql security definer set search_path = public as $$
  select u.id, (u.email_confirmed_at is not null)
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
  limit 1;
$$;

-- Fixed-window counter. Returns true while under the limit.
create or replace function hit_rate_limit(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_hits int;
begin
  delete from auth_rate_limits where window_start < now() - interval '1 day';

  insert into auth_rate_limits as l (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when l.window_start < now() - make_interval(secs => p_window_seconds)
                then 1 else l.hits + 1 end,
    window_start = case when l.window_start < now() - make_interval(secs => p_window_seconds)
                        then now() else l.window_start end
  returning l.hits into v_hits;

  return v_hits <= p_max;
end;
$$;

-- Store a fresh code for an email (replacing any previous one, which stops
-- working). Enforces the 60s cooldown and the 5-per-hour cap.
-- status: 'ok' | 'cooldown' | 'limit'; retry_after = seconds to wait.
create or replace function issue_registration_code(p_email text, p_code_hash text, p_ttl_seconds int default 600)
returns table (status text, retry_after int)
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  r registration_codes%rowtype;
  v_wait int;
begin
  select * into r from registration_codes where email = v_email for update;

  if found then
    v_wait := ceil(extract(epoch from (r.last_sent_at + interval '60 seconds' - now())))::int;
    if v_wait > 0 then
      return query select 'cooldown'::text, v_wait;
      return;
    end if;

    if r.window_start > now() - interval '1 hour' and r.send_count >= 5 then
      return query select 'limit'::text,
        ceil(extract(epoch from (r.window_start + interval '1 hour' - now())))::int;
      return;
    end if;

    update registration_codes set
      code_hash = p_code_hash,
      expires_at = now() + make_interval(secs => p_ttl_seconds),
      attempts = 0,
      last_sent_at = now(),
      send_count = case when window_start > now() - interval '1 hour' then send_count + 1 else 1 end,
      window_start = case when window_start > now() - interval '1 hour' then window_start else now() end
    where email = v_email;
  else
    begin
      insert into registration_codes (email, code_hash, expires_at)
      values (v_email, p_code_hash, now() + make_interval(secs => p_ttl_seconds));
    exception when unique_violation then
      -- two requests raced to create the first row; the other one won
      return query select 'cooldown'::text, 60;
      return;
    end;
  end if;

  return query select 'ok'::text, 0;
end;
$$;

-- Check a code. The row is locked, so parallel guesses can't dodge the attempt
-- counter. Returns 'ok' (code is consumed), 'invalid', 'expired', 'locked'
-- (5 wrong guesses — a new code is required) or 'none' (no code requested).
create or replace function verify_registration_code(p_email text, p_code_hash text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  r registration_codes%rowtype;
begin
  select * into r from registration_codes where email = v_email for update;

  if not found then return 'none'; end if;
  if r.expires_at <= now() then return 'expired'; end if;
  if r.attempts >= 5 then return 'locked'; end if;

  if r.code_hash = p_code_hash then
    delete from registration_codes where email = v_email;
    return 'ok';
  end if;

  update registration_codes set attempts = attempts + 1 where email = v_email;
  return 'invalid';
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon/authenticated by
-- default. These must be callable by the server (service role) only.
revoke all on function auth_email_status(text) from public, anon, authenticated;
revoke all on function hit_rate_limit(text, int, int) from public, anon, authenticated;
revoke all on function issue_registration_code(text, text, int) from public, anon, authenticated;
revoke all on function verify_registration_code(text, text) from public, anon, authenticated;

grant execute on function auth_email_status(text) to service_role;
grant execute on function hit_rate_limit(text, int, int) to service_role;
grant execute on function issue_registration_code(text, text, int) to service_role;
grant execute on function verify_registration_code(text, text) to service_role;


-- ############################################################################
-- ## migrations/0006_teacher_approval_enforcement.sql
-- ############################################################################

-- Modern Talent Hub — enforce teacher approval in the database
-- Run after 0005_registration_codes.sql.
--
-- Rule: a teacher cannot create or change lessons/activities until an admin has
-- approved them (teacher_profiles.approved). The app already hides the teacher
-- area from unapproved teachers and checks this in its create actions; this
-- trigger makes the rule hold even for someone who skips the app and calls the
-- database API directly with their own login.
--
-- Not affected: admins, the service role, and the SQL Editor (none of those are
-- an 'authenticated' end-user session).

create or replace function require_approved_teacher()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated'
     and not is_admin()
     and not exists (
       select 1 from teacher_profiles
       where profile_id = auth.uid() and approved
     ) then
    raise exception 'Your teacher account has not been approved yet.';
  end if;
  return new;
end;
$$;

create trigger trg_lessons_require_approved_teacher
  before insert or update on lessons
  for each row execute function require_approved_teacher();

create trigger trg_activities_require_approved_teacher
  before insert or update on activities
  for each row execute function require_approved_teacher();


-- ############################################################################
-- ## migrations/0007_fix_is_admin_recursion.sql
-- ############################################################################

-- Modern Talent Hub — fix "stack depth limit exceeded" on admin actions
-- Run after 0006_teacher_approval_enforcement.sql. Safe to run more than once.
--
-- Bug: is_admin() (from 0001) reads the profiles table, but profiles has its own
-- row-level-security policy that calls is_admin() again. When Postgres has to
-- evaluate that policy for a row that isn't the caller's own, it re-enters
-- is_admin() forever and aborts with "stack depth limit exceeded". Admin
-- actions that WRITE (approving a teacher, updating settings, processing
-- withdrawals) hit it; plain reads mostly dodge it.
--
-- Fix: run is_admin() with the owner's rights (SECURITY DEFINER) so its lookup on
-- profiles bypasses those policies and the recursion never starts. It still
-- answers only "is the CURRENT signed-in user an admin?" — auth.uid() is read
-- from the caller's login, not from the function owner — and returns just a
-- boolean. CREATE OR REPLACE keeps every policy that already uses it.

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;


-- ############################################################################
-- ## migrations/0008_live_sessions.sql
-- ############################################################################

-- Modern Talent Hub — live classes (lessons + activities)
-- Run after 0007_fix_is_admin_recursion.sql.
--
-- Adds two NEW tables and touches nothing that already exists:
--   live_sessions              one row per live class, attached to EITHER a lesson
--                              OR an activity (a lesson/activity "is live" simply
--                              because it has a live_sessions row)
--   live_session_participants  the students who joined a session
--
-- The video itself is provided by an external service (Daily); this table only
-- stores the schedule, status and the provider's room name.
--
-- Security model: clients can only READ (policies below). Every write — create,
-- start, end, join, remove — goes through server code that checks who is asking
-- (owning approved teacher, enrolled student, admin) and then writes with the
-- service role, so status and participant rows can't be forged from a browser.

create table live_sessions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('lesson', 'activity')),
  lesson_id uuid references lessons(id) on delete cascade,
  activity_id uuid references activities(id) on delete cascade,
  teacher_id uuid not null references profiles(id) on delete cascade,
  scheduled_at timestamptz not null,
  duration_minutes int not null check (duration_minutes between 5 and 240),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended')),
  room_name text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint live_sessions_one_parent check (
    (kind = 'lesson' and lesson_id is not null and activity_id is null)
    or (kind = 'activity' and activity_id is not null and lesson_id is null)
  )
);

-- A lesson or activity has at most one live session.
create unique index live_sessions_lesson_key on live_sessions (lesson_id) where lesson_id is not null;
create unique index live_sessions_activity_key on live_sessions (activity_id) where activity_id is not null;
create index live_sessions_teacher_idx on live_sessions (teacher_id, scheduled_at desc);

create table live_session_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references live_sessions(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_joined_at timestamptz not null default now(),
  unique (session_id, profile_id)
);

create index live_session_participants_session_idx on live_session_participants (session_id);

alter table live_sessions enable row level security;
alter table live_session_participants enable row level security;

-- Read: the owning teacher, admins, and students — but only once the parent
-- lesson/activity is published (the same visibility rule as the lesson itself).
create policy "live_sessions_read" on live_sessions for select using (
  teacher_id = auth.uid()
  or is_admin()
  or (lesson_id is not null and exists (
        select 1 from lessons l where l.id = lesson_id and l.status = 'published'))
  or (activity_id is not null and exists (
        select 1 from activities a where a.id = activity_id and a.status = 'published'))
);

-- Participants: a student sees their own row; the session's teacher and admins see all.
create policy "live_participants_read" on live_session_participants for select using (
  profile_id = auth.uid()
  or is_admin()
  or exists (select 1 from live_sessions s where s.id = session_id and s.teacher_id = auth.uid())
);

-- (No insert/update/delete policies on purpose: see the security model above.)



-- ############################################################################
-- ## migrations/0009_delete_user_identities.sql
-- ############################################################################
-- Account deletion, "scrub" path: remove a person's login identities (for example the
-- Google name/email copy Supabase keeps in auth.identities) and their open sessions.
--
-- Supabase has no admin API for this, so the server-side deletion code
-- (app/account/actions.ts) calls this function with the service-role key. Normal
-- (hard) deletions don't need it: deleting the auth user removes its identities.
--
-- Safe to run more than once. Nobody but the service role can call it.

create or replace function delete_user_identities(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from auth.identities where user_id = p_user_id;
  -- Also ends every signed-in session for that user (refresh tokens go with them).
  delete from auth.sessions where user_id = p_user_id;
end;
$$;

revoke all on function delete_user_identities(uuid) from public, anon, authenticated;
grant execute on function delete_user_identities(uuid) to service_role;


-- ############################################################################
-- ## migrations/0010_age_and_guardian_consent.sql
-- ############################################################################
-- Modern Talent Hub — Stage 2: age check and parent/guardian consent.
-- Run after 0009_delete_user_identities.sql.
--
-- Everyone gives a date of birth. Anyone under 18 (Kenya's Data Protection Act treats
-- them as children) needs a parent or guardian to approve through an emailed link before
-- they can use the app. Nothing existing is changed or deleted: people who already have
-- an account simply have no age record yet, and are asked for one at their next login.
--
-- Security model: these tables are WRITTEN ONLY by server code (service role). A signed-in
-- user can read their own age record, so the app can show the right screen, but no
-- policy lets anyone insert or update, so nobody can approve themselves.

create table age_records (
  profile_id         uuid primary key references profiles(id) on delete cascade,
  date_of_birth      date not null,
  guardian_email     text,
  consent_status     text not null check (consent_status in ('not_required', 'pending', 'granted', 'declined')),
  consent_decided_at timestamptz,
  created_at         timestamptz not null default now(),
  -- A guardian is on record for every status except "not_required" (adults).
  constraint age_records_guardian_present check (consent_status = 'not_required' or guardian_email is not null)
);

alter table age_records enable row level security;

create policy "age_records_read_own" on age_records for select
  using (profile_id = auth.uid());

-- One row per consent email sent. Only a one-way hash of the secret in the email link is
-- stored, so a database leak cannot be used to approve anyone.
create table guardian_consent_requests (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references profiles(id) on delete cascade,
  guardian_email text not null,
  token_hash     text not null unique,
  expires_at     timestamptz not null,
  decided_at     timestamptz,
  decision       text check (decision in ('approved', 'declined')),
  created_at     timestamptz not null default now()
);

create index guardian_consent_requests_profile_idx on guardian_consent_requests (profile_id);

-- RLS on with NO policies: only the service role (server code) can touch it.
alter table guardian_consent_requests enable row level security;

-- Records the guardian's decision. Atomic: the request is checked and consumed, and the
-- child's status updated, in one transaction. Returns one of:
--   approved | declined   the decision was recorded
--   used | expired        the link was already used / is too old
--   invalid               unknown link, bad decision, or the request is no longer current
--                         (for example the child changed the guardian's email address)
create or replace function decide_guardian_consent(p_token_hash text, p_decision text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  r guardian_consent_requests;
begin
  if p_decision is null or p_decision not in ('approved', 'declined') then
    return 'invalid';
  end if;

  select * into r from guardian_consent_requests where token_hash = p_token_hash for update;
  if not found then return 'invalid'; end if;
  if r.decided_at is not null then return 'used'; end if;
  if r.expires_at < now() then return 'expired'; end if;

  -- Only the CURRENT request for a still-pending account counts.
  if not exists (
    select 1 from age_records
    where profile_id = r.profile_id
      and consent_status = 'pending'
      and lower(guardian_email) = lower(r.guardian_email)
  ) then
    return 'invalid';
  end if;

  update guardian_consent_requests set decided_at = now(), decision = p_decision where id = r.id;

  update age_records
  set consent_status = case when p_decision = 'approved' then 'granted' else 'declined' end,
      consent_decided_at = now()
  where profile_id = r.profile_id;

  return p_decision;
end;
$$;

revoke all on function decide_guardian_consent(text, text) from public, anon, authenticated;
grant execute on function decide_guardian_consent(text, text) to service_role;


-- ############################################################################
-- ## migrations/0011_messaging.sql
-- ############################################################################

-- Modern Talent Hub — student ↔ teacher messaging, with PDF homework attachments.
-- Run after 0010_age_and_guardian_consent.sql. Adds NEW objects only; nothing existing is changed.
--
-- Who may talk to whom (decided with the site owner):
--   * A STUDENT can start a conversation with the teacher of a published lesson, or with the
--     teacher of an activity they have an active subscription to. Nobody else.
--   * A TEACHER can start a conversation only with a student who has an active subscription to
--     one of their activities. Otherwise a teacher can only reply to a student who wrote first.
--   * Both people must be age-cleared (Stage 2: adult, or under-18 with guardian approval).
--   * Admins get NO in-app access to messages or attachments.
--
-- Security model — the same one live_sessions and age_records use:
--   * Clients can only READ, and only conversations they are one of the two people in
--     (policies below). There are NO insert/update/delete policies, and table privileges are
--     revoked as well, so nothing can be written from a browser.
--   * Every write goes through the server, which works out who is asking from their login and
--     calls the functions below with the service role. The functions re-check every rule in the
--     database itself, so a bug in application code cannot open a conversation that the rules
--     forbid.
--   * PDFs live in a PRIVATE bucket with a 10 MB / PDF-only limit and NO storage policies, so a
--     browser can neither list, read nor upload there. The server issues one-time upload links
--     for server-chosen paths and short-lived download links after checking membership.

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------

create table conversations (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references profiles(id) on delete cascade,
  teacher_id      uuid not null references profiles(id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  constraint conversations_two_people check (student_id <> teacher_id),
  -- One conversation per student–teacher pair, so a thread and its files stay together.
  unique (student_id, teacher_id)
);

create index conversations_student_idx on conversations (student_id, last_message_at desc);
create index conversations_teacher_idx on conversations (teacher_id, last_message_at desc);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid not null references profiles(id) on delete cascade,
  -- 'homework' can only be sent by the teacher, 'submission' only by the student (enforced in send_message).
  kind            text not null default 'message' check (kind in ('message', 'homework', 'submission')),
  body            text not null default '' check (char_length(body) <= 2000),
  attachment_path text,
  attachment_name text,
  attachment_size bigint,
  created_at      timestamptz not null default now(),
  -- At least one visible character. (btrim alone would let newlines and tabs through, and \s misses
  -- the non-breaking space, zero-width space and ideographic space — all of which look blank.)
  constraint messages_has_content check (body ~ '[^\s\u00a0\u200b\u3000]' or attachment_path is not null),
  constraint messages_attachment_all_or_none check (
    (attachment_path is null) = (attachment_name is null)
    and (attachment_path is null) = (attachment_size is null)
  ),
  constraint messages_attachment_size check (attachment_size is null or attachment_size between 1 and 10485760),
  -- The file always sits in its own conversation's folder, named by a random id, and is a PDF.
  constraint messages_attachment_path check (
    attachment_path is null
    or attachment_path ~ ('^' || conversation_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$')
  )
);

create index messages_conversation_idx on messages (conversation_id, created_at);
-- A stored file belongs to exactly one message.
create unique index messages_attachment_path_key on messages (attachment_path) where attachment_path is not null;

-- ------------------------------------------------------------
-- Helpers (server / policy use only)
-- ------------------------------------------------------------

-- Stage 2 gate, in SQL: adults ('not_required') and guardian-approved children ('granted').
create or replace function age_cleared(p_profile uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select consent_status in ('not_required', 'granted') from age_records where profile_id = p_profile), false);
$$;

-- May the CALLER read this conversation? Only if they are one of its two people AND both people
-- are (still) age-cleared — so if a child's guardian withdraws approval, neither side can read the
-- thread any more. For anyone who is not in the conversation the answer is always false, so this
-- reveals nothing about other people or conversations. Used by the read policies below.
create or replace function caller_can_read_conversation(p_conversation uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversations c
    where c.id = p_conversation
      and auth.uid() in (c.student_id, c.teacher_id)
      and age_cleared(c.student_id)
      and age_cleared(c.teacher_id)
  );
$$;

-- Is there a live student–teacher relationship? Either the teacher has a published lesson (any
-- signed-in student can open those), or the student has an active subscription to one of the
-- teacher's activities. The teacher must be approved.
create or replace function messaging_relationship(p_student uuid, p_teacher uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from teacher_profiles tp where tp.profile_id = p_teacher and tp.approved)
     and (
       exists (select 1 from lessons l where l.teacher_id = p_teacher and l.status = 'published')
       or exists (
         select 1 from subscriptions s
         where s.student_id = p_student and s.teacher_id = p_teacher and s.status = 'active'
       )
     );
$$;

-- Gets or creates the one conversation for a pair. Internal: every public entry point below
-- decides WHY the two may talk before calling this. Not callable by anyone else.
create or replace function _open_conversation(p_student uuid, p_teacher uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from profiles where id = p_student and role = 'student')
     or not exists (select 1 from profiles where id = p_teacher and role = 'teacher')
     or not exists (select 1 from teacher_profiles where profile_id = p_teacher and approved) then
    raise exception 'messaging:not_allowed';
  end if;
  if not (age_cleared(p_student) and age_cleared(p_teacher)) then
    raise exception 'messaging:not_cleared';
  end if;

  insert into conversations (student_id, teacher_id) values (p_student, p_teacher)
  on conflict (student_id, teacher_id) do nothing;

  select id into v_id from conversations where student_id = p_student and teacher_id = p_teacher;
  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- Starting a conversation (three, and only three, ways)
-- ------------------------------------------------------------

-- Student, from a lesson page: the lesson must be published and have a teacher.
create or replace function start_conversation_from_lesson(p_student uuid, p_lesson uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_teacher uuid;
begin
  select teacher_id into v_teacher from lessons where id = p_lesson and status = 'published';
  if v_teacher is null then
    raise exception 'messaging:not_allowed';
  end if;
  return _open_conversation(p_student, v_teacher);
end;
$$;

-- Student, from an activity page: the activity must be published and the student actively subscribed.
create or replace function start_conversation_from_activity(p_student uuid, p_activity uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_teacher uuid;
begin
  select a.teacher_id into v_teacher
  from activities a
  join subscriptions s on s.activity_id = a.id and s.student_id = p_student and s.status = 'active'
  where a.id = p_activity and a.status = 'published';
  if v_teacher is null then
    raise exception 'messaging:not_allowed';
  end if;
  return _open_conversation(p_student, v_teacher);
end;
$$;

-- Teacher, with one of their own active subscribers.
create or replace function start_conversation_as_teacher(p_teacher uuid, p_student uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from subscriptions s
    where s.teacher_id = p_teacher and s.student_id = p_student and s.status = 'active'
  ) then
    raise exception 'messaging:not_allowed';
  end if;
  return _open_conversation(p_student, p_teacher);
end;
$$;

-- ------------------------------------------------------------
-- Sending
-- ------------------------------------------------------------

-- 'ok', or why not: not_found (no such conversation, or the person isn't in it), not_cleared
-- (Stage 2 gate), closed (the relationship no longer exists, so the thread is read-only).
create or replace function messaging_can_send(p_user uuid, p_conversation uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  c conversations%rowtype;
begin
  select * into c from conversations where id = p_conversation;
  if not found or p_user is null or p_user not in (c.student_id, c.teacher_id) then
    return 'not_found';
  end if;
  if not (age_cleared(c.student_id) and age_cleared(c.teacher_id)) then
    return 'not_cleared';
  end if;
  if not messaging_relationship(c.student_id, c.teacher_id) then
    return 'closed';
  end if;
  return 'ok';
end;
$$;

create or replace function send_message(
  p_sender uuid,
  p_conversation uuid,
  p_body text,
  p_kind text,
  p_attachment_path text,
  p_attachment_name text,
  p_attachment_size bigint
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c conversations%rowtype;
  v_status text;
  v_body text := regexp_replace(coalesce(p_body, ''), '^[\s\u00a0\u200b\u3000]+|[\s\u00a0\u200b\u3000]+$', '', 'g');
  v_id uuid;
begin
  -- Lock the conversation so two messages sent at once are ordered.
  select * into c from conversations where id = p_conversation for update;

  v_status := messaging_can_send(p_sender, p_conversation);
  if v_status <> 'ok' then
    raise exception 'messaging:%', v_status;
  end if;

  if p_kind is null or p_kind not in ('message', 'homework', 'submission')
     or (p_kind = 'homework' and p_sender <> c.teacher_id)
     or (p_kind = 'submission' and p_sender <> c.student_id) then
    raise exception 'messaging:bad_request';
  end if;

  if char_length(v_body) > 2000 then
    raise exception 'messaging:too_long';
  end if;

  if p_attachment_path is null then
    if p_attachment_name is not null or p_attachment_size is not null then
      raise exception 'messaging:bad_attachment';
    end if;
    if v_body = '' then
      raise exception 'messaging:empty';
    end if;
  else
    if p_attachment_name is null or p_attachment_size is null
       or p_attachment_size < 1 or p_attachment_size > 10485760
       or p_attachment_path !~ ('^' || c.id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$') then
      raise exception 'messaging:bad_attachment';
    end if;
  end if;

  begin
    insert into messages (conversation_id, sender_id, kind, body, attachment_path, attachment_name, attachment_size)
    values (c.id, p_sender, p_kind, v_body, p_attachment_path, p_attachment_name, p_attachment_size)
    returning id into v_id;
  exception when unique_violation then
    -- that file is already attached to another message
    raise exception 'messaging:bad_attachment';
  end;

  update conversations set last_message_at = now() where id = c.id;
  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- Account deletion support
-- ------------------------------------------------------------

-- Is this stored file already attached to a message? The server asks before discarding a file that
-- failed to send, so a failed send can never delete a file another message is using.
create or replace function attachment_in_use(p_path text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from messages where attachment_path = p_path);
$$;

-- Every conversation a person is in, so the server can remove the files in each conversation's
-- folder (including any uploaded but never sent) before the rows go.
create or replace function messaging_conversation_ids(p_user uuid)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from conversations where student_id = p_user or teacher_id = p_user;
$$;

-- Removes every conversation the person is in — and with it every message — for BOTH people.
create or replace function delete_user_messages(p_user uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  delete from conversations where student_id = p_user or teacher_id = p_user;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ------------------------------------------------------------
-- Row level security: read only, participants only, no admin access
-- ------------------------------------------------------------

alter table conversations enable row level security;
alter table messages enable row level security;

create policy "conversations_read_participants" on conversations for select
  using (caller_can_read_conversation(id));

create policy "messages_read_participants" on messages for select
  using (caller_can_read_conversation(conversation_id));

-- (No insert/update/delete policies on purpose: see the security model above.)

-- Supabase grants new tables to the API roles by default. Reads only, and only signed-in users.
revoke all on conversations, messages from anon, authenticated;
grant select on conversations, messages to authenticated;

-- Supabase also grants EXECUTE on new functions to anon/authenticated. Everything here is for the
-- server (service role) only, except the read-policy helper, which only ever answers about the caller's own conversations.
revoke all on function age_cleared(uuid) from public, anon, authenticated;
revoke all on function messaging_relationship(uuid, uuid) from public, anon, authenticated;
revoke all on function _open_conversation(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function start_conversation_from_lesson(uuid, uuid) from public, anon, authenticated;
revoke all on function start_conversation_from_activity(uuid, uuid) from public, anon, authenticated;
revoke all on function start_conversation_as_teacher(uuid, uuid) from public, anon, authenticated;
revoke all on function messaging_can_send(uuid, uuid) from public, anon, authenticated;
revoke all on function send_message(uuid, uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function attachment_in_use(text) from public, anon, authenticated;
revoke all on function messaging_conversation_ids(uuid) from public, anon, authenticated;
revoke all on function delete_user_messages(uuid) from public, anon, authenticated;
revoke all on function caller_can_read_conversation(uuid) from public;

grant execute on function age_cleared(uuid) to service_role;
grant execute on function messaging_relationship(uuid, uuid) to service_role;
grant execute on function start_conversation_from_lesson(uuid, uuid) to service_role;
grant execute on function start_conversation_from_activity(uuid, uuid) to service_role;
grant execute on function start_conversation_as_teacher(uuid, uuid) to service_role;
grant execute on function messaging_can_send(uuid, uuid) to service_role;
grant execute on function send_message(uuid, uuid, text, text, text, text, bigint) to service_role;
grant execute on function attachment_in_use(text) to service_role;
grant execute on function messaging_conversation_ids(uuid) to service_role;
grant execute on function delete_user_messages(uuid) to service_role;
grant execute on function caller_can_read_conversation(uuid) to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Storage: a private bucket that the browser cannot touch
-- ------------------------------------------------------------

-- 10 MB and PDF only, enforced by Supabase Storage itself. There are deliberately NO policies on
-- storage.objects for this bucket: with row level security on and no policy, the anon and
-- authenticated roles can neither read, list, upload nor delete anything in it. Uploads use
-- one-time signed links that only the server can create; downloads are short-lived signed links
-- created by the server after it has checked that the caller is in the conversation.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('message-attachments', 'message-attachments', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ############################################################################
-- ## migrations/0014_messaging_guardian_consent.sql
-- ############################################################################

-- Modern Talent Hub — separate parent/guardian permission for private messaging.
-- Run after 0011_messaging.sql. Safe to run once; re-running errors on "already exists" (harmless).
--
-- Why: the Stage 2 guardian consent page (wording "guardian-v1") told parents "there are no private
-- messages between users". 0011 then added student ↔ teacher messaging. A v1 approval therefore never
-- covered messaging, so it cannot be used as permission for it.
--
-- The rule from here on (approved policy):
--   * 18 or over (Kenya date, worked out when access is checked) and platform consent in place
--     ('not_required' or 'granted')  -> messaging allowed automatically. This holds even if a guardian
--     earlier declined or withdrew MESSAGING permission while the student was under 18.
--   * Under 18 -> messaging needs its OWN guardian permission, given on wording that covers it
--     ("guardian-v2" or later). Approving the platform alone is not enough.
--   * Declining or withdrawing messaging never changes platform consent (age_records.consent_status)
--     and never deletes the account. It only switches messaging off.
--
-- What is NOT changed: age_records.consent_status and its meaning, decide_guardian_consent() and
-- age_cleared() are left exactly as 0010/0011 define them. Nothing from the M-Pesa / payment
-- migrations is touched. The only existing objects replaced are the three 0011 messaging functions
-- that decide who may see or use a conversation; their relationship and security rules are kept
-- line for line, with age_cleared() swapped for messaging_cleared().
--
-- Existing data: every existing row starts with messaging permission OFF. Existing under-18 students
-- (approved on v1 wording) keep using the platform but must ask their parent/guardian for messaging.
-- Adults are unaffected, because messaging_cleared() lets them through on age alone.

-- ------------------------------------------------------------
-- Consent wording versions (server-only reference table)
-- ------------------------------------------------------------

create table guardian_consent_versions (
  version          text primary key,
  covers_messaging boolean not null,
  summary          text not null,
  introduced_at    timestamptz not null default now()
);

alter table guardian_consent_versions enable row level security;
-- No policies and no API privileges: only the server (service role) and the database itself read it.
revoke all on guardian_consent_versions from anon, authenticated;

insert into guardian_consent_versions (version, covers_messaging, summary) values
  ('guardian-v1', false,
   'Stage 2 wording: permission to use the platform. Stated there are no private messages between users; does NOT cover messaging.'),
  ('guardian-v2', true,
   'Permission to use the platform, plus a separate, optional choice to allow private messages (with PDF homework) between the young person and their teachers.');

-- ------------------------------------------------------------
-- age_records: guardian messaging permission, separate from platform consent
-- ------------------------------------------------------------

alter table age_records
  add column guardian_messaging_allowed    boolean not null default false,
  add column guardian_messaging_status     text not null default 'not_requested'
    check (guardian_messaging_status in ('not_requested', 'granted', 'declined', 'withdrawn')),
  add column guardian_messaging_version    text references guardian_consent_versions(version),
  add column guardian_messaging_decided_at timestamptz,
  add constraint age_records_messaging_consistent
    check (guardian_messaging_allowed = (guardian_messaging_status = 'granted'));

-- ------------------------------------------------------------
-- guardian_consent_requests: what the request is for, which wording, and the messaging answer
-- ------------------------------------------------------------

-- Existing rows (and any request still created by pre-0014 app code) were sent with the v1 wording,
-- so that is the default. New app code always sets purpose and version explicitly.
alter table guardian_consent_requests
  add column purpose               text not null default 'platform' check (purpose in ('platform', 'messaging')),
  add column consent_version       text not null default 'guardian-v1' references guardian_consent_versions(version),
  add column messaging_decision    text check (messaging_decision in ('approved', 'declined')),
  add column messaging_decided_at  timestamptz,
  add constraint guardian_consent_requests_messaging_decided
    check ((messaging_decision is null) = (messaging_decided_at is null));

-- A messaging permission can only ever rest on wording that covered messaging. Enforced in the
-- database so that no code path — not even a direct service-role write — can turn a v1 approval
-- into messaging permission.
create or replace function guard_messaging_consent_version()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'age_records' then
    if new.guardian_messaging_allowed and not exists (
      select 1 from guardian_consent_versions v
      where v.version = new.guardian_messaging_version and v.covers_messaging
    ) then
      raise exception 'Messaging permission needs guardian consent wording that covers messaging.';
    end if;
  else
    if new.messaging_decision = 'approved' and not exists (
      select 1 from guardian_consent_versions v
      where v.version = new.consent_version and v.covers_messaging
    ) then
      raise exception 'Messaging permission needs guardian consent wording that covers messaging.';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_age_records_messaging_version
  before insert or update on age_records
  for each row execute function guard_messaging_consent_version();

create trigger trg_guardian_requests_messaging_version
  before insert or update on guardian_consent_requests
  for each row execute function guard_messaging_consent_version();

-- ------------------------------------------------------------
-- Age, worked out on the day it is checked (no birthday job needed)
-- ------------------------------------------------------------

-- Whole years old on the Kenyan calendar date of p_at. Same rule as lib/age.ts ageInYears():
-- the birthday counts once today's (month, day) reaches the birth (month, day). So someone born on
-- 29 February turns a year older on 1 March in a non-leap year (28 February is still "before").
create or replace function age_in_years_kenya(p_dob date, p_at timestamptz default now())
returns int
language sql stable set search_path = public as $$
  select case when p_dob is null then null else
    extract(year from t)::int - extract(year from p_dob)::int
    - case
        when extract(month from t) < extract(month from p_dob)
          or (extract(month from t) = extract(month from p_dob) and extract(day from t) < extract(day from p_dob))
        then 1 else 0
      end
  end
  from (select (p_at at time zone 'Africa/Nairobi')::date as t) today;
$$;

-- ------------------------------------------------------------
-- The messaging gate
-- ------------------------------------------------------------

-- May this person use private messaging right now?
--   * platform consent must be in place ('not_required' or 'granted'), exactly as age_cleared(); and
--   * they are 18 or over today (Kenya date), OR a guardian gave messaging permission on wording
--     that covers it.
-- An earlier guardian decline/withdrawal of messaging does not matter once the person is 18.
create or replace function messaging_cleared(p_profile uuid, p_at timestamptz default now())
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select ar.consent_status in ('not_required', 'granted')
       and (
         age_in_years_kenya(ar.date_of_birth, p_at) >= 18
         or (ar.guardian_messaging_allowed
             and exists (select 1 from guardian_consent_versions v
                         where v.version = ar.guardian_messaging_version and v.covers_messaging))
       )
    from age_records ar
    where ar.profile_id = p_profile
  ), false);
$$;

-- ------------------------------------------------------------
-- Recording guardian decisions (server-only)
-- ------------------------------------------------------------

-- Platform consent on the v2 page, with the optional messaging choice, in ONE transaction.
-- The platform part is delegated unchanged to decide_guardian_consent(). The messaging choice is
-- recorded only if the platform was approved AND the request's wording covers messaging; for a v1
-- request (or a platform decline) the messaging choice is ignored and messaging stays off.
-- p_messaging: 'approved' | 'declined' | null (no answer = not allowed).
-- Returns what decide_guardian_consent() returned.
create or replace function decide_guardian_consent_with_messaging(p_token_hash text, p_decision text, p_messaging text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  r guardian_consent_requests;
  v_result text;
  v_covers boolean;
begin
  select * into r from guardian_consent_requests where token_hash = p_token_hash;
  if found and r.purpose <> 'platform' then
    return 'invalid';
  end if;

  v_result := decide_guardian_consent(p_token_hash, p_decision);

  if v_result = 'approved' and p_messaging in ('approved', 'declined') then
    select covers_messaging into v_covers from guardian_consent_versions where version = r.consent_version;
    if coalesce(v_covers, false) then
      update guardian_consent_requests
      set messaging_decision = p_messaging, messaging_decided_at = now()
      where id = r.id;

      update age_records
      set guardian_messaging_allowed    = (p_messaging = 'approved'),
          guardian_messaging_status     = case when p_messaging = 'approved' then 'granted' else 'declined' end,
          guardian_messaging_version    = r.consent_version,
          guardian_messaging_decided_at = now()
      where profile_id = r.profile_id;
    end if;
  end if;

  return v_result;
end;
$$;

-- A messaging-only request (the student asked "allow messaging" after their platform approval).
-- Checked and consumed atomically. Never touches consent_status and never deletes anything.
-- Returns approved | declined | used | expired | invalid.
create or replace function decide_guardian_messaging_consent(p_token_hash text, p_decision text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  r guardian_consent_requests;
begin
  if p_decision is null or p_decision not in ('approved', 'declined') then
    return 'invalid';
  end if;

  select * into r from guardian_consent_requests where token_hash = p_token_hash for update;
  if not found or r.purpose <> 'messaging' then return 'invalid'; end if;
  if r.decided_at is not null then return 'used'; end if;
  if r.expires_at < now() then return 'expired'; end if;

  if not exists (select 1 from guardian_consent_versions where version = r.consent_version and covers_messaging) then
    return 'invalid';
  end if;

  -- Only for an account whose platform consent is granted, and only from the guardian on record.
  if not exists (
    select 1 from age_records
    where profile_id = r.profile_id
      and consent_status = 'granted'
      and lower(guardian_email) = lower(r.guardian_email)
  ) then
    return 'invalid';
  end if;

  update guardian_consent_requests
  set decided_at = now(), decision = p_decision,
      messaging_decision = p_decision, messaging_decided_at = now()
  where id = r.id;

  update age_records
  set guardian_messaging_allowed    = (p_decision = 'approved'),
      guardian_messaging_status     = case when p_decision = 'approved' then 'granted' else 'declined' end,
      guardian_messaging_version    = r.consent_version,
      guardian_messaging_decided_at = now()
  where profile_id = r.profile_id;

  return p_decision;
end;
$$;

-- A guardian withdraws messaging permission (they ask support; see the Privacy Policy). Switches
-- messaging off at once — both people lose access to the conversation — and cancels any messaging
-- request still waiting. Never touches consent_status, never deletes the account or the messages.
-- Returns 'withdrawn', or 'no_record' if the person has no age record.
create or replace function withdraw_guardian_messaging_consent(p_profile uuid)
returns text
language plpgsql security definer set search_path = public as $$
begin
  update age_records
  set guardian_messaging_allowed    = false,
      guardian_messaging_status     = 'withdrawn',
      guardian_messaging_decided_at = now()
  where profile_id = p_profile;
  if not found then return 'no_record'; end if;

  update guardian_consent_requests
  set expires_at = now()
  where profile_id = p_profile and purpose = 'messaging' and decided_at is null and expires_at > now();

  return 'withdrawn';
end;
$$;

-- ------------------------------------------------------------
-- Rewire the three 0011 gates from age_cleared() to messaging_cleared()
-- ------------------------------------------------------------
-- Everything else in each function is exactly as in 0011.

create or replace function caller_can_read_conversation(p_conversation uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversations c
    where c.id = p_conversation
      and auth.uid() in (c.student_id, c.teacher_id)
      and messaging_cleared(c.student_id)
      and messaging_cleared(c.teacher_id)
  );
$$;

create or replace function _open_conversation(p_student uuid, p_teacher uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from profiles where id = p_student and role = 'student')
     or not exists (select 1 from profiles where id = p_teacher and role = 'teacher')
     or not exists (select 1 from teacher_profiles where profile_id = p_teacher and approved) then
    raise exception 'messaging:not_allowed';
  end if;
  if not (age_cleared(p_student) and age_cleared(p_teacher)) then
    raise exception 'messaging:not_cleared';
  end if;
  if not (messaging_cleared(p_student) and messaging_cleared(p_teacher)) then
    raise exception 'messaging:not_permitted';
  end if;

  insert into conversations (student_id, teacher_id) values (p_student, p_teacher)
  on conflict (student_id, teacher_id) do nothing;

  select id into v_id from conversations where student_id = p_student and teacher_id = p_teacher;
  return v_id;
end;
$$;

-- 'ok', or why not: not_found, not_cleared (platform age/consent gate), not_permitted (no messaging
-- permission: under 18 without the guardian's messaging approval), closed (no relationship any more).
create or replace function messaging_can_send(p_user uuid, p_conversation uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  c conversations%rowtype;
begin
  select * into c from conversations where id = p_conversation;
  if not found or p_user is null or p_user not in (c.student_id, c.teacher_id) then
    return 'not_found';
  end if;
  if not (age_cleared(c.student_id) and age_cleared(c.teacher_id)) then
    return 'not_cleared';
  end if;
  if not (messaging_cleared(c.student_id) and messaging_cleared(c.teacher_id)) then
    return 'not_permitted';
  end if;
  if not messaging_relationship(c.student_id, c.teacher_id) then
    return 'closed';
  end if;
  return 'ok';
end;
$$;

-- ------------------------------------------------------------
-- Privileges: every new function is server-only
-- ------------------------------------------------------------
-- (create or replace keeps the 0011 privileges on the three rewired functions.)

revoke all on function guard_messaging_consent_version() from public, anon, authenticated;
revoke all on function age_in_years_kenya(date, timestamptz) from public, anon, authenticated;
revoke all on function messaging_cleared(uuid, timestamptz) from public, anon, authenticated;
revoke all on function decide_guardian_consent_with_messaging(text, text, text) from public, anon, authenticated;
revoke all on function decide_guardian_messaging_consent(text, text) from public, anon, authenticated;
revoke all on function withdraw_guardian_messaging_consent(uuid) from public, anon, authenticated;

grant execute on function age_in_years_kenya(date, timestamptz) to service_role;
grant execute on function messaging_cleared(uuid, timestamptz) to service_role;
grant execute on function decide_guardian_consent_with_messaging(text, text, text) to service_role;
grant execute on function decide_guardian_messaging_consent(text, text) to service_role;
grant execute on function withdraw_guardian_messaging_consent(uuid) to service_role;
