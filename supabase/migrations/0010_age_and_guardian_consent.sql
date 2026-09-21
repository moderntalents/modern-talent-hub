-- Modern Talent Hub — Stage 2: age check and parent/guardian consent.
-- Run after 0009_delete_user_identities.sql.
--
-- Everyone gives a date of birth. Anyone under 18 (Kenya's Data Protection Act treats
-- them as children) needs a parent or guardian to approve through an emailed link before
-- they can use the app. Nothing existing is changed or deleted: people who already have
-- an account simply have no age record yet, and are asked for one at their next login.
--
-- Security model: these tables are WRITTEN ONLY by server code (service role). A signed-in
-- user can read their own age record, so the app can show the right screen, but no
-- policy lets anyone insert or update, so nobody can approve themselves.

create table age_records (
  profile_id         uuid primary key references profiles(id) on delete cascade,
  date_of_birth      date not null,
  guardian_email     text,
  consent_status     text not null check (consent_status in ('not_required', 'pending', 'granted', 'declined')),
  consent_decided_at timestamptz,
  created_at         timestamptz not null default now(),
  -- A guardian is on record for every status except "not_required" (adults).
  constraint age_records_guardian_present check (consent_status = 'not_required' or guardian_email is not null)
);

alter table age_records enable row level security;

create policy "age_records_read_own" on age_records for select
  using (profile_id = auth.uid());

-- One row per consent email sent. Only a one-way hash of the secret in the email link is
-- stored, so a database leak cannot be used to approve anyone.
create table guardian_consent_requests (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references profiles(id) on delete cascade,
  guardian_email text not null,
  token_hash     text not null unique,
  expires_at     timestamptz not null,
  decided_at     timestamptz,
  decision       text check (decision in ('approved', 'declined')),
  created_at     timestamptz not null default now()
);

create index guardian_consent_requests_profile_idx on guardian_consent_requests (profile_id);

-- RLS on with NO policies: only the service role (server code) can touch it.
alter table guardian_consent_requests enable row level security;

-- Records the guardian's decision. Atomic: the request is checked and consumed, and the
-- child's status updated, in one transaction. Returns one of:
--   approved | declined   the decision was recorded
--   used | expired        the link was already used / is too old
--   invalid               unknown link, bad decision, or the request is no longer current
--                         (for example the child changed the guardian's email address)
create or replace function decide_guardian_consent(p_token_hash text, p_decision text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  r guardian_consent_requests;
begin
  if p_decision is null or p_decision not in ('approved', 'declined') then
    return 'invalid';
  end if;

  select * into r from guardian_consent_requests where token_hash = p_token_hash for update;
  if not found then return 'invalid'; end if;
  if r.decided_at is not null then return 'used'; end if;
  if r.expires_at < now() then return 'expired'; end if;

  -- Only the CURRENT request for a still-pending account counts.
  if not exists (
    select 1 from age_records
    where profile_id = r.profile_id
      and consent_status = 'pending'
      and lower(guardian_email) = lower(r.guardian_email)
  ) then
    return 'invalid';
  end if;

  update guardian_consent_requests set decided_at = now(), decision = p_decision where id = r.id;

  update age_records
  set consent_status = case when p_decision = 'approved' then 'granted' else 'declined' end,
      consent_decided_at = now()
  where profile_id = r.profile_id;

  return p_decision;
end;
$$;

revoke all on function decide_guardian_consent(text, text) from public, anon, authenticated;
grant execute on function decide_guardian_consent(text, text) to service_role;
