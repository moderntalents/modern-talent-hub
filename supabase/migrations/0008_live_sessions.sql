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
