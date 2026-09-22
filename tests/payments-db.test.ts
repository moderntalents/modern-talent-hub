// Phase 1 tests for migration 0013: the payment state machine, the split, the platform wallet, the append-only
// ledger and callback log, idempotency, and every browser/server write protection. They run against a real
// Postgres that has the repository's ACTUAL migrations applied (0001–0010, 0012, 0013).

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, readMigration, as, type Actor } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import {
  ALL_STATUSES, LEGAL, attemptOn, completeAsExpected, completeVerified, driveTo, newPayment, newStudent,
  nothing, raised, resetPayments, wallets, type Status,
} from "./helpers/payments";

const MIGRATION = "0013_payment_state_machine_and_ledger.sql";
let db: PGlite;
let attempt: ReturnType<typeof attemptOn>;

before(async () => {
  db = await createTestDb();
  attempt = attemptOn(db);
  await seedWorld(db);
});
beforeEach(async () => {
  await resetPayments(db);
});

const one = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows[0];
const many = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const status = async (id: string) => (await one("select status from payment_transactions where id = $1", [id])).status as string;

// ==================================================================================================
describe("the migration itself", () => {
  test("it refuses to run over completed payments or fractional amounts, and backfills whole ones", async () => {
    const old = () => createTestDb({ include: (f) => f < "0011" || f.startsWith("0012") });

    // (a) a completed payment already exists (old rules) -> refuse
    const a = await old();
    await seedWorld(a);
    const s = await a.query<{ id: string }>(`insert into subscriptions (student_id, activity_id, teacher_id, status) values ('${ID.S7}', '${ID.A1}', '${ID.T2}', 'pending_payment') returning id`);
    await a.query(`insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status) values ($1, '${ID.S7}', '${ID.T2}', 1000, 'pending')`, [s.rows[0].id]);
    await a.exec("update payment_transactions set status = 'completed'");
    await assert.rejects(a.exec(readMigration(MIGRATION)), /completed payments already exist/);

    // (b) a fractional pending payment -> refuse
    const b = await old();
    await seedWorld(b);
    const s2 = await b.query<{ id: string }>(`insert into subscriptions (student_id, activity_id, teacher_id, status) values ('${ID.S7}', '${ID.A1}', '${ID.T2}', 'pending_payment') returning id`);
    await b.query(`insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status) values ($1, '${ID.S7}', '${ID.T2}', 500.50, 'pending')`, [s2.rows[0].id]);
    await assert.rejects(b.exec(readMigration(MIGRATION)), /fractional or zero amount/);

    // (c) a whole pending payment -> migrates and gets expected_amount
    const c = await old();
    await seedWorld(c);
    const s3 = await c.query<{ id: string }>(`insert into subscriptions (student_id, activity_id, teacher_id, status) values ('${ID.S7}', '${ID.A1}', '${ID.T2}', 'pending_payment') returning id`);
    await c.query(`insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status) values ($1, '${ID.S7}', '${ID.T2}', 500, 'pending')`, [s3.rows[0].id]);
    await c.exec(readMigration(MIGRATION));
    assert.equal(Number((await c.query<{ e: number }>("select expected_amount as e from payment_transactions")).rows[0].e), 500);
  });

  test("it adds exactly the intended columns, tables, indexes and constraints", async () => {
    const cols = (await many("select column_name from information_schema.columns where table_name = 'payment_transactions'")).map((r) => r.column_name as string);
    for (const c of ["expected_amount", "merchant_request_id", "phone", "result_code", "result_desc", "callback_amount", "callback_phone", "paid_at", "confirmed_via", "callback_received_at", "last_queried_at", "query_attempts", "teacher_pct", "platform_pct", "credited_at", "needs_review", "phone_mismatch"]) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
    assert.equal(cols.length, 31, "14 original columns + 17 new ones");
    const tables = (await many("select table_name from information_schema.tables where table_schema = 'public'")).map((r) => r.table_name);
    for (const t of ["platform_wallet", "wallet_ledger", "mpesa_callbacks"]) assert.ok(tables.includes(t), `missing table ${t}`);
    const idx = (await many("select indexname from pg_indexes where schemaname = 'public'")).map((r) => r.indexname);
    for (const i of ["payment_transactions_checkout_request_id_key", "payment_transactions_provider_reference_key", "payment_transactions_merchant_request_id_key", "payment_transactions_one_pending_per_subscription", "wallet_ledger_payment_credit_key", "wallet_ledger_withdrawal_key"]) {
      assert.ok(idx.includes(i), `missing index ${i}`);
    }
    const statusCheck = await one("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'payment_transactions_status_check'");
    for (const s of ALL_STATUSES) assert.match(String(statusCheck.d), new RegExp(`'${s}'`));
    const price = await one("select convalidated from pg_constraint where conname = 'activities_price_whole_kes'");
    assert.equal(price.convalidated, false, "the price rule is NOT VALID, so existing rows are checked separately");
    const fk = await one("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'payment_transactions_subscription_id_fkey'");
    assert.match(String(fk.d), /ON DELETE RESTRICT/);
    assert.equal(Number((await one("select count(*)::int as n from platform_wallet")).n), 1);
  });

  test("it changes nothing outside the payment area — and 0012 is untouched", async () => {
    const snap = async (d: PGlite) => {
      const q = async (sql: string) => (await d.query<Record<string, unknown>>(sql)).rows.map((r) => JSON.stringify(r));
      const newTables = "('platform_wallet','wallet_ledger','mpesa_callbacks')";
      const paymentArea = "('payment_transactions','platform_wallet','wallet_ledger','mpesa_callbacks')";
      return {
        tables: await q(`select table_name from information_schema.tables where table_schema in ('public','storage') and table_name not in ${newTables} order by 1`),
        columnsElsewhere: await q(`select table_name, column_name, data_type, column_default from information_schema.columns where table_schema in ('public','storage') and table_name not in ${paymentArea} order by 1,2`),
        constraintsElsewhere: await q(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text not in ${paymentArea} and conname <> 'activities_price_whole_kes' order by 1,2`),
        policiesAll: await q(`select tablename, policyname, cmd, qual, with_check from pg_policies where tablename not in ${newTables} order by 1,2`),
        triggersElsewhere: await q(`select event_object_table, trigger_name, action_statement from information_schema.triggers where trigger_schema = 'public' and event_object_table not in ${paymentArea} order by 1,2`),
        functionsElsewhere: await q(`select proname, pg_get_functiondef(oid) d, proacl::text acl from pg_proc where pronamespace = 'public'::regnamespace and proname not in ('payment_split_teacher_pct','reject_append_only_change','guard_platform_wallet','payment_state_machine','payment_before_insert','payment_no_delete_completed','handle_transaction_completed') order by 1`),
        buckets: await q("select id, public, file_size_limit, allowed_mime_types from storage.buckets order by 1"),
        rlsElsewhere: await q(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname not in ${newTables} order by 1`),
        privsElsewhere: await q(`select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name not in ${paymentArea} order by 1,2,3`),
        teacherProfilesGuard: await q("select pg_get_functiondef('guard_teacher_privileged_columns'::regproc) d"),
      };
    };
    const [before0013, after0013] = await Promise.all([
      createTestDb({ include: (f) => f < "0011" || f.startsWith("0012") }),
      createTestDb({ include: (f) => f < "0011" || f.startsWith("0012") || f.startsWith("0013") }),
    ]);
    const a = await snap(before0013);
    const b = await snap(after0013);
    for (const key of Object.keys(a) as (keyof typeof a)[]) {
      assert.ok(a[key].length > 0, `sanity: ${key} should not be empty`);
      assert.deepEqual(b[key], a[key], `0013 changed ${key} outside the payment area`);
    }
  });
});

