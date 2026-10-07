-- Modern Talent Hub — student "Find your teacher or coach" directory.
-- Run after 0018_message_edit_delete.sql. Adds NEW objects only; nothing existing is changed.
--
-- Who a student may find (no new permission system — this is the messaging rule from 0011):
--   * A teacher is listed for a student only while the student has an ACTIVE subscription to one of
--     that teacher's activities (messaging_active_subscription: status 'active', not past its period
--     end, and the subscription's teacher is the activity's own teacher).
--   * The teacher must be an approved teacher, and both people must be age-cleared (age_cleared():
--     an adult, or an under-18 whose guardian approved the account) — exactly what _open_conversation()
--     requires before a conversation can exist, so everyone in the list can actually be messaged.
--   * Nothing else counts. A teacher who merely exists, has a published lesson, or is approved but is
--     not connected to the student through a subscription is never returned.
--
-- Security model — the same as messaging: the browser cannot call these functions. The server works
-- out who is asking from the login and calls them with the service role; the rule is checked here in
-- the database on every call, so a bug in application code cannot widen the list.
--
-- What a student can learn about a teacher: id, display name, avatar path, specialty, bio, and the
-- titles of the activities the student is enrolled in with that teacher. Never email, phone, payout
-- details, wallet balance, or anything else from teacher_profiles / profiles.

-- ------------------------------------------------------------
-- The directory (list, search, one teacher)
-- ------------------------------------------------------------

-- p_terms: the search words, already trimmed and split by the server. A teacher matches when EVERY
--          word appears somewhere in their full name, in any order and any capitalisation, so
--          "david", "PAGNI", "pag", "dav pag" and "pagni david" all find "David Pagni". LIKE
--          wildcards typed by the person are treated as plain characters.
-- p_limit: how many rows to return, at most 51 (the server asks for one more than it shows, to
--          know whether there is a next page).
-- p_after_name / p_after_id: where the previous page ended (keyset paging on (sort_name, teacher_id)),
--          so page N costs the same as page 1 and no one loads everyone at once.
-- p_teacher: when set, only that teacher (used by the profile page). The same rule applies, so a
--          teacher the student may not find returns no row — indistinguishable from "no such teacher".
create or replace function student_directory(
  p_student uuid,
  p_terms text[] default '{}',
  p_limit int default 12,
  p_after_name text default null,
  p_after_id uuid default null,
  p_teacher uuid default null
)
returns table (
  teacher_id uuid,
  sort_name text,
  full_name text,
  avatar_url text,
  specialty text,
  bio text,
  activities jsonb,
  conversation_id uuid
)
language sql stable security definer set search_path = public as $$
  with mine as (
    -- The student's own active enrolments, grouped by teacher.
    select s.teacher_id,
           jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title) order by a.title, a.id) as activities
    from subscriptions s
    join activities a on a.id = s.activity_id and a.teacher_id = s.teacher_id
    where s.student_id = p_student
      and s.status = 'active'
      and (s.current_period_end is null or s.current_period_end > now())
      and (p_teacher is null or s.teacher_id = p_teacher)
    group by s.teacher_id
  )
  select p.id,
         lower(p.full_name),
         p.full_name,
         p.avatar_url,
         tp.specialty,
         tp.bio,
         mine.activities,
         c.id
  from mine
  join profiles p on p.id = mine.teacher_id and p.role = 'teacher'
  join teacher_profiles tp on tp.profile_id = p.id
  left join conversations c on c.student_id = p_student and c.teacher_id = p.id
  where exists (select 1 from profiles ps where ps.id = p_student and ps.role = 'student')
    -- the very same checks that start_conversation_as_teacher / _open_conversation make
    and messaging_relationship(p_student, p.id)
    and age_cleared(p_student)
    and age_cleared(p.id)
    and not exists (
      select 1
      from unnest((coalesce(p_terms, '{}'::text[]))[1:5]) as t(term)
      where t.term <> ''
        and p.full_name not ilike '%' || replace(replace(replace(t.term, '\', '\\'), '%', '\%'), '_', '\_') || '%' escape '\'
    )
    and (p_after_name is null or (lower(p.full_name), p.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  order by lower(p.full_name), p.id
  limit least(greatest(coalesce(p_limit, 12), 1), 51);
$$;

-- Keeps the ordering above cheap however many teachers there are.
create index if not exists profiles_teacher_name_idx on profiles (lower(full_name), id) where role = 'teacher';

-- ------------------------------------------------------------
-- Messaging a teacher from the directory
-- ------------------------------------------------------------

-- Student → a teacher they have an active subscription with. The mirror of
-- start_conversation_as_teacher(): the subscription is the relationship, and _open_conversation()
-- gets or creates THE ONE conversation for the pair (unique (student_id, teacher_id)), so pressing
-- "Message" twice, or from two devices, can never produce a second conversation.
create or replace function start_conversation_as_student(p_student uuid, p_teacher uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not messaging_active_subscription(p_student, p_teacher) then
    raise exception 'messaging:not_allowed';
  end if;
  return _open_conversation(p_student, p_teacher);
end;
$$;

-- ------------------------------------------------------------
-- Privileges: server (service role) only
-- ------------------------------------------------------------

revoke all on function student_directory(uuid, text[], int, text, uuid, uuid) from public, anon, authenticated;
revoke all on function start_conversation_as_student(uuid, uuid) from public, anon, authenticated;

grant execute on function student_directory(uuid, text[], int, text, uuid, uuid) to service_role;
grant execute on function start_conversation_as_student(uuid, uuid) to service_role;
