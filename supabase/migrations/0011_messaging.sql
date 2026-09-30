-- Modern Talent Hub — student ↔ teacher messaging, with PDF homework attachments.
-- Run after 0010_age_and_guardian_consent.sql. Adds NEW objects only; nothing existing is changed.
--
-- Who may talk to whom (decided with the site owner):
--   * The ONLY student–teacher relationship is an ACTIVE activity subscription, and the database
--     checks that it belongs to exactly this student, this activity and this activity's teacher.
--     "Active" = status 'active' and not past current_period_end (an empty end date — free,
--     one-time and per-lesson billing — stays active until the subscription is cancelled).
--     A published lesson on its own is NOT a relationship.
--   * Both people must have an approved account (age_cleared(): an adult, or an under-18 whose
--     parent or guardian approved the account under 0010). There is no separate messaging consent.
--   * A STUDENT can start a conversation with the teacher of an activity they are actively
--     subscribed to.
--   * A TEACHER can start a conversation with an actively subscribed student only if that student
--     is 18 or over (Kenyan date, worked out at the moment of the attempt). With an under-18
--     student the teacher never starts: they can write only after the student has sent the first
--     message in the conversation.
--   * When the subscription ends (or the teacher loses approval) nothing is deleted: no new
--     conversation can be started and existing ones become read-only.
--   * No student-to-student or teacher-to-teacher conversations. Admins get NO in-app access to
--     messages or attachments.
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

-- Does this student have an ACTIVE subscription with this teacher — optionally to one specific
-- activity? The subscription's teacher must be the activity's own teacher, so a row that names
-- the wrong teacher never counts. Active = status 'active' and not past its period end; an empty
-- end date (free, one-time and per-lesson billing) stays active until the subscription is cancelled.
create or replace function messaging_active_subscription(p_student uuid, p_teacher uuid, p_activity uuid default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from subscriptions s
    join activities a on a.id = s.activity_id
    where s.student_id = p_student
      and s.teacher_id = p_teacher
      and a.teacher_id = p_teacher
      and (p_activity is null or s.activity_id = p_activity)
      and s.status = 'active'
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;

-- Is there a live student–teacher relationship? The teacher must be approved, and the student
-- must have an active subscription to one of that teacher's activities. (A published lesson is
-- not a relationship: any signed-in student can open those.)
create or replace function messaging_relationship(p_student uuid, p_teacher uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from teacher_profiles tp where tp.profile_id = p_teacher and tp.approved)
     and messaging_active_subscription(p_student, p_teacher);
$$;

-- Is this person under 18 on the Kenyan (Africa/Nairobi) calendar date of p_at? Same rule as
-- lib/age.ts ageInYears(): the 18th birthday counts once today's (month, day) reaches the birth
-- (month, day), so someone born on 29 February turns 18 on 1 March in a non-leap year. Worked out
-- from the stored date of birth at the moment of every check — never from consent_status, which
-- stays 'granted' after 18. No age record counts as under 18 (fails closed).
create or replace function messaging_is_minor(p_profile uuid, p_at timestamptz default now())
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select ar.date_of_birth > ((p_at at time zone 'Africa/Nairobi')::date - interval '18 years')::date
    from age_records ar
    where ar.profile_id = p_profile
  ), true);
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
-- Starting a conversation (two, and only two, ways)
-- ------------------------------------------------------------

-- Student, from an activity page: the activity must be published, and the student must have an
-- active subscription to exactly this activity, with exactly this activity's teacher. The teacher
-- is taken from the activity itself, never from the caller.
create or replace function start_conversation_from_activity(p_student uuid, p_activity uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_teacher uuid;
begin
  select a.teacher_id into v_teacher from activities a where a.id = p_activity and a.status = 'published';
  if v_teacher is null or not messaging_active_subscription(p_student, v_teacher, p_activity) then
    raise exception 'messaging:not_allowed';
  end if;
  return _open_conversation(p_student, v_teacher);
end;
$$;

-- Teacher, with one of their own active subscribers — and only if that student is 18 or over
-- right now. A teacher never starts a conversation with an under-18 student (the student may
-- start one; see messaging_can_send() for when the teacher may then write).
create or replace function start_conversation_as_teacher(p_teacher uuid, p_student uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not messaging_active_subscription(p_student, p_teacher) then
    raise exception 'messaging:not_allowed';
  end if;
  if messaging_is_minor(p_student) then
    raise exception 'messaging:minor_student';
  end if;
  return _open_conversation(p_student, p_teacher);
end;
$$;

-- The students a teacher may start a conversation with right now: approved (age-cleared) students
-- aged 18 or over with an active subscription to one of this approved teacher's activities. Used
-- for the teacher's "start a conversation" list, so the list and start_conversation_as_teacher()
-- apply the same rule. Returns ids only — never an age or a date of birth.
create or replace function messaging_teacher_startable_students(p_teacher uuid)
returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct s.student_id
  from subscriptions s
  join profiles p on p.id = s.student_id and p.role = 'student'
  where s.teacher_id = p_teacher
    and exists (select 1 from teacher_profiles tp where tp.profile_id = p_teacher and tp.approved)
    and age_cleared(p_teacher)
    and messaging_active_subscription(s.student_id, p_teacher)
    and age_cleared(s.student_id)
    and not messaging_is_minor(s.student_id);
$$;

-- ------------------------------------------------------------
-- Sending
-- ------------------------------------------------------------

-- 'ok', or why not: not_found (no such conversation, or the person isn't in it), not_cleared
-- (an account isn't approved), closed (the relationship no longer exists, so the thread is
-- read-only), awaiting_student (the student is under 18 and hasn't written yet, so the teacher
-- has to wait for the student's first message).
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
  if p_user = c.teacher_id
     and messaging_is_minor(c.student_id)
     and not exists (select 1 from messages m where m.conversation_id = c.id and m.sender_id = c.student_id) then
    return 'awaiting_student';
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
revoke all on function messaging_active_subscription(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function messaging_relationship(uuid, uuid) from public, anon, authenticated;
revoke all on function messaging_is_minor(uuid, timestamptz) from public, anon, authenticated;
revoke all on function _open_conversation(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function start_conversation_from_activity(uuid, uuid) from public, anon, authenticated;
revoke all on function start_conversation_as_teacher(uuid, uuid) from public, anon, authenticated;
revoke all on function messaging_teacher_startable_students(uuid) from public, anon, authenticated;
revoke all on function messaging_can_send(uuid, uuid) from public, anon, authenticated;
revoke all on function send_message(uuid, uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function attachment_in_use(text) from public, anon, authenticated;
revoke all on function messaging_conversation_ids(uuid) from public, anon, authenticated;
revoke all on function delete_user_messages(uuid) from public, anon, authenticated;
revoke all on function caller_can_read_conversation(uuid) from public;

grant execute on function age_cleared(uuid) to service_role;
grant execute on function messaging_active_subscription(uuid, uuid, uuid) to service_role;
grant execute on function messaging_relationship(uuid, uuid) to service_role;
grant execute on function messaging_is_minor(uuid, timestamptz) to service_role;
grant execute on function start_conversation_from_activity(uuid, uuid) to service_role;
grant execute on function start_conversation_as_teacher(uuid, uuid) to service_role;
grant execute on function messaging_teacher_startable_students(uuid) to service_role;
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
