-- Modern Talent Hub — teacher-first discovery for Subjects and Activities.
-- Run after 0022_remove_coach_activation_fee.sql (or 0021 — they do not depend on each other). Safe to run more than once.
--
-- When a student opens "Subjects" or "Activities" they now see PEOPLE first: every teacher (Subjects) or
-- coach (Activities), and can narrow that to the ones who offer one subject or one activity. This extends
-- student_directory() (0021) with three optional filters, so the same rule decides who may be found:
--
--   p_offer       'subjects'   -> only people with at least one PUBLISHED lesson   (the "All Teachers" list)
--                 'activities' -> only people with at least one PUBLISHED activity  (the "All Coaches" list)
--                 null         -> everyone the directory already shows (unchanged)
--                 anything else returns nobody.
--   p_subject     a subjects.id: only people with a PUBLISHED lesson in that subject.
--   p_activities  activity names/ids (any capitalisation), e.g. {Karate,karate}: only people with a PUBLISHED
--                 activity of that type. activities.activity_type holds the activity's display name ("Karate").
--                 null = no filter; an empty list matches nobody.
--
-- p_terms (the search words) now match name, specialty, subject names and activity title/type — see the
-- "Search" note in the function. Name-only searches behave as before.
--
-- Nothing is hard-coded: a teacher is under a subject because they published a lesson in it, and under an
-- activity because they published that activity. A coach who offers Karate and Taekwondo appears under both;
-- ten teachers with Mathematics lessons all appear under Mathematics.
--
-- New column: subjects = up to 6 {id, name} of the subjects they have published lessons in (by name).
-- What a student can learn about a person is otherwise unchanged (no email, phone, payout or wallet data),
-- and the function is still callable by the service role only.

drop function if exists student_directory(uuid, text[], int, text, uuid, uuid);
drop function if exists student_directory(uuid, text[], int, text, uuid, uuid, text, uuid, text[]);

create or replace function student_directory(
  p_student uuid,
  p_terms text[] default '{}',
  p_limit int default 12,
  p_after_name text default null,
  p_after_id uuid default null,
  p_teacher uuid default null,
  p_offer text default null,
  p_subject uuid default null,
  p_activities text[] default null
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
  can_message boolean,
  subjects jsonb
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
         messaging_relationship(p_student, p.id),
         coalesce(ps.items, '[]'::jsonb)
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
  left join lateral (
    select count(*) as n,
           jsonb_agg(jsonb_build_object('id', y.id, 'name', y.name) order by y.name, y.id) as items
    from (
      select s.id, s.name
      from subjects s
      where exists (
        select 1 from lessons l where l.teacher_id = p.id and l.status = 'published' and l.subject_id = s.id
      )
      order by s.name, s.id
      limit 6
    ) y
  ) ps on true
  left join conversations c on c.student_id = p_student and c.teacher_id = p.id
  where p.role = 'teacher'
    and exists (select 1 from profiles st where st.id = p_student and st.role = 'student')
    and age_cleared(p_student)
    and age_cleared(p.id)
    and (p_teacher is null or p.id = p_teacher)
    -- something students can already see
    and (pa.n > 0 or exists (select 1 from lessons l where l.teacher_id = p.id and l.status = 'published'))
    -- "All Teachers" / "All Coaches"
    and (
      p_offer is null
      or (p_offer = 'subjects' and exists (select 1 from lessons l where l.teacher_id = p.id and l.status = 'published'))
      or (p_offer = 'activities' and pa.n > 0)
    )
    -- offers this subject
    and (
      p_subject is null
      or exists (select 1 from lessons l where l.teacher_id = p.id and l.status = 'published' and l.subject_id = p_subject)
    )
    -- offers this activity
    and (
      p_activities is null
      or exists (
        select 1 from activities a
        where a.teacher_id = p.id and a.status = 'published'
          and lower(btrim(a.activity_type)) in (select lower(btrim(w)) from unnest(p_activities) as w)
      )
    )
    -- Search: EVERY typed word must match somewhere in what the student can already see about the person —
    -- their name, specialty, the name of a subject they have a published lesson in, or the title/type of a
    -- published activity (any order, any capitalisation, partial words fine). One row per person, so a
    -- person who matches through several fields still appears once. LIKE wildcards typed by the person
    -- are plain characters.
    and not exists (
      select 1
      from unnest((coalesce(p_terms, '{}'::text[]))[1:5]) as t(term)
      cross join lateral (
        select '%' || replace(replace(replace(t.term, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
      ) k
      where t.term <> ''
        and not (
          p.full_name ilike k.pat escape '\'
          or coalesce(tp.specialty, '') ilike k.pat escape '\'
          or exists (
            select 1
            from lessons l join subjects s on s.id = l.subject_id
            where l.teacher_id = p.id and l.status = 'published' and s.name ilike k.pat escape '\'
          )
          or exists (
            select 1
            from activities a
            where a.teacher_id = p.id and a.status = 'published'
              and (a.title ilike k.pat escape '\' or a.activity_type ilike k.pat escape '\')
          )
        )
    )
    and (p_after_name is null or (lower(p.full_name), p.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  order by lower(p.full_name), p.id
  limit least(greatest(coalesce(p_limit, 12), 1), 51);
$$;

-- Keep "who offers this subject / activity" cheap however many lessons and activities exist.
create index if not exists lessons_published_subject_idx on lessons (subject_id, teacher_id) where status = 'published';
create index if not exists activities_published_type_idx on activities (lower(btrim(activity_type)), teacher_id) where status = 'published';

revoke all on function student_directory(uuid, text[], int, text, uuid, uuid, text, uuid, text[]) from public, anon, authenticated;
grant execute on function student_directory(uuid, text[], int, text, uuid, uuid, text, uuid, text[]) to service_role;
