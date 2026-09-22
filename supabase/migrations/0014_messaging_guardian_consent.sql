-- Modern Talent Hub — separate parent/guardian permission for private messaging.
-- Run after 0011_messaging.sql. Safe to run once; re-running errors on "already exists" (harmless).
--
-- Why: the Stage 2 guardian consent page (wording "guardian-v1") told parents "there are no private
-- messages between users". 0011 then added student ↔ teacher messaging. A v1 approval therefore never
-- covered messaging, so it cannot be used as permission for it.
--
-- The rule from here on (approved policy):
--   * 18 or over (Kenya date, worked out when access is checked) and platform consent in place
--     ('not_required' or 'granted')  -> messaging allowed automatically. This holds even if a guardian
--     earlier declined or withdrew MESSAGING permission while the student was under 18.
--   * Under 18 -> messaging needs its OWN guardian permission, given on wording that covers it
--     ("guardian-v2" or later). Approving the platform alone is not enough.
--   * Declining or withdrawing messaging never changes platform consent (age_records.consent_status)
--     and never deletes the account. It only switches messaging off.
--
-- What is NOT changed: age_records.consent_status and its meaning, decide_guardian_consent() and
-- age_cleared() are left exactly as 0010/0011 define them. Nothing from the M-Pesa / payment
-- migrations is touched. The only existing objects replaced are the three 0011 messaging functions
-- that decide who may see or use a conversation; their relationship and security rules are kept
-- line for line, with age_cleared() swapped for messaging_cleared().
--
-- Existing data: every existing row starts with messaging permission OFF. Existing under-18 students
-- (approved on v1 wording) keep using the platform but must ask their parent/guardian for messaging.
-- Adults are unaffected, because messaging_cleared() lets them through on age alone.

-- ------------------------------------------------------------
-- Consent wording versions (server-only reference table)
-- ------------------------------------------------------------

create table guardian_consent_versions (
  version          text primary key,
  covers_messaging boolean not null,
  summary          text not null,
  introduced_at    timestamptz not null default now()
);

alter table guardian_consent_versions enable row level security;
-- No policies and no API privileges: only the server (service role) and the database itself read it.
revoke all on guardian_consent_versions from anon, authenticated;

insert into guardian_consent_versions (version, covers_messaging, summary) values
  ('guardian-v1', false,
   'Stage 2 wording: permission to use the platform. Stated there are no private messages between users; does NOT cover messaging.'),
  ('guardian-v2', true,
   'Permission to use the platform, plus a separate, optional choice to allow private messages (with PDF homework) between the young person and their teachers.');

-- ------------------------------------------------------------
-- age_records: guardian messaging permission, separate from platform consent
-- ------------------------------------------------------------

alter table age_records
  add column guardian_messaging_allowed    boolean not null default false,
  add column guardian_messaging_status     text not null default 'not_requested'
    check (guardian_messaging_status in ('not_requested', 'granted', 'declined', 'withdrawn')),
  add column guardian_messaging_version    text references guardian_consent_versions(version),
  add column guardian_messaging_decided_at timestamptz,
  add constraint age_records_messaging_consistent
    check (guardian_messaging_allowed = (guardian_messaging_status = 'granted'));

-- ------------------------------------------------------------
-- guardian_consent_requests: what the request is for, which wording, and the messaging answer
-- ------------------------------------------------------------

-- Existing rows (and any request still created by pre-0014 app code) were sent with the v1 wording,
-- so that is the default. New app code always sets purpose and version explicitly.
alter table guardian_consent_requests
  add column purpose               text not null default 'platform' check (purpose in ('platform', 'messaging')),
  add column consent_version       text not null default 'guardian-v1' references guardian_consent_versions(version),
  add column messaging_decision    text check (messaging_decision in ('approved', 'declined')),
  add column messaging_decided_at  timestamptz,
  add constraint guardian_consent_requests_messaging_decided
    check ((messaging_decision is null) = (messaging_decided_at is null));

-- A messaging permission can only ever rest on wording that covered messaging. Enforced in the
-- database so that no code path — not even a direct service-role write — can turn a v1 approval
-- into messaging permission.
create or replace function guard_messaging_consent_version()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'age_records' then
    if new.guardian_messaging_allowed and not exists (
      select 1 from guardian_consent_versions v
      where v.version = new.guardian_messaging_version and v.covers_messaging
    ) then
      raise exception 'Messaging permission needs guardian consent wording that covers messaging.';
    end if;
  else
    if new.messaging_decision = 'approved' and not exists (
      select 1 from guardian_consent_versions v
      where v.version = new.consent_version and v.covers_messaging
    ) then
      raise exception 'Messaging permission needs guardian consent wording that covers messaging.';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_age_records_messaging_version
  before insert or update on age_records
  for each row execute function guard_messaging_consent_version();

