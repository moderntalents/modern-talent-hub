-- Modern Talent Hub — let students discover coaches and teachers without first subscribing.
-- Run after 0020_profile_pictures.sql. Safe to run more than once.
--
-- 0019 listed only the teachers a student was already subscribed to. That made the directory useless
-- for finding someone NEW. This replaces student_directory() so a student can browse every teacher or
-- coach that the platform already shows to students — and nobody else:
--
--   * the teacher is approved (teacher_profiles.approved, set by an administrator), and finished account
--     setup (age_cleared(), the same Stage 2 rule messaging uses), and
--   * they have something students can already see: at least one PUBLISHED activity or PUBLISHED lesson.
--     (Published activities already show the teacher's name to every signed-in student in the Activities
--     list, so the directory reveals nothing new about who they are.)
--
-- A teacher who is unapproved, hasn't finished setup, or has nothing published is never returned. A
-- student whose own account setup is incomplete sees nobody.
--
-- What a student can learn about a teacher is unchanged: id, display name, picture path, specialty, bio and
-- the titles of their published activities. Never email, phone, payout details, wallet or any other column.
--
-- Messaging is NOT loosened. 0011 says the only student–teacher relationship is an active activity
-- subscription, so the list says, per teacher, whether the student can message them today (can_message) —
-- and start_conversation_as_student() from 0019 still enforces that on every call. A student who has no
-- subscription gets "View profile" and the teacher's activities instead of a Message button.
--
-- Same security model as before: service role only, checked in the database on every call. The browser
-- cannot call this function.

drop function if exists student_directory(uuid, text[], int, text, uuid, uuid);

-- p_terms:       search words, already trimmed and split by the server. A teacher matches when EVERY word
--                appears somewhere in their full name (any order, any capitalisation, partial words fine).
--                LIKE wildcards typed by the person are plain characters.
-- p_limit:       at most 51 rows (the server asks for one more than it shows, to know if there is a next page).
-- p_after_name / p_after_id: where the previous page ended (keyset paging), so page N costs like page 1.
-- p_teacher:     when set, only that teacher (the profile page). The same rule applies, so a teacher the
--                student may not find is indistinguishable from "no such teacher".
-- kind:          'Coach' when they have a published activity, otherwise 'Teacher' (lessons only).
-- activities:    up to 6 of their published activities (id, title), by title.
-- conversation_id / can_message: THIS student's existing conversation with them, and whether they may message today.
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
  kind text,
  activities jsonb,
  conversation_id uuid,
  can_message boolean
)
language sql stable security definer set search_path = public as $$
  select p.id,
         lower(p.full_name),
         p.full_name,
         p.avatar_url,
         tp.specialty,
         tp.bio,
         case when pa.n > 0 then 'Coach' else 'Teacher' end,
         coalesce(pa.items, '[]'::jsonb),
         c.id,
         messaging_relationship(p_student, p.id)
  from profiles p
  join teacher_profiles tp on tp.profile_id = p.id and tp.approved
  left join lateral (
    select count(*) as n,
           jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title) order by x.title, x.id) as items
    from (
      select a.id, a.title
      from activities a
      where a.teacher_id = p.id and a.status = 'published'
      order by a.title, a.id
      limit 6
    ) x
  ) pa on true
  left join conversations c on c.student_id = p_student and c.teacher_id = p.id
  where p.role = 'teacher'
    and exists (select 1 from profiles ps where ps.id = p_student and ps.role = 'student')
    and age_cleared(p_student)
    and age_cleared(p.id)
    and (p_teacher is null or p.id = p_teacher)
    -- something students can already see
    and (pa.n > 0 or exists (select 1 from lessons l where l.teacher_id = p.id and l.status = 'published'))
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

-- Keep "does this teacher have anything published" cheap however many activities and lessons exist.
create index if not exists activities_published_teacher_idx on activities (teacher_id) where status = 'published';
create index if not exists lessons_published_teacher_idx on lessons (teacher_id) where status = 'published';

revoke all on function student_directory(uuid, text[], int, text, uuid, uuid) from public, anon, authenticated;
grant execute on function student_directory(uuid, text[], int, text, uuid, uuid) to service_role;
