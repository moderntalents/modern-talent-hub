import type { PGlite } from "@electric-sql/pglite";
import { as, type Actor } from "./db";
import { ID } from "./seed";

export type Outcome = { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string };

/** Runs a statement as a Supabase caller and reports whether it was accepted (never throws). */
export function attemptOn(db: PGlite) {
  return async (actor: Actor, sql: string, params: unknown[] = []): Promise<Outcome> => {
    try {
      const r = await as(db, actor, () => db.query<Record<string, unknown>>(sql, params));
      return { ok: true, rows: r.rows };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };
}

export const raised = (o: Outcome, pattern: RegExp) => !o.ok && pattern.test(o.error);
export const nothing = (o: Outcome) => !o.ok || o.rows.length === 0;

export async function newStudent(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{\"role\":\"student\",\"full_name\":\"Test Student\"}')",
    [id, `${id}@test.invalid`],
  );
  return id;
}

const TEACHER_OF: Record<string, string> = { [ID.A1]: ID.T2, [ID.A2]: ID.T4, [ID.A3]: ID.T2 };

export interface PaymentRef {
  id: string;
  subscriptionId: string;
  student: string;
  teacher: string;
  amount: number;
}

/** A pending payment created exactly the way the existing initiation route creates one (service role, plain insert). */
export async function newPayment(
  db: PGlite,
  o: { student?: string; activity?: string; amount?: number; checkout?: string; phone?: string } = {},
): Promise<PaymentRef> {
  const student = o.student ?? (await newStudent(db));
  const activity = o.activity ?? ID.A1;
  const teacher = TEACHER_OF[activity];
  const amount = o.amount ?? 1000;
  const sub = await db.query<{ id: string }>(
    `insert into subscriptions (student_id, activity_id, teacher_id, status) values ($1, $2, $3, 'pending_payment')
     on conflict (student_id, activity_id) do update set status = subscriptions.status returning id`,
    [student, activity, teacher],
  );
  const pay = await db.query<{ id: string }>(
    `insert into payment_transactions (subscription_id, student_id, teacher_id, amount, provider, status, checkout_request_id, phone)
     values ($1, $2, $3, $4, 'mpesa', 'pending', $5, $6) returning id`,
    [sub.rows[0].id, student, teacher, amount, o.checkout ?? null, o.phone ?? null],
  );
  return { id: pay.rows[0].id, subscriptionId: sub.rows[0].id, student, teacher, amount };
}

let receiptCounter = 0;
export const nextReceipt = () => `TST${String(++receiptCounter).padStart(7, "0")}`;

/** Completes a payment the way the Phase 2 server will: as the service role, with verified fields. */
export function completeVerified(
  db: PGlite,
  id: string,
  o: { via?: "callback" | "query"; receipt?: string | null; callbackAmount?: number | null; extra?: string } = {},
): Promise<Outcome> {
  const via = o.via ?? "callback";
  return attemptOn(db)(
    "service",
    `update payment_transactions set status = 'completed', result_code = 0, confirmed_via = $2,
        provider_reference = $3, callback_amount = $4, callback_received_at = now() ${o.extra ?? ""}
     where id = $1 returning teacher_share::text as teacher_share, platform_share::text as platform_share`,
    [
      id,
      via,
      via === "callback" ? (o.receipt === undefined ? nextReceipt() : o.receipt) : (o.receipt ?? null),
      o.callbackAmount ?? null,
    ],
  );
}

/** Completes with the callback amount defaulting to the payment's own expected amount. */
export async function completeAsExpected(db: PGlite, p: PaymentRef, o: { via?: "callback" | "query"; receipt?: string } = {}) {
  return completeVerified(db, p.id, { ...o, callbackAmount: o.via === "query" ? null : p.amount });
}

export type Status = "pending" | "completed" | "failed" | "cancelled" | "expired" | "review";
export const ALL_STATUSES: Status[] = ["pending", "completed", "failed", "cancelled", "expired", "review"];
/** The only legal moves. */
export const LEGAL: Record<string, Status[]> = {
  pending: ["completed", "failed", "cancelled", "expired", "review"],
  expired: ["completed"],
};

/** Moves a fresh pending payment to `status` by a legal path. */
export async function driveTo(db: PGlite, p: PaymentRef, status: Status): Promise<void> {
  const svc = attemptOn(db);
  const move = async (sql: string, params: unknown[] = []) => {
    const r = await svc("service", sql, params);
    if (!r.ok) throw new Error(`setup failed (${sql}): ${r.error}`);
  };
  if (status === "pending") return;
  if (status === "completed") {
    const r = await completeAsExpected(db, p);
    if (!r.ok) throw new Error(`setup failed (complete): ${r.error}`);
  } else if (status === "failed") await move("update payment_transactions set status = 'failed', result_code = 1 where id = $1", [p.id]);
  else if (status === "cancelled") await move("update payment_transactions set status = 'cancelled', result_code = 1032 where id = $1", [p.id]);
  else if (status === "expired") await move("update payment_transactions set status = 'expired', result_code = 1037 where id = $1", [p.id]);
  else if (status === "review") await move("update payment_transactions set status = 'review', result_desc = 'test' where id = $1", [p.id]);
}

/** Clears payments, ledger, callbacks, withdrawals and wallets between tests. Uses replica mode because the ledger is append-only by design. */
export async function resetPayments(db: PGlite): Promise<void> {
  await db.exec(`
    set session_replication_role = replica;
    delete from mpesa_callbacks;
    delete from wallet_ledger;
    delete from withdrawal_requests;
    delete from payment_transactions;
    delete from subscriptions where (student_id, activity_id) not in (('${ID.S1}', '${ID.A1}'), ('${ID.S5}', '${ID.A1}'));
    update teacher_profiles set wallet_balance = 0;
    insert into platform_wallet (id) values (true) on conflict (id) do nothing;
    update platform_wallet set balance = 0;
    reset session_replication_role;
  `);
}

export const num = (v: unknown) => Number(v);
export async function wallets(db: PGlite) {
  const t = await db.query<{ profile_id: string; w: string }>("select profile_id, wallet_balance::text as w from teacher_profiles");
  const p = await db.query<{ b: string }>("select balance::text as b from platform_wallet");
  const l = await db.query<{ n: string }>("select count(*)::text as n from wallet_ledger");
  const snapshot = {
    teachers: Object.fromEntries(t.rows.map((r) => [r.profile_id, Number(r.w)])),
    platform: Number(p.rows[0]?.b ?? NaN),
    ledgerRows: Number(l.rows[0].n),
  };
  // A lookup helper that is NOT part of the compared data (so two snapshots can be deep-compared).
  Object.defineProperty(snapshot, "teacher", { value: (id: string) => snapshot.teachers[id] ?? NaN, enumerable: false });
  return snapshot as typeof snapshot & { teacher: (id: string) => number };
}