create trigger trg_guardian_requests_messaging_version
  before insert or update on guardian_consent_requests
  for each row execute function guard_messaging_consent_version();

-- ------------------------------------------------------------
-- Age, worked out on the day it is checked (no birthday job needed)
-- ------------------------------------------------------------

-- Whole years old on the Kenyan calendar date of p_at. Same rule as lib/age.ts ageInYears():
-- the birthday counts once today's (month, day) reaches the birth (month, day). So someone born on
-- 29 February turns a year older on 1 March in a non-leap year (28 February is still "before").
create or replace function age_in_years_kenya(p_dob date, p_at timestamptz default now())
returns int
language sql stable set search_path = public as $$
  select case when p_dob is null then null else
    extract(year from t)::int - extract(year from p_dob)::int
    - case
        when extract(month from t) < extract(month from p_dob)
          or (extract(month from t) = extract(month from p_dob) and extract(day from t) < extract(day from p_dob))
        then 1 else 0
      end
  end
  from (select (p_at at time zone 'Africa/Nairobi')::date as t) today;
$$;

-- ------------------------------------------------------------
-- The messaging gate
-- ------------------------------------------------------------

-- May this person use private messaging right now?
--   * platform consent must be in place ('not_required' or 'granted'), exactly as age_cleared(); and
--   * they are 18 or over today (Kenya date), OR a guardian gave messaging permission on wording
--     that covers it.
-- An earlier guardian decline/withdrawal of messaging does not matter once the person is 18.
create or replace function messaging_cleared(p_profile uuid, p_at timestamptz default now())
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select ar.consent_status in ('not_required', 'granted')
       and (
         age_in_years_kenya(ar.date_of_birth, p_at) >= 18
         or (ar.guardian_messaging_allowed
             and exists (select 1 from guardian_consent_versions v
                         where v.version = ar.guardian_messaging_version and v.covers_messaging))
       )
    from age_records ar
    where ar.profile_id = p_profile
  ), false);
$$;

-- ------------------------------------------------------------
-- Recording guardian decisions (server-only)
-- ------------------------------------------------------------