// ==================================================================================================
describe("creating a payment (the existing initiation code must keep working)", () => {
  test("a plain insert, exactly as the current route does it, works and gets safe defaults", async () => {
    const p = await newPayment(db, { amount: 1500 });
    const row = await one("select status, expected_amount, amount::int as amount, teacher_share::int as ts, platform_share::int as ps, query_attempts, needs_review, phone_mismatch, credited_at from payment_transactions where id = $1", [p.id]);
    assert.deepEqual(
      [row.status, row.expected_amount, row.amount, row.ts, row.ps, row.query_attempts, row.needs_review, row.phone_mismatch, row.credited_at],
      ["pending", 1500, 1500, 0, 0, 0, false, false, null],
    );
  });

  test("bad amounts are refused: fractional, zero, above the M-Pesa cap, or an expected amount that differs", async () => {
    const sub = async () => (await one(`insert into subscriptions (student_id, activity_id, teacher_id, status) values ('${await newStudent(db)}', '${ID.A1}', '${ID.T2}', 'pending_payment') returning id, student_id`));
    const insert = async (amount: number, expected?: number) => {
      const s = await sub();
      return attempt("service", "insert into payment_transactions (subscription_id, student_id, teacher_id, amount, expected_amount, status) values ($1, $2, $3, $4, $5, 'pending')", [s.id, s.student_id, ID.T2, amount, expected ?? null]);
    };
    assert.ok(!(await insert(500.5)).ok, "fractional price");
    assert.ok(!(await insert(0)).ok, "zero");
    assert.ok(!(await insert(250001)).ok, "over 250,000");
    assert.ok(!(await insert(1000, 999)).ok, "expected_amount must equal the price");
    assert.ok((await insert(250000)).ok, "250,000 is the largest allowed");
    assert.ok((await insert(1)).ok, "1 is the smallest allowed");
  });

  test("a payment can only be created as pending, and other constraints hold", async () => {
    const s = await one(`insert into subscriptions (student_id, activity_id, teacher_id, status) values ('${await newStudent(db)}', '${ID.A1}', '${ID.T2}', 'pending_payment') returning id, student_id`);
    assert.ok(!(await attempt("service", "insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status) values ($1,$2,$3,1000,'completed')", [s.id, s.student_id, ID.T2])).ok, "cannot be born completed");
    assert.ok(raised(await attempt("service", "insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status, confirmed_via) values ($1,$2,$3,1000,'pending','browser')", [s.id, s.student_id, ID.T2]), /confirmed_via/));
    assert.ok(raised(await attempt("service", "insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status, phone) values ($1,$2,$3,1000,'pending','0712345678')", [s.id, s.student_id, ID.T2]), /phone_valid/));
    assert.ok(raised(await attempt("service", "insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status, teacher_pct, platform_pct) values ($1,$2,$3,1000,'pending',60,50)", [s.id, s.student_id, ID.T2]), /split_valid/));
    // valid phone formats (07xx and the newer 01xx ranges) are accepted
    for (const phone of ["254712345678", "254112345678"]) {
      const st = await one(`insert into subscriptions (student_id, activity_id, teacher_id, status) values ('${await newStudent(db)}', '${ID.A2}', '${ID.T4}', 'pending_payment') returning id, student_id`);
      assert.ok((await attempt("service", "insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status, phone) values ($1,$2,$3,1000,'pending',$4)", [st.id, st.student_id, ID.T4, phone])).ok, phone);
    }
  });
});

