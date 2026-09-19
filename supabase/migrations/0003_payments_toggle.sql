-- Modern Talent Hub — global payments on/off switch
-- Run after 0002_coach_activation_fee.sql.
--
-- While payments_enabled is false the whole app is free: coaches activate
-- without paying, students enrol in any published activity without paying,
-- and the M-Pesa STK Push endpoints refuse to start a charge. Flip it on at
-- /admin/settings when you're ready to take payments — no code change.
--
-- Safe default: a missing row is treated as "payments off".

alter table platform_settings
  add constraint payments_enabled_valid check (
    key <> 'payments_enabled' or jsonb_typeof(value) = 'boolean'
  );

insert into platform_settings (key, value)
values ('payments_enabled', 'false'::jsonb)
on conflict (key) do nothing;