-- Platform consent on the v2 page, with the optional messaging choice, in ONE transaction.
-- The platform part is delegated unchanged to decide_guardian_consent(). The messaging choice is
-- recorded only if the platform was approved AND the request's wording covers messaging; for a v1
-- request (or a platform decline) the messaging choice is ignored and messaging stays off.
-- p_messaging: 'approved' | 'declined' | null (no answer = not allowed).
-- Returns what decide_guardian_consent() returned.
create or replace function decide_guardian_consent_with_messaging(p_token_hash text, p_decision text, p_messaging text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  r guardian_consent_requests;
  v_result text;
  v_covers boolean;
begin
  select * into r from guardian_consent_requests where token_hash = p_token_hash;
  if found and r.purpose <> 'platform' then
    return 'invalid';
  end if;

  v_result := decide_guardian_consent(p_token_hash, p_decision);

  if v_result = 'approved' and p_messaging in ('approved', 'declined') then
    select covers_messaging into v_covers from guardian_consent_versions where version = r.consent_version;
    if coalesce(v_covers, false) then
      update guardian_consent_requests
      set messaging_decision = p_messaging, messaging_decided_at = now()
      where id = r.id;

      update age_records
      set guardian_messaging_allowed    = (p_messaging = 'approved'),
          guardian_messaging_status     = case when p_messaging = 'approved' then 'granted' else 'declined' end,
          guardian_messaging_version    = r.consent_version,
          guardian_messaging_decided_at = now()
      where profile_id = r.profile_id;
    end if;
  end if;

  return v_result;
end;
$$;

-- A messaging-only request (the student asked "allow messaging" after their platform approval).
-- Checked and consumed atomically. Never touches consent_status and never deletes anything.
-- Returns approved | declined | used | expired | invalid.
create or replace function decide_guardian_messaging_consent(p_token_hash text, p_decision text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  r guardian_consent_requests;
begin
  if p_decision is null or p_decision not in ('approved', 'declined') then
    return 'invalid';
  end if;

  select * into r from guardian_consent_requests where token_hash = p_token_hash for update;
  if not found or r.purpose <> 'messaging' then return 'invalid'; end if;
  if r.decided_at is not null then return 'used'; end if;
  if r.expires_at < now() then return 'expired'; end if;

  if not exists (select 1 from guardian_consent_versions where version = r.consent_version and covers_messaging) then
    return 'invalid';
  end if;

  -- Only for an account whose platform consent is granted, and only from the guardian on record.
  if not exists (
    select 1 from age_records
    where profile_id = r.profile_id
      and consent_status = 'granted'
      and lower(guardian_email) = lower(r.guardian_email)
  ) then
    return 'invalid';
  end if;

  update guardian_consent_requests
  set decided_at = now(), decision = p_decision,
      messaging_decision = p_decision, messaging_decided_at = now()
  where id = r.id;

  update age_records
  set guardian_messaging_allowed    = (p_decision = 'approved'),
      guardian_messaging_status     = case when p_decision = 'approved' then 'granted' else 'declined' end,
      guardian_messaging_version    = r.consent_version,
      guardian_messaging_decided_at = now()
  where profile_id = r.profile_id;

  return p_decision;
end;
$$;

-- A guardian withdraws messaging permission (they ask support; see the Privacy Policy). Switches
-- messaging off at once — both people lose access to the conversation — and cancels any messaging
-- request still waiting. Never touches consent_status, never deletes the account or the messages.
-- Returns 'withdrawn', or 'no_record' if the person has no age record.
create or replace function withdraw_guardian_messaging_consent(p_profile uuid)
returns text
language plpgsql security definer set search_path = public as $$
begin
  update age_records
  set guardian_messaging_allowed    = false,
      guardian_messaging_status     = 'withdrawn',
      guardian_messaging_decided_at = now()
  where profile_id = p_profile;
  if not found then return 'no_record'; end if;

  update guardian_consent_requests
  set expires_at = now()
  where profile_id = p_profile and purpose = 'messaging' and decided_at is null and expires_at > now();

  return 'withdrawn';
end;
$$;

-- ------------------------------------------------------------
-- Rewire the three 0011 gates from age_cleared() to messaging_cleared()
-- ------------------------------------------------------------
-- Everything else in each function is exactly as in 0011.

create or replace function caller_can_read_conversation(p_conversation uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversations c
    where c.id = p_conversation
      and auth.uid() in (c.student_id, c.teacher_id)
      and messaging_cleared(c.student_id)
      and messaging_cleared(c.teacher_id)
  );
$$;

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
  if not (messaging_cleared(p_student) and messaging_cleared(p_teacher)) then
    raise exception 'messaging:not_permitted';
  end if;

  insert into conversations (student_id, teacher_id) values (p_student, p_teacher)
  on conflict (student_id, teacher_id) do nothing;

  select id into v_id from conversations where student_id = p_student and teacher_id = p_teacher;
  return v_id;
end;
$$;

-- 'ok', or why not: not_found, not_cleared (platform age/consent gate), not_permitted (no messaging
-- permission: under 18 without the guardian's messaging approval), closed (no relationship any more).
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
  if not (messaging_cleared(c.student_id) and messaging_cleared(c.teacher_id)) then
    return 'not_permitted';
  end if;
  if not messaging_relationship(c.student_id, c.teacher_id) then
    return 'closed';
  end if;
  return 'ok';
end;
$$;

-- ------------------------------------------------------------
-- Privileges: every new function is server-only
-- ------------------------------------------------------------
-- (create or replace keeps the 0011 privileges on the three rewired functions.)

revoke all on function guard_messaging_consent_version() from public, anon, authenticated;
revoke all on function age_in_years_kenya(date, timestamptz) from public, anon, authenticated;
revoke all on function messaging_cleared(uuid, timestamptz) from public, anon, authenticated;
revoke all on function decide_guardian_consent_with_messaging(text, text, text) from public, anon, authenticated;
revoke all on function decide_guardian_messaging_consent(text, text) from public, anon, authenticated;
revoke all on function withdraw_guardian_messaging_consent(uuid) from public, anon, authenticated;

grant execute on function age_in_years_kenya(date, timestamptz) to service_role;
grant execute on function messaging_cleared(uuid, timestamptz) to service_role;
grant execute on function decide_guardian_consent_with_messaging(text, text, text) to service_role;
grant execute on function decide_guardian_messaging_consent(text, text) to service_role;
grant execute on function withdraw_guardian_messaging_consent(uuid) to service_role;