// ==================================================================================================
describe("uniqueness protections", () => {
  test("only one pending payment per subscription; a new one is allowed once the first has ended", async () => {
    const p = await newPayment(db);
    const again = () => attempt("service", "insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status) values ($1,$2,$3,1000,'pending')", [p.subscriptionId, p.student, p.teacher]);
    assert.ok(raised(await again(), /one_pending_per_subscription/));
    await driveTo(db, p, "failed");
    assert.ok((await again()).ok, "a retry after a failure is fine");
    assert.ok(raised(await again(), /one_pending_per_subscription/), "…but again only one at a time");
  });

  test("a receipt number can back only one payment; the checkout and merchant request ids are unique too", async () => {
    const a = await newPayment(db, { checkout: "ws_CO_1" });
    const b = await newPayment(db);
    assert.ok(raised(await attempt("service", "update payment_transactions set checkout_request_id = 'ws_CO_1' where id = $1", [b.id]), /checkout_request_id_key/));

    await attempt("service", "update payment_transactions set merchant_request_id = 'MR-1' where id = $1", [a.id]);
    assert.ok(raised(await attempt("service", "update payment_transactions set merchant_request_id = 'MR-1' where id = $1", [b.id]), /merchant_request_id_key/));

    assert.ok((await completeAsExpected(db, a, { receipt: "RCPT-SAME" })).ok);
    assert.ok(raised(await completeAsExpected(db, b, { receipt: "RCPT-SAME" }), /provider_reference_key/));
    assert.equal(await status(b.id), "pending", "the second payment was not completed");
    assert.equal((await wallets(db)).ledgerRows, 2, "and was not credited");
  });

  test("history is protected: a subscription or activity with payments cannot be deleted; completed payments cannot be deleted", async () => {
    const p = await newPayment(db, { activity: ID.A2 });
    assert.ok(raised(await attempt("service", "delete from subscriptions where id = $1", [p.subscriptionId]), /payment_transactions_subscription_id_fkey/));
    assert.ok(raised(await attempt("service", "delete from activities where id = $1", [ID.A2]), /payment_transactions_subscription_id_fkey/), "the activity → subscription cascade is stopped by the payment");
    await completeAsExpected(db, p);
    assert.ok(raised(await attempt("service", "delete from payment_transactions where id = $1", [p.id]), /cannot be deleted|ledger|violates foreign key/));
    // a subscription with NO payments can still be deleted as before
    const s = await newStudent(db);
    const sub = await one(`insert into subscriptions (student_id, activity_id, teacher_id, status) values ('${s}', '${ID.A1}', '${ID.T2}', 'pending_payment') returning id`);
    assert.ok((await attempt("service", "delete from subscriptions where id = $1", [sub.id])).ok);
  });

  test("activity prices must be whole shillings from now on (NOT VALID: existing rows are not rejected)", async () => {
    assert.ok(raised(await attempt("service", "insert into activities (teacher_id, category, activity_type, title, price) values ($1,'sports','x','Frac',500.5)", [ID.T2]), /price_whole_kes/));
    assert.ok(raised(await attempt("service", "update activities set price = 99.99 where id = $1", [ID.A1]), /price_whole_kes/));
    assert.ok((await attempt("service", "insert into activities (teacher_id, category, activity_type, title, price) values ($1,'sports','x','Whole',500)", [ID.T2])).ok);
    assert.ok((await attempt("service", "update activities set price = 1200 where id = $1", [ID.A1])).ok);
  });
});

