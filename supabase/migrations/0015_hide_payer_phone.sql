-- Modern Talent Hub — hide the payer's phone number from browsers (privacy fix for Phase 2A).
-- Run after 0013_payment_state_machine_and_ledger.sql. Safe to run more than once.
-- (Numbered 0015 because 0014 is already used by the separate messaging work.)
--
-- Phase 2A stores the number the STK prompt was sent to in payment_transactions.phone, and the number a
-- callback reports in callback_phone. The existing read policy (transactions_read_own, 0001) lets the COACH
-- read every column of their students' payment rows, so a coach could read the payer's number — often a
-- child's or a parent's. 0013 said this must be closed in the same release that starts storing the numbers,
-- with "explicit column lists in those pages plus column-level privileges". That is exactly what this does.
--
-- After this migration:
--   * No browser session (student, coach or admin) can select phone or callback_phone directly. Every other
--     column stays readable exactly as before, still limited to the rows the existing policy allows.
--   * The paying student, and administrators, can still see a payment's numbers through
--     payment_payer_phone(), which checks who is asking. A coach gets nothing from it.
--   * The server (service role) is unchanged: it still reads and writes both columns for verification and
--     reconciliation. The columns themselves are unchanged and nothing is deleted.
--
-- Fail-closed note: a column added to payment_transactions later is NOT readable by browsers until it is
-- added to the grant below.

revoke select on payment_transactions from authenticated;
grant select (
  id, subscription_id, student_id, teacher_id, amount, currency, provider, provider_reference,
  checkout_request_id, status, teacher_share, platform_share, created_at, completed_at,
  expected_amount, merchant_request_id, result_code, result_desc, callback_amount, paid_at, confirmed_via,
  callback_received_at, last_queried_at, query_attempts, teacher_pct, platform_pct, credited_at,
  needs_review, phone_mismatch
) on payment_transactions to authenticated;

-- The payer's numbers for ONE payment, for the paying student or an administrator only. Anyone else — the
-- coach included — gets no row, exactly as if the payment did not exist.
create or replace function payment_payer_phone(p_transaction uuid)
returns table (phone text, callback_phone text)
language sql stable security definer set search_path = public as $$
  select pt.phone, pt.callback_phone
  from payment_transactions pt
  where pt.id = p_transaction
    and auth.uid() is not null
    and (pt.student_id = auth.uid() or is_admin());
$$;

revoke all on function payment_payer_phone(uuid) from public, anon;
grant execute on function payment_payer_phone(uuid) to authenticated, service_role;
