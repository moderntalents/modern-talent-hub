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