// ==================================================================================================
describe("the state machine", () => {
  test("every move between the six statuses: only the legal ones succeed", async () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === to) continue;
        const p = await newPayment(db);
        await driveTo(db, p, from);
        const wBefore = await wallets(db);
        const r = to === "completed"
          ? await completeAsExpected(db, p, { via: "query" })
          : await attempt("service", "update payment_transactions set status = $2, result_code = 1 where id = $1", [p.id, to]);
        const legal = (LEGAL[from] ?? []).includes(to);
        assert.equal(r.ok, legal, `${from} -> ${to} should be ${legal ? "allowed" : "refused"}${r.ok ? "" : ` (${r.error})`}`);
        if (!legal) {
          assert.equal(await status(p.id), from, `${from} stays ${from}`);
          assert.deepEqual(await wallets(db), wBefore, `no wallet moved on the refused ${from} -> ${to}`);
        }
      }
    }
  });

  test("a completed payment is immutable: no column can change, and it can never go back to failed", async () => {
    const p = await newPayment(db);
    await completeAsExpected(db, p, { receipt: "RCPT-IMM" });
    const before = await wallets(db);
    const snapshot = await one("select * from payment_transactions where id = $1", [p.id]);
    const other = await newStudent(db);

    const changes = [
      "status = 'failed'", "status = 'pending'", "status = 'expired'", "status = 'review'", "status = 'cancelled'",
      "amount = 1", "expected_amount = 1", "teacher_share = 1", "platform_share = 999", "teacher_pct = 10", "platform_pct = 90",
      "provider_reference = 'OTHER'", "callback_amount = 1", "result_code = 1", "confirmed_via = 'query'", "credited_at = now() + interval '1 day'",
      "completed_at = now() + interval '1 day'", "paid_at = now() + interval '1 day'", `teacher_id = '${ID.T4}'`, `student_id = '${other}'`,
      "needs_review = true", "phone = '254700000000'", "merchant_request_id = 'MR-X'", "checkout_request_id = 'ws_X'", "result_desc = 'changed'",
      "callback_received_at = now() + interval '1 day'", "last_queried_at = now()", "query_attempts = 5", "phone_mismatch = true", "currency = 'USD'",
    ];
    for (const set of changes) {
      const r = await attempt("service", `update payment_transactions set ${set} where id = $1`, [p.id]);
      assert.ok(!r.ok, `a completed payment must refuse: ${set}`);
    }
    assert.deepEqual(await one("select * from payment_transactions where id = $1", [p.id]), snapshot, "the row is byte-for-byte unchanged");
    assert.deepEqual(await wallets(db), before);
    assert.ok(raised(await attempt("service", "update payment_transactions set status = 'failed' where id = $1", [p.id]), /immutable/));
  });

  test("replaying the identical completion is a harmless no-op; replaying it with different values is refused", async () => {
    const p = await newPayment(db);
    await completeVerified(db, p.id, { receipt: "RCPT-REPLAY", callbackAmount: p.amount });
    const row = await one("select provider_reference, callback_amount::text as ca, result_code, confirmed_via from payment_transactions where id = $1", [p.id]);
    const before = await wallets(db);
    const same = await attempt("service", "update payment_transactions set status = 'completed', result_code = $2, confirmed_via = $3, provider_reference = $4, callback_amount = $5 where id = $1", [p.id, row.result_code, row.confirmed_via, row.provider_reference, row.ca]);
    assert.ok(same.ok, "identical values: accepted, nothing changes");
    assert.deepEqual(await wallets(db), before, "…and nothing is credited twice");
    assert.ok(!(await completeVerified(db, p.id, { receipt: "RCPT-REPLAY-2", callbackAmount: p.amount })).ok, "different receipt: refused");
  });

  test("failed and cancelled are final; expired and review may only gain bookkeeping; the money fields never change", async () => {
    for (const s of ["failed", "cancelled"] as Status[]) {
      const p = await newPayment(db);
      await driveTo(db, p, s);
      assert.ok(!(await attempt("service", "update payment_transactions set result_desc = 'x' where id = $1", [p.id])).ok, `${s} is final`);
    }
    const e = await newPayment(db);
    await driveTo(db, e, "expired");
    assert.ok((await attempt("service", "update payment_transactions set last_queried_at = now(), query_attempts = 1, result_desc = 'still no answer' where id = $1", [e.id])).ok, "expired can be re-queried");
    const r = await newPayment(db);
    await driveTo(db, r, "review");
    assert.equal((await one("select needs_review from payment_transactions where id = $1", [r.id])).needs_review, true, "review flags itself");
    assert.ok(!(await attempt("service", "update payment_transactions set result_desc = 'x' where id = $1", [r.id])).ok, "review is frozen");

    const p = await newPayment(db);
    for (const set of ["amount = 1", "expected_amount = 1", `teacher_id = '${ID.T4}'`, `student_id = '${ID.S1}'`, `subscription_id = '${e.subscriptionId}'`, "currency = 'USD'", "provider = 'card'", "created_at = now() - interval '1 year'"]) {
      assert.ok(raised(await attempt("service", `update payment_transactions set ${set} where id = $1`, [p.id]), /amount and parties cannot be changed|violates/), `even a pending payment refuses: ${set}`);
    }
  });

  test("a payment is completed only with a VERIFIED result", async () => {
    const p = await newPayment(db);
    const upd = (set: string) => attempt("service", `update payment_transactions set status = 'completed', ${set} where id = $1`, [p.id]);
    assert.ok(raised(await upd("confirmed_via = 'query'"), /result code 0/), "no result code");
    assert.ok(raised(await upd("result_code = 1032, confirmed_via = 'query'"), /result code 0/), "a cancelled result");
    assert.ok(raised(await upd("result_code = 0"), /confirmed/), "no confirmation");
    assert.ok(raised(await upd("result_code = 0, confirmed_via = 'callback', callback_amount = 1000"), /receipt/), "callback without a receipt");
    assert.ok(raised(await upd("result_code = 0, confirmed_via = 'callback', provider_reference = '', callback_amount = 1000"), /receipt/), "empty receipt");
    assert.ok(raised(await upd("result_code = 0, confirmed_via = 'callback', provider_reference = 'R1', callback_amount = 999"), /amount mismatch/), "callback says 999, we asked for 1000");
    assert.ok(raised(await upd("result_code = 0, confirmed_via = 'callback', provider_reference = 'R1', callback_amount = 1000.5"), /amount mismatch/), "callback says 1000.50");
    assert.ok(raised(await upd("result_code = 0, confirmed_via = 'callback', provider_reference = 'R1'"), /amount mismatch/), "callback carries no amount");
    assert.ok(raised(await upd("result_code = 0, confirmed_via = 'query', needs_review = true"), /review/), "flagged for review");
    assert.ok(raised(await upd("result_code = 0, confirmed_via = 'browser'"), /confirmed_via/), "an unknown confirmation source");
    assert.equal(await status(p.id), "pending");
    const w = await wallets(db);
    assert.equal(w.ledgerRows, 0);
    assert.equal(w.platform, 0);
    assert.ok((await upd("result_code = 0, confirmed_via = 'query'")).ok, "confirmed by an STK query (no receipt or callback amount) is fine");
  });
});

