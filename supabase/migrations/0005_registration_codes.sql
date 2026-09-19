-- Modern Talent Hub — 5-digit email verification codes for registration
-- Run after 0004_lock_down_roles.sql.
--
-- Supabase's own email OTP can't be 5 digits (minimum is 6), so registration
-- verification is handled by our server routes:
--   POST /api/auth/send-code            issues + emails a code
--   POST /api/auth/verify-registration  checks the code, THEN creates the account
--
-- The auth user is only created after the code is proven, so nobody can
-- pre-register (squat) someone else's email address.
--
-- Everything below is reachable ONLY with the service role: RLS is on with no
-- policies, and the functions are revoked from anon/authenticated. A 5-digit
-- code has just 90,000 possibilities, so security rests on these limits:
--   * codes are stored as an HMAC (keyed with a server secret), never in clear
--   * a code expires after 10 minutes
--   * at most 5 wrong guesses per code, counted atomically in the database
--   * one new code per email per 60s, at most 5 per hour
--   * per-IP request limits (hit_rate_limit)

create table registration_codes (
  email text primary key,                 -- lower-cased
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  send_count int not null default 1,
  window_start timestamptz not null default now(),
  last_sent_at timestamptz not null default now()
);

create table auth_rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits int not null default 0
);

alter table registration_codes enable row level security;
alter table auth_rate_limits enable row level security;
-- (no policies on purpose: anon/authenticated can read and write nothing)

-- Is this email already registered, and has it been confirmed?
create or replace function auth_email_status(p_email text)
returns table (id uuid, confirmed boolean)
language sql security definer set search_path = public as $$
  select u.id, (u.email_confirmed_at is not null)
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
  limit 1;
$$;

-- Fixed-window counter. Returns true while under the limit.
create or replace function hit_rate_limit(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_hits int;
begin
  delete from auth_rate_limits where window_start < now() - interval '1 day';

  insert into auth_rate_limits as l (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when l.window_start < now() - make_interval(secs => p_window_seconds)
                then 1 else l.hits + 1 end,
    window_start = case when l.window_start < now() - make_interval(secs => p_window_seconds)
                        then now() else l.window_start end
  returning l.hits into v_hits;

  return v_hits <= p_max;
end;
$$;

-- Store a fresh code for an email (replacing any previous one, which stops
-- working). Enforces the 60s cooldown and the 5-per-hour cap.
-- status: 'ok' | 'cooldown' | 'limit'; retry_after = seconds to wait.
create or replace function issue_registration_code(p_email text, p_code_hash text, p_ttl_seconds int default 600)
returns table (status text, retry_after int)
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  r registration_codes%rowtype;
  v_wait int;
begin
  select * into r from registration_codes where email = v_email for update;

  if found then
    v_wait := ceil(extract(epoch from (r.last_sent_at + interval '60 seconds' - now())))::int;
    if v_wait > 0 then
      return query select 'cooldown'::text, v_wait;
      return;
    end if;

    if r.window_start > now() - interval '1 hour' and r.send_count >= 5 then
      return query select 'limit'::text,
        ceil(extract(epoch from (r.window_start + interval '1 hour' - now())))::int;
      return;
    end if;

    update registration_codes set
      code_hash = p_code_hash,
      expires_at = now() + make_interval(secs => p_ttl_seconds),
      attempts = 0,
      last_sent_at = now(),
      send_count = case when window_start > now() - interval '1 hour' then send_count + 1 else 1 end,
      window_start = case when window_start > now() - interval '1 hour' then window_start else now() end
    where email = v_email;
  else
    begin
      insert into registration_codes (email, code_hash, expires_at)
      values (v_email, p_code_hash, now() + make_interval(secs => p_ttl_seconds));
    exception when unique_violation then
      -- two requests raced to create the first row; the other one won
      return query select 'cooldown'::text, 60;
      return;
    end;
  end if;

  return query select 'ok'::text, 0;
end;
$$;

-- Check a code. The row is locked, so parallel guesses can't dodge the attempt
-- counter. Returns 'ok' (code is consumed), 'invalid', 'expired', 'locked'
-- (5 wrong guesses — a new code is required) or 'none' (no code requested).
create or replace function verify_registration_code(p_email text, p_code_hash text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  r registration_codes%rowtype;
begin
  select * into r from registration_codes where email = v_email for update;

  if not found then return 'none'; end if;
  if r.expires_at <= now() then return 'expired'; end if;
  if r.attempts >= 5 then return 'locked'; end if;

  if r.code_hash = p_code_hash then
    delete from registration_codes where email = v_email;
    return 'ok';
  end if;

  update registration_codes set attempts = attempts + 1 where email = v_email;
  return 'invalid';
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon/authenticated by
-- default. These must be callable by the server (service role) only.
revoke all on function auth_email_status(text) from public, anon, authenticated;
revoke all on function hit_rate_limit(text, int, int) from public, anon, authenticated;
revoke all on function issue_registration_code(text, text, int) from public, anon, authenticated;
revoke all on function verify_registration_code(text, text) from public, anon, authenticated;

grant execute on function auth_email_status(text) to service_role;
grant execute on function hit_rate_limit(text, int, int) to service_role;
grant execute on function issue_registration_code(text, text, int) to service_role;
grant execute on function verify_registration_code(text, text) to service_role;
