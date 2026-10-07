-- Modern Talent Hub — retire the coach activation fee.
--
-- Business rule: posting lessons and activities is FREE for coaches and teachers. The only money that moves
-- is a student/parent payment, split 70% coach / 30% MTH by the existing handle_transaction_completed()
-- trigger (0013). That is not touched here.
--
-- This removes everything 0002_coach_activation_fee.sql added for the one-time coach fee:
--   * the coach_activation_fee_kes setting (and the CHECK that validated it)
--   * the coach_activation_payments table and its trigger/function
--   * teacher_profiles.activated / activated_at and their guard trigger/function
--
-- Run AFTER the matching app release is live (that release no longer reads any of these). Safe to re-run.

-- 1. The fee setting. platform_settings_history keeps the audit trail of past values.
delete from platform_settings where key = 'coach_activation_fee_kes';
alter table platform_settings drop constraint if exists coach_activation_fee_valid;

comment on table platform_settings is
  'Admin-editable platform configuration. Key payments_enabled = whether students are charged for priced activities.';

-- 2. Activation payments. Money records are never dropped silently: if any row exists the table is kept
--    (and nothing reads it any more); production had none.
do $$
begin
  if to_regclass('public.coach_activation_payments') is not null then
    if exists (select 1 from coach_activation_payments) then
      raise notice 'coach_activation_payments holds rows, so it was kept for the records. Drop it by hand once they are archived.';
    else
      drop trigger if exists trg_activation_completed on coach_activation_payments;
      drop table coach_activation_payments;
    end if;
  end if;
end $$;
-- Only drop the trigger function once the table (its only user) is gone.
do $$
begin
  if to_regclass('public.coach_activation_payments') is null then
    drop function if exists handle_activation_completed();
  end if;
end $$;

-- 3. The activation flag on coaches. Nothing is gated on it any more, so every approved coach can publish.
drop trigger if exists trg_guard_teacher_activation on teacher_profiles;
drop function if exists guard_teacher_activation_columns();
alter table teacher_profiles drop column if exists activated;
alter table teacher_profiles drop column if exists activated_at;
