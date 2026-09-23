-- ============================================================================
-- Modern Talent Hub — ONE-SHOT DATABASE SETUP
--
-- Paste this whole file into the Supabase SQL Editor (the project whose URL is
-- NEXT_PUBLIC_SUPABASE_URL in Vercel) and click Run ONCE, on an EMPTY database.
-- It is the concatenation of, in order:
--   migrations/0001_init.sql, seed.sql, 0002 ... 0010, 0012, 0013, 0015, 0016, 0017
-- (0011 and 0014 belong to the separate messaging work and are not part of
-- this branch.)
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
-- ## migrations/0012_lock_down_teacher_profiles.sql
-- ############################################################################

-- Modern Talent Hub — lock down teacher_profiles (security fix).
-- Run after 0010_age_and_guardian_consent.sql. Safe to run more than once.
--
-- Two holes in 0001_init.sql, both confirmed on the production database:
--
--   1. "teacher_profile_public_read" (SELECT, role public, using true). Anyone holding the public API key —
--      signed in or not — could read every teacher's wallet_balance, mpesa_number, bank_name, bank_account
--      and payout_method. The comment in 0001 says these columns are "only ever selected server-side", but
--      nothing enforced that.
--
--   2. "teacher_profile_owner" (ALL, no column limits). A teacher could update their OWN row from a browser,
--      including `approved` (skipping admin approval) and `wallet_balance` (forging a balance that the
--      withdrawal check then trusts), and could delete and re-insert their own row with those values.
--      0004 closed the same kind of hole for profiles.role; 0002 closed it for teacher_profiles.activated.
--
-- What legitimately uses this table (checked in the code, so nothing here breaks it):
--   * a teacher READS their own row (dashboard, wallet, activation status)
--   * an admin READS all rows and changes `approved` from their signed-in session (Admin → Teachers)
--   * the SERVER (service role) changes `activated`, credits/debits the wallet through the existing payment
--     and payout triggers, and cleans the row up on account deletion
--   * the signup trigger (handle_new_user) creates the row
--   * no page reads any OTHER person's teacher_profiles row
--
-- After this migration:
--   * a person can read only their own row; admins can read all; the public can read nothing
--   * a teacher can still update their own non-privileged fields (bio, specialty, payout details)
--   * `approved` can be changed only by an administrator
--   * `wallet_balance` can be changed only by the server / SQL — not by any browser session, admins included
--   * nobody can insert or delete a teacher_profiles row from a browser
-- Nothing else is touched.

-- ------------------------------------------------------------
-- Row level security
-- ------------------------------------------------------------

drop policy if exists "teacher_profile_public_read" on teacher_profiles;
drop policy if exists "teacher_profile_owner" on teacher_profiles;
drop policy if exists "teacher_profile_read_own_or_admin" on teacher_profiles;
drop policy if exists "teacher_profile_update_own_or_admin" on teacher_profiles;

create policy "teacher_profile_read_own_or_admin" on teacher_profiles for select
  using (profile_id = auth.uid() or is_admin());

create policy "teacher_profile_update_own_or_admin" on teacher_profiles for update
  using (profile_id = auth.uid() or is_admin())
  with check (profile_id = auth.uid() or is_admin());

-- (No insert or delete policy on purpose: the row is created by the signup trigger and is removed together
-- with the account. Both run as the database owner / service role, which row level security does not apply to.)

-- Supabase grants new tables to the API roles by default. The public key (anon) gets nothing at all, and
-- signed-in users can no longer insert, delete or truncate.
revoke all on teacher_profiles from anon;
revoke insert, delete, truncate on teacher_profiles from authenticated;

-- ------------------------------------------------------------
-- Guard the columns that carry money or trust
-- ------------------------------------------------------------

-- Same idea as guard_teacher_activation_columns (0002) and guard_profile_role (0004). It only restricts calls
-- that come through the API with a user's or visitor's key: the service role, the SQL Editor and the
-- database's own triggers (where auth.role() is 'service_role' or null) are unaffected.
create or replace function guard_teacher_privileged_columns()
returns trigger language plpgsql as $$
begin
  if auth.role() in ('anon', 'authenticated') then
    if new.profile_id is distinct from old.profile_id then
      raise exception 'A teacher record cannot be reassigned.';
    end if;
    if new.wallet_balance is distinct from old.wallet_balance then
      raise exception 'A wallet balance can only be changed by the payment system.';
    end if;
    if new.approved is distinct from old.approved and not is_admin() then
      raise exception 'Teacher approval can only be changed by an administrator.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_teacher_privileged on teacher_profiles;
create trigger trg_guard_teacher_privileged
  before update on teacher_profiles
  for each row execute function guard_teacher_privileged_columns();


-- ############################################################################
-- ## migrations/0013_payment_state_machine_and_ledger.sql
-- ############################################################################

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


-- ############################################################################
-- ## migrations/0015_hide_payer_phone.sql
-- ############################################################################

-- Modern Talent Hub — hide the payer's phone number from browsers (privacy fix for Phase 2A).
-- Run after 0013_payment_state_machine_and_ledger.sql. Safe to run more than once.
-- (Numbered 0015 because 0014 is already used by the separate messaging work.)
--
-- Phase 2A stores the number the STK prompt was sent to in payment_transactions.phone, and the number a
-- callback reports in callback_phone. The existing read policy (transactions_read_own, 0001) lets the COACH
-- read every column of their students' payment rows, so a coach could read the payer's number — often a
-- child's or a parent's. 0013 said this must be closed in the same release that starts storing the numbers,
-- with "explicit column lists in those pages plus column-level privileges". That is exactly what this does.
--
-- After this migration:
--   * No browser session (student, coach or admin) can select phone or callback_phone directly. Every other
--     column stays readable exactly as before, still limited to the rows the existing policy allows.
--   * The paying student, and administrators, can still see a payment's numbers through
--     payment_payer_phone(), which checks who is asking. A coach gets nothing from it.
--   * The server (service role) is unchanged: it still reads and writes both columns for verification and
--     reconciliation. The columns themselves are unchanged and nothing is deleted.
--
-- Fail-closed note: a column added to payment_transactions later is NOT readable by browsers until it is
-- added to the grant below.

revoke select on payment_transactions from authenticated;
grant select (
  id, subscription_id, student_id, teacher_id, amount, currency, provider, provider_reference,
  checkout_request_id, status, teacher_share, platform_share, created_at, completed_at,
  expected_amount, merchant_request_id, result_code, result_desc, callback_amount, paid_at, confirmed_via,
  callback_received_at, last_queried_at, query_attempts, teacher_pct, platform_pct, credited_at,
  needs_review, phone_mismatch
) on payment_transactions to authenticated;

-- The payer's numbers for ONE payment, for the paying student or an administrator only. Anyone else — the
-- coach included — gets no row, exactly as if the payment did not exist.
create or replace function payment_payer_phone(p_transaction uuid)
returns table (phone text, callback_phone text)
language sql stable security definer set search_path = public as $$
  select pt.phone, pt.callback_phone
  from payment_transactions pt
  where pt.id = p_transaction
    and auth.uid() is not null
    and (pt.student_id = auth.uid() or is_admin());
$$;

revoke all on function payment_payer_phone(uuid) from public, anon;
grant execute on function payment_payer_phone(uuid) to authenticated, service_role;




-- ############################################################################
-- ## migrations/0016_coach_b2c_withdrawal.sql
-- ############################################################################

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


-- ############################################################################
-- ## migrations/0017_b2c_reconciliation.sql
-- ############################################################################
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

