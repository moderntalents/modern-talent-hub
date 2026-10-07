-- Modern Talent Hub — coach profile pictures.
-- Run after 0019_student_teacher_directory.sql. Safe to run more than once.
--
-- Until now the "avatars" storage bucket was public, any signed-in person could upload ANYTHING (any
-- type, any size) into their own folder straight from the browser, and anyone could change their own
-- profiles.avatar_url to any text. Nothing in the app used either. Now that students see coaches'
-- pictures, both are closed and the upload goes through the server, the same way message PDFs do:
--
--   1. The server (service role) hands a coach a ONE-TIME upload link for a path the server chose
--      (<coach id>/<random id>.jpg|png|webp). The browser never picks a path.
--   2. The server looks at what was actually uploaded — real file type, size, and image dimensions —
--      and deletes it if it isn't a normal JPEG, PNG or WebP photo.
--   3. Only then does it call set_profile_avatar(), which records the path on the coach's profile.
--      Replacing or removing a picture deletes the old file, so nothing piles up.
--
-- After this migration:
--   * the bucket accepts only JPEG, PNG and WebP, at most 1 MB per file (the app shrinks photos to
--     about 512 pixels before uploading, so real photos are far smaller)
--   * the browser can neither write to the bucket nor list it. Pictures are still served from the
--     bucket's public web address, which is how students' browsers load them
--   * profiles.avatar_url can be changed only by the server (service role / SQL), never from a browser
--     session — so nobody can point a profile at an outside web address or someone else's file
--   * only a TEACHER (coach) account can have a picture

-- ------------------------------------------------------------
-- The bucket
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 0001 let every signed-in user write anything into their own folder, and let everyone list the whole
-- bucket. A public bucket does not need a read policy to serve files, so removing it only stops
-- listing; and uploads now use server-issued links, which need no policy.
drop policy if exists "avatars_owner_write" on storage.objects;
drop policy if exists "avatars_public_read" on storage.objects;

-- ------------------------------------------------------------
-- profiles.avatar_url: server only
-- ------------------------------------------------------------

-- Same idea as guard_profile_role (0004): only calls that come through the API with a visitor's or a
-- signed-in user's key are restricted. The service role, the SQL Editor and the database's own
-- triggers (where auth.role() is 'service_role' or null) are unaffected.
create or replace function guard_profile_avatar()
returns trigger language plpgsql as $$
begin
  if new.avatar_url is distinct from old.avatar_url and auth.role() in ('anon', 'authenticated') then
    raise exception 'A profile picture can only be changed from the profile picture settings.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile_avatar on profiles;
create trigger trg_guard_profile_avatar
  before update on profiles
  for each row execute function guard_profile_avatar();

-- ------------------------------------------------------------
-- Setting and removing a picture (server / service role only)
-- ------------------------------------------------------------

-- Records the picture a coach has just uploaded and returns the one it replaces (or null), so the
-- server can delete that old file. The path must be exactly <this coach's id>/<uuid>.jpg|png|webp —
-- the only shape of path the server ever creates — so a profile can never point at another person's
-- file or at anything outside the bucket. Failures are raised as "avatar:<reason>".
create or replace function set_profile_avatar(p_user uuid, p_path text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_old text;
begin
  if p_user is null or not exists (select 1 from profiles where id = p_user and role = 'teacher') then
    raise exception 'avatar:not_allowed';
  end if;
  if p_path is null
     or p_path !~ ('^' || p_user::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$') then
    raise exception 'avatar:bad_path';
  end if;

  select avatar_url into v_old from profiles where id = p_user for update;
  update profiles set avatar_url = p_path where id = p_user;
  return v_old;
end;
$$;

-- Removes the coach's picture and returns the path it had (or null).
create or replace function clear_profile_avatar(p_user uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_old text;
begin
  if p_user is null or not exists (select 1 from profiles where id = p_user and role = 'teacher') then
    raise exception 'avatar:not_allowed';
  end if;
  select avatar_url into v_old from profiles where id = p_user for update;
  update profiles set avatar_url = null where id = p_user;
  return v_old;
end;
$$;

revoke all on function set_profile_avatar(uuid, text) from public, anon, authenticated;
revoke all on function clear_profile_avatar(uuid) from public, anon, authenticated;
grant execute on function set_profile_avatar(uuid, text) to service_role;
grant execute on function clear_profile_avatar(uuid) to service_role;