// ==================================================================================================
describe("the 70/30 split and crediting both wallets", () => {
  test("KES 1000 -> 700 coach + 300 platform, both wallets credited, both ledger rows written", async () => {
    await db.exec(`update teacher_profiles set wallet_balance = 5000 where profile_id = '${ID.T2}'`);
    const p = await newPayment(db, { amount: 1000 });
    const r = await completeAsExpected(db, p);
    assert.ok(r.ok);
    const row = await one("select status, teacher_share::text ts, platform_share::text ps, teacher_pct, platform_pct, credited_at is not null credited, completed_at is not null completed, paid_at is not null paid from payment_transactions where id = $1", [p.id]);
    assert.deepEqual([row.status, row.ts, row.ps, row.teacher_pct, row.platform_pct, row.credited, row.completed, row.paid], ["completed", "700.00", "300.00", 70, 30, true, true, true]);
    const w = await wallets(db);
    assert.equal(w.teacher(ID.T2), 5700, "the coach's existing balance is preserved and topped up");
    assert.equal(w.platform, 300);
    const ledger = await many("select account_type, teacher_id, entry_type, amount::text a, balance_after::text b, payment_transaction_id from wallet_ledger order by id");
    assert.deepEqual(ledger, [
      { account_type: "teacher", teacher_id: ID.T2, entry_type: "payment_credit", a: "700.00", b: "5700.00", payment_transaction_id: p.id },
      { account_type: "platform", teacher_id: null, entry_type: "payment_credit", a: "300.00", b: "300.00", payment_transaction_id: p.id },
    ]);
  });

  test("the two shares equal the expected amount EXACTLY for every amount tried (edge cases and 300 random ones)", async () => {
    const amounts = [1, 2, 3, 4, 5, 7, 9, 10, 11, 13, 33, 99, 101, 333, 999, 1001, 12345, 99999, 249999, 250000];
    for (let i = 0; i < 300; i++) amounts.push(1 + Math.floor(Math.random() * 250000));
    // All in one round trip: create, complete and check each payment in the database.
    await db.exec(`
      do $$
      declare a int; amounts int[] := array[${amounts.join(",")}]; s uuid; p uuid; sid uuid; t numeric; pl numeric; sum_t numeric := 0; sum_p numeric := 0; n int := 0;
      begin
        foreach a in array amounts loop
          sid := gen_random_uuid();
          insert into auth.users (id, email, raw_user_meta_data) values (sid, sid || '@t.invalid', '{"role":"student","full_name":"S"}');
          insert into subscriptions (student_id, activity_id, teacher_id, status) values (sid, '${ID.A1}', '${ID.T2}', 'pending_payment') returning id into s;
          insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status) values (s, sid, '${ID.T2}', a, 'pending') returning id into p;
          update payment_transactions set status='completed', result_code=0, confirmed_via='callback', provider_reference='SPLIT' || n, callback_amount=a where id = p
            returning teacher_share, platform_share into t, pl;
          if t + pl <> a then raise exception 'shares % + % do not equal %', t, pl, a; end if;
          if t * 100 <> a * 70 or pl * 100 <> a * 30 then raise exception 'wrong split for %: % / %', a, t, pl; end if;
          sum_t := sum_t + t; sum_p := sum_p + pl; n := n + 1;
        end loop;
        -- the wallets moved by exactly the sums, and match the ledger
        if (select wallet_balance from teacher_profiles where profile_id = '${ID.T2}') <> sum_t then raise exception 'coach wallet drift'; end if;
        if (select balance from platform_wallet) <> sum_p then raise exception 'platform wallet drift'; end if;
        if (select sum(amount) from wallet_ledger where account_type = 'teacher') <> sum_t then raise exception 'teacher ledger drift'; end if;
        if (select sum(amount) from wallet_ledger where account_type = 'platform') <> sum_p then raise exception 'platform ledger drift'; end if;
        if (select count(*) from wallet_ledger) <> 2 * n then raise exception 'ledger row count'; end if;
      end $$;`);
    // (reaching this line means every check inside the block passed: any mismatch raises and fails the test)
    assert.ok((await wallets(db)).ledgerRows >= 2 * amounts.length);
  });

  test("the existing subscription activation is unchanged: status active and the period end by billing type", async () => {
    const cases: [string, string | null][] = [["month", "30 days"], ["week", "7 days"], ["day", "1 day"], ["one-time", null], ["lesson", null]];
    for (const [billing, interval] of cases) {
      await db.query("update activities set billing = $2 where id = $1", [ID.A1, billing]);
      const p = await newPayment(db, { activity: ID.A1 });
      assert.ok((await completeAsExpected(db, p)).ok);
      const sub = await one("select status, current_period_end, now() as now from subscriptions where id = $1", [p.subscriptionId]);
      assert.equal(sub.status, "active", billing);
      if (interval) {
        const days = (new Date(String(sub.current_period_end)).getTime() - new Date(String(sub.now)).getTime()) / 86_400_000;
        assert.ok(Math.abs(days - Number.parseInt(interval, 10)) < 0.01, `${billing}: period ends in ${interval}`);
      } else {
        assert.equal(sub.current_period_end, null, `${billing}: open-ended`);
      }
    }
    await db.query("update activities set billing = 'month' where id = $1", [ID.A1]);
  });

  test("wallets always equal the ledger, including after a late success and payments to different coaches", async () => {
    const a = await newPayment(db, { amount: 700, activity: ID.A1 });
    const b = await newPayment(db, { amount: 1234, activity: ID.A2 });
    const c = await newPayment(db, { amount: 50, activity: ID.A1 });
    await driveTo(db, a, "expired");
    await completeAsExpected(db, a, { via: "query" }); // late success
    await completeAsExpected(db, b);
    await driveTo(db, c, "failed"); // credits nothing
    const w = await wallets(db);
    const led = async (type: string, teacher?: string) => Number((await one("select coalesce(sum(amount),0)::text s from wallet_ledger where account_type = $1 and ($2::uuid is null or teacher_id = $2)", [type, teacher ?? null])).s);
    assert.equal(w.teacher(ID.T2), await led("teacher", ID.T2));
    assert.equal(w.teacher(ID.T4), await led("teacher", ID.T4));
    assert.equal(w.platform, await led("platform"));
    assert.equal(w.teacher(ID.T2), 490); // 70% of 700
    assert.equal(w.teacher(ID.T4), 863.8); // 70% of 1234
    assert.equal(w.platform, 210 + 370.2);
    const last = await many("select account_type, balance_after::text b from wallet_ledger order by id desc limit 2");
    assert.equal(Number(last.find((r) => r.account_type === "platform")!.b), w.platform, "balance_after matches the wallet after the last credit");
  });
});

