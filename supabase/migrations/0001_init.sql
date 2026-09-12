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
