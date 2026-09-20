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
