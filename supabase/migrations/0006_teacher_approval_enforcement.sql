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