// ==================================================================================================
describe("idempotency and atomicity", () => {
  test("a failed, cancelled, expired or review payment credits nobody", async () => {
    for (const s of ["failed", "cancelled", "expired", "review"] as Status[]) {
      const p = await newPayment(db);
      await driveTo(db, p, s);
    }
    const w = await wallets(db);
    assert.deepEqual([w.teacher(ID.T2), w.platform, w.ledgerRows], [0, 0, 0]);
  });

  test("a late verified success (expired -> completed) credits exactly once", async () => {
    const p = await newPayment(db, { amount: 400 });
    await driveTo(db, p, "expired");
    assert.equal((await wallets(db)).ledgerRows, 0);
    assert.ok((await completeAsExpected(db, p, { via: "query" })).ok);
    assert.ok(!(await completeAsExpected(db, p, { via: "query", receipt: "OTHER" })).ok, "a second completion is refused");
    const w = await wallets(db);
    assert.deepEqual([w.teacher(ID.T2), w.platform, w.ledgerRows], [280, 120, 2]);
  });

  test("the ledger's unique key blocks a second credit, and a clash rolls the WHOLE completion back", async () => {
    const p = await newPayment(db, { amount: 1000 });
    // Simulate a stray earlier credit for this payment (inserted as the database owner).
    await db.query("insert into wallet_ledger (account_type, entry_type, amount, balance_after, payment_transaction_id) values ('platform','payment_credit', 300, 300, $1)", [p.id]);
    const r = await completeAsExpected(db, p);
    assert.ok(raised(r, /wallet_ledger_payment_credit_key/), "the duplicate platform credit is refused");
    assert.equal(await status(p.id), "pending", "the payment did not complete");
    const w = await wallets(db);
    assert.deepEqual([w.teacher(ID.T2), w.platform, w.ledgerRows], [0, 0, 1], "the coach was not credited either: it all rolled back");
  });

  test("a missing coach wallet or platform wallet makes completion fail cleanly — nothing is half-credited", async () => {
    // coach without a teacher_profiles row
    const p = await newPayment(db);
    await db.exec(`set session_replication_role = replica; delete from teacher_profiles where profile_id = '${ID.T4}'; reset session_replication_role;`);
    const q = await newPayment(db, { activity: ID.A2 });
    assert.ok(raised(await completeAsExpected(db, q), /wallet was not found/));
    assert.equal(await status(q.id), "pending");
    await db.exec(`insert into teacher_profiles (profile_id, approved) values ('${ID.T4}', true)`);

    // platform wallet row missing
    await db.exec("set session_replication_role = replica; delete from platform_wallet; reset session_replication_role;");
    assert.ok(raised(await completeAsExpected(db, p), /platform wallet was not found/));
    assert.equal(await status(p.id), "pending");
    const w = await wallets(db);
    assert.deepEqual([w.teacher(ID.T2), w.ledgerRows], [0, 0], "the coach credit was rolled back");
    await db.exec("insert into platform_wallet (id) values (true)");
  });

  test("the current callback route's completion (status + receipt only) is refused — fail closed until Phase 2", async () => {
    const p = await newPayment(db);
    const r = await attempt("service", "update payment_transactions set status = 'completed', provider_reference = 'RCPT-OLD' where id = $1", [p.id]);
    assert.ok(!r.ok, "the old route cannot complete a payment any more");
    assert.equal(await status(p.id), "pending");
    assert.equal((await wallets(db)).ledgerRows, 0);
  });
});

