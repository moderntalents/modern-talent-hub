-- Modern Talent Hub — fix "stack depth limit exceeded" on admin actions
-- Run after 0006_teacher_approval_enforcement.sql. Safe to run more than once.
--
-- Bug: is_admin() (from 0001) reads the profiles table, but profiles has its own
-- row-level-security policy that calls is_admin() again. When Postgres has to
-- evaluate that policy for a row that isn't the caller's own, it re-enters
-- is_admin() forever and aborts with "stack depth limit exceeded". Admin
-- actions that WRITE (approving a teacher, updating settings, processing
-- withdrawals) hit it; plain reads mostly dodge it.
--
-- Fix: run is_admin() with the owner's rights (SECURITY DEFINER) so its lookup on
-- profiles bypasses those policies and the recursion never starts. It still
-- answers only "is the CURRENT signed-in user an admin?" — auth.uid() is read
-- from the caller's login, not from the function owner — and returns just a
-- boolean. CREATE OR REPLACE keeps every policy that already uses it.

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;
