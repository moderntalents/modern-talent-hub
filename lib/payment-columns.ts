// The payment_transactions columns a browser session may read (supabase/migrations/0015_hide_payer_phone.sql).
// Everything except the payer's phone numbers (phone, callback_phone), which browsers cannot select: pages
// that read payments as the signed-in person must list these columns instead of using "*".
export const PAYMENT_VISIBLE_COLUMNS =
  "id, subscription_id, student_id, teacher_id, amount, currency, provider, provider_reference, checkout_request_id, status, teacher_share, platform_share, created_at, completed_at, expected_amount, merchant_request_id, result_code, result_desc, callback_amount, paid_at, confirmed_via, callback_received_at, last_queried_at, query_attempts, teacher_pct, platform_pct, credited_at, needs_review, phone_mismatch" as const;
