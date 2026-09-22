-- ============================================================================
-- Modern Talent Hub — ONE-SHOT DATABASE SETUP
--
-- Paste this whole file into the Supabase SQL Editor (the project whose URL is
-- NEXT_PUBLIC_SUPABASE_URL in Vercel) and click Run ONCE, on an EMPTY database.
-- It is the concatenation of, in order:
--   migrations/0001_init.sql, seed.sql, 0002 ... 0010, 0013
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