// ==================================================================================================
describe("browser and server protections", () => {
  const actors = (p: { student: string; teacher: string }): [string, Actor][] => [
    ["the paying student", { id: p.student }], ["the coach", { id: p.teacher }], ["another student", { id: ID.S2 }],
    ["another coach", { id: ID.T4 }], ["an admin", { id: ID.ADMIN }], ["an anonymous visitor", "anon"],
  ];

  test("nobody in a browser can create, change, complete or delete a payment (privileges AND row policies)", async () => {
    const p = await newPayment(db);
    for (const [who, actor] of actors(p)) {
      assert.ok(!(await attempt(actor, "insert into payment_transactions (subscription_id, student_id, teacher_id, amount, status) values ($1,$2,$3,1000,'pending')", [p.subscriptionId, p.student, p.teacher])).ok, `${who}: insert`);
      for (const set of ["status = 'completed'", "teacher_share = 1000", "platform_share = 0", "amount = 1", "expected_amount = 1", "credited_at = now()", "result_code = 0", "confirmed_via = 'callback'", "provider_reference = 'X'", "needs_review = true"]) {
        const r = await attempt(actor, `update payment_transactions set ${set} where id = $1`, [p.id]);
        assert.ok(!r.ok || r.rows.length === 0, `${who}: ${set}`);
      }
      assert.ok(!(await attempt(actor, "delete from payment_transactions where id = $1", [p.id])).ok, `${who}: delete`);
    }
    assert.equal(await status(p.id), "pending");
    assert.equal((await one("select teacher_share::int ts from payment_transactions where id = $1", [p.id])).ts, 0);
  });

  test("reading payments is unchanged: the student, the coach and admins see it; others don't", async () => {
    const p = await newPayment(db);
    const seen = async (actor: Actor) => { const r = await attempt(actor, "select id from payment_transactions where id = $1", [p.id]); return r.ok ? r.rows.length : "denied"; };
    assert.equal(await seen({ id: p.student }), 1);
    assert.equal(await seen({ id: p.teacher }), 1);
    assert.equal(await seen({ id: ID.ADMIN }), 1);
    assert.equal(await seen({ id: ID.S2 }), 0);
    assert.equal(await seen({ id: ID.T4 }), 0);
    assert.equal(await seen("anon"), "denied");
  });

  test("wallet balances: coaches still can't edit theirs (0012), and nobody in a browser can touch the platform wallet", async () => {
    assert.ok(raised(await attempt({ id: ID.T2 }, "update teacher_profiles set wallet_balance = 999999 where profile_id = $1", [ID.T2]), /payment system/));
    assert.ok(raised(await attempt({ id: ID.ADMIN }, "update teacher_profiles set wallet_balance = 1 where profile_id = $1", [ID.T2]), /payment system/));

    const adminRead = await attempt({ id: ID.ADMIN }, "select balance from platform_wallet");
    assert.ok(adminRead.ok && adminRead.rows.length === 1, "an admin can read it");
    for (const actor of [{ id: ID.S1 }, { id: ID.T2 }] as Actor[]) assert.ok(nothing(await attempt(actor, "select balance from platform_wallet")), "students and coaches see nothing");
    assert.ok(!(await attempt("anon", "select balance from platform_wallet")).ok);
    for (const actor of [{ id: ID.ADMIN }, { id: ID.T2 }, { id: ID.S1 }, "anon"] as Actor[]) {
      assert.ok(!(await attempt(actor, "update platform_wallet set balance = 999999")).ok, "no browser session can change the balance");
      assert.ok(!(await attempt(actor, "insert into platform_wallet (id, balance) values (false, 5)")).ok);
      assert.ok(!(await attempt(actor, "delete from platform_wallet")).ok);
    }
    // the server (payment system) can change it, but nobody can remove it
    assert.ok((await attempt("service", "update platform_wallet set balance = balance + 1")).ok);
    assert.ok(!(await attempt("service", "delete from platform_wallet")).ok);
    assert.ok(!(await attempt("service", "truncate platform_wallet")).ok);
    assert.ok(raised(await attempt("service", "insert into platform_wallet (id) values (false)"), /platform_wallet_id_check|violates/), "there can only ever be one row");
    await db.query("update platform_wallet set balance = 0");
  });

  test("the ledger is append-only and read-only: no browser or server session, not even the owner, can forge or change an entry", async () => {
    const p = await newPayment(db, { amount: 1000 });
    await completeAsExpected(db, p);
    const rowsFor = async (actor: Actor) => { const r = await attempt(actor, "select account_type from wallet_ledger"); return r.ok ? r.rows.map((x) => x.account_type) : "denied"; };
    assert.deepEqual(await rowsFor({ id: p.teacher }), ["teacher"], "a coach sees only their own entry");
    assert.deepEqual(await rowsFor({ id: ID.T4 }), [], "another coach sees nothing");
    assert.deepEqual(await rowsFor({ id: p.student }), [], "the student sees nothing");
    assert.deepEqual((await rowsFor({ id: ID.ADMIN }) as string[]).sort(), ["platform", "teacher"], "an admin sees everything");
    assert.equal(await rowsFor("anon"), "denied");
    assert.deepEqual((await rowsFor("service") as string[]).sort(), ["platform", "teacher"], "the server can read");

    for (const actor of [{ id: p.teacher }, { id: ID.ADMIN }, { id: p.student }, "anon", "service"] as Actor[]) {
      assert.ok(!(await attempt(actor, "insert into wallet_ledger (account_type, entry_type, amount, balance_after, payment_transaction_id) values ('platform','payment_credit',1,1,$1)", [p.id])).ok, "insert");
      assert.ok(!(await attempt(actor, "update wallet_ledger set amount = 1")).ok, "update");
      assert.ok(!(await attempt(actor, "delete from wallet_ledger")).ok, "delete");
      assert.ok(!(await attempt(actor, "truncate wallet_ledger")).ok, "truncate");
    }
    // even the database owner is stopped by the triggers
    await assert.rejects(db.exec("update wallet_ledger set amount = 1"), /append-only/);
    await assert.rejects(db.exec("delete from wallet_ledger"), /append-only/);
    await assert.rejects(db.exec("truncate wallet_ledger"), /append-only/);
    assert.equal((await wallets(db)).ledgerRows, 2);
  });

  test("the callback log is admin-read-only and append-only", async () => {
    const payload = JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: "ws_CO_9", ResultCode: 0 } } });
    const first = await attempt("service", "insert into mpesa_callbacks (outcome, checkout_request_id, result_code, payload) values ('received', 'ws_CO_9', 0, $1::jsonb) returning id", [payload]);
    assert.ok(first.ok, "the server can log a callback");
    const id = (first as unknown as { rows: { id: string }[] }).rows[0].id;
    assert.ok((await attempt("service", "insert into mpesa_callbacks (parent_id, outcome, checkout_request_id, payload) values ($1, 'credited', 'ws_CO_9', $2::jsonb)", [id, payload])).ok, "…and an outcome row pointing back at it");
    assert.ok(!(await attempt("service", "insert into mpesa_callbacks (outcome, payload) values ('made_up', '{}'::jsonb)")).ok, "outcomes are a fixed list");
    assert.equal(((await attempt({ id: ID.ADMIN }, "select id from mpesa_callbacks")) as { rows: unknown[] }).rows.length, 2, "an admin can read them");
    for (const actor of [{ id: ID.S1 }, { id: ID.T2 }] as Actor[]) assert.ok(nothing(await attempt(actor, "select id from mpesa_callbacks")));
    assert.ok(!(await attempt("anon", "select id from mpesa_callbacks")).ok);
    for (const actor of [{ id: ID.ADMIN }, { id: ID.T2 }, { id: ID.S1 }, "anon"] as Actor[]) {
      assert.ok(!(await attempt(actor, "insert into mpesa_callbacks (outcome, payload) values ('received','{}'::jsonb)")).ok, "no browser insert");
    }
    for (const sql of ["update mpesa_callbacks set outcome = 'rejected'", "delete from mpesa_callbacks", "truncate mpesa_callbacks"]) {
      assert.ok(!(await attempt("service", sql)).ok, `the server cannot: ${sql}`);
      await assert.rejects(db.exec(sql), /append-only/, `not even the owner: ${sql}`);
    }
  });

  test("the new database functions cannot be called from a browser", async () => {
    for (const actor of [{ id: ID.T2 }, { id: ID.ADMIN }, "anon"] as Actor[]) {
      assert.ok(raised(await attempt(actor, "select payment_split_teacher_pct()"), /permission denied/i));
    }
    assert.equal(Number(((await attempt("service", "select payment_split_teacher_pct() as p")) as unknown as { rows: { p: number }[] }).rows[0].p), 70);
  });
});

