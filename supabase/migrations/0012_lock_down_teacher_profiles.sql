-- Modern Talent Hub — lock down teacher_profiles (security fix).
-- Run after 0010_age_and_guardian_consent.sql. Safe to run more than once.
--
-- Two holes in 0001_init.sql, both confirmed on the production database:
--
--   1. "teacher_profile_public_read" (SELECT, role public, using true). Anyone holding the public API key —
--      signed in or not — could read every teacher's wallet_balance, mpesa_number, bank_name, bank_account
--      and payout_method. The comment in 0001 says these columns are "only ever selected server-side", but
--      nothing enforced that.
--
--   2. "teacher_profile_owner" (ALL, no column limits). A teacher could update their OWN row from a browser,
--      including `approved` (skipping admin approval) and `wallet_balance` (forging a balance that the
--      withdrawal check then trusts), and could delete and re-insert their own row with those values.
--      0004 closed the same kind of hole for profiles.role; 0002 closed it for teacher_profiles.activated.
--
-- What legitimately uses this table (checked in the code, so nothing here breaks it):
--   * a teacher READS their own row (dashboard, wallet, activation status)
--   * an admin READS all rows and changes `approved` from their signed-in session (Admin → Teachers)
--   * the SERVER (service role) changes `activated`, credits/debits the wallet through the existing payment
--     and payout triggers, and cleans the row up on account deletion
--   * the signup trigger (handle_new_user) creates the row
--   * no page reads any OTHER person's teacher_profiles row
--
-- After this migration:
--   * a person can read only their own row; admins can read all; the public can read nothing
--   * a teacher can still update their own non-privileged fields (bio, specialty, payout details)
--   * `approved` can be changed only by an administrator
--   * `wallet_balance` can be changed only by the server / SQL — not by any browser session, admins included
--   * nobody can insert or delete a teacher_profiles row from a browser
-- Nothing else is touched.

-- ------------------------------------------------------------
-- Row level security
-- ------------------------------------------------------------

drop policy if exists "teacher_profile_public_read" on teacher_profiles;
drop policy if exists "teacher_profile_owner" on teacher_profiles;
drop policy if exists "teacher_profile_read_own_or_admin" on teacher_profiles;
drop policy if exists "teacher_profile_update_own_or_admin" on teacher_profiles;

create policy "teacher_profile_read_own_or_admin" on teacher_profiles for select
  using (profile_id = auth.uid() or is_admin());

create policy "teacher_profile_update_own_or_admin" on teacher_profiles for update
  using (profile_id = auth.uid() or is_admin())
  with check (profile_id = auth.uid() or is_admin());

-- (No insert or delete policy on purpose: the row is created by the signup trigger and is removed together
-- with the account. Both run as the database owner / service role, which row level security does not apply to.)

-- Supabase grants new tables to the API roles by default. The public key (anon) gets nothing at all, and
-- signed-in users can no longer insert, delete or truncate.
revoke all on teacher_profiles from anon;
revoke insert, delete, truncate on teacher_profiles from authenticated;

-- ------------------------------------------------------------
-- Guard the columns that carry money or trust
-- ------------------------------------------------------------

-- Same idea as guard_teacher_activation_columns (0002) and guard_profile_role (0004). It only restricts calls
-- that come through the API with a user's or visitor's key: the service role, the SQL Editor and the
-- database's own triggers (where auth.role() is 'service_role' or null) are unaffected.
create or replace function guard_teacher_privileged_columns()
returns trigger language plpgsql as $$
begin
  if auth.role() in ('anon', 'authenticated') then
    if new.profile_id is distinct from old.profile_id then
      raise exception 'A teacher record cannot be reassigned.';
    end if;
    if new.wallet_balance is distinct from old.wallet_balance then
      raise exception 'A wallet balance can only be changed by the payment system.';
    end if;
    if new.approved is distinct from old.approved and not is_admin() then
      raise exception 'Teacher approval can only be changed by an administrator.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_teacher_privileged on teacher_profiles;
create trigger trg_guard_teacher_privileged
  before update on teacher_profiles
  for each row execute function guard_teacher_privileged_columns();