// ==================================================================================================
describe("the existing coach wallet and withdrawal system keeps working", () => {
  test("a payment credit can be requested, paid out and reversed with the existing rules", async () => {
    const p = await newPayment(db, { amount: 1000 });
    await completeAsExpected(db, p); // coach T2 now has 700
    assert.equal((await wallets(db)).teacher(ID.T2), 700);

    const req = await attempt({ id: ID.T2 }, "insert into withdrawal_requests (teacher_id, amount, destination) values ($1, 500, '0711222333') returning id, status", [ID.T2]);
    assert.ok(req.ok, "a coach can still request up to their balance");
    const wid = (req as unknown as { rows: { id: string }[] }).rows[0].id;
    assert.ok(raised(await attempt({ id: ID.T2 }, "insert into withdrawal_requests (teacher_id, amount, destination) values ($1, 701, 'x')", [ID.T2]), /exceeds/), "…but not more");

    assert.ok((await attempt("service", "update withdrawal_requests set status = 'successful', provider_reference = 'PAYOUT-1' where id = $1", [wid])).ok);
    assert.equal((await wallets(db)).teacher(ID.T2), 200, "the payout debited the wallet");
    assert.ok((await attempt("service", "update withdrawal_requests set status = 'reversed' where id = $1", [wid])).ok);
    assert.equal((await wallets(db)).teacher(ID.T2), 700, "the reversal credited it back");
    assert.equal((await wallets(db)).ledgerRows, 2, "Phase 1 records payment credits only; withdrawal entries come later (the ledger is already shaped for them)");
  });

  test("the ledger is shaped for future withdrawal entries (debit / reversal), with the right sign and uniqueness rules", async () => {
    const p = await newPayment(db, { amount: 1000 });
    await completeAsExpected(db, p);
    await db.query("insert into withdrawal_requests (teacher_id, amount, destination) values ($1, 100, 'x')", [ID.T2]);
    const w = (await one("select id from withdrawal_requests limit 1")).id;
    const ins = (type: string, amount: number) => db.query("insert into wallet_ledger (account_type, teacher_id, entry_type, amount, balance_after, withdrawal_request_id) values ('teacher', $1, $2, $3, 600, $4)", [ID.T2, type, amount, w]);
    await ins("withdrawal_debit", -100);
    await assert.rejects(ins("withdrawal_debit", -100), /wallet_ledger_withdrawal_key/, "one debit per withdrawal");
    await ins("withdrawal_reversal", 100);
    await assert.rejects(ins("withdrawal_debit", 100), /entry_matches_source|withdrawal_key/, "a debit must be negative");
    await assert.rejects(db.query("insert into wallet_ledger (account_type, entry_type, amount, balance_after, payment_transaction_id, withdrawal_request_id) values ('platform','payment_credit', 1, 1, $1, $2)", [p.id, w]), /one_source/, "an entry has exactly one source");
  });
});
