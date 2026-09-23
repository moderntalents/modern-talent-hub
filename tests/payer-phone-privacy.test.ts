// Privacy fix (migration 0015): the payer's phone numbers on payment_transactions (phone, callback_phone)
// must not be readable by the coach — neither through the app's pages nor through their own database
// access — while the paying student and administrators keep access through payment_payer_phone(), and the
// server keeps full access for verification and reconciliation.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type Actor } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import { attemptOn, newPayment, resetPayments, type PaymentRef } from "./helpers/payments";
import { PAYMENT_VISIBLE_COLUMNS } from "../lib/payment-columns";

let db: PGlite;
let attempt: ReturnType<typeof attemptOn>;
let p: PaymentRef;

const PHONE = "254712345678";
const CALLBACK_PHONE = "254712***678";

before(async () => {
  db = await createTestDb();
  attempt = attemptOn(db);
  await seedWorld(db);
});

beforeEach(async () => {
  await resetPayments(db);
  p = await newPayment(db, { phone: PHONE }); // student S? → coach T2 (activity A1)
  await db.query("update payment_transactions set callback_phone = $2 where id = $1", [p.id, CALLBACK_PHONE]);
});

const denied = (o: { ok: boolean; error?: string }) => !o.ok && /permission denied/i.test(o.error ?? "");
const payerPhone = (actor: Actor) => attempt(actor, "select phone, callback_phone from payment_payer_phone($1)", [p.id]);

describe("the coach cannot see the payer's phone number", () => {
  test("direct selects of phone / callback_phone / * are refused for the coach", async () => {
    const coach: Actor = { id: p.teacher };
    assert.ok(denied(await attempt(coach, "select phone from payment_transactions where id = $1", [p.id])), "phone");
    assert.ok(denied(await attempt(coach, "select callback_phone from payment_transactions where id = $1", [p.id])), "callback_phone");
    assert.ok(denied(await attempt(coach, "select * from payment_transactions where id = $1", [p.id])), "select *");
    assert.ok(denied(await attempt(coach, "select id from payment_transactions where phone = $1", [PHONE])), "filtering on phone");
    assert.ok(denied(await attempt(coach, "select to_jsonb(pt) from payment_transactions pt")), "whole-row tricks");
  });

  test("the coach still reads their payments through the page column list — with no phone in it", async () => {
    const r = await attempt({ id: p.teacher }, `select ${PAYMENT_VISIBLE_COLUMNS} from payment_transactions where teacher_id = $1`, [p.teacher]);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].id, p.id);
    assert.ok(!("phone" in r.rows[0]) && !("callback_phone" in r.rows[0]));
    assert.ok(!JSON.stringify(r.rows[0]).includes("712"), "the number appears nowhere in what the coach gets");
  });

  test("payment_payer_phone() gives the coach, other coaches and other students nothing", async () => {
    for (const actor of [{ id: p.teacher }, { id: ID.T4 }, { id: ID.S2 }, { id: ID.S7 }] as Actor[]) {
      const r = await payerPhone(actor);
      assert.ok(r.ok && r.rows.length === 0, JSON.stringify(actor));
    }
    assert.ok(denied(await payerPhone("anon")), "anonymous visitors cannot even call it");
  });
});

describe("people who legitimately need the number keep access", () => {
  test("the paying student sees their own payment's numbers through payment_payer_phone()", async () => {
    const r = await payerPhone({ id: p.student });
    assert.ok(r.ok);
    assert.deepEqual(r.rows, [{ phone: PHONE, callback_phone: CALLBACK_PHONE }]);
  });

  test("an administrator sees any payment's numbers through payment_payer_phone()", async () => {
    const r = await payerPhone({ id: ID.ADMIN });
    assert.ok(r.ok);
    assert.deepEqual(r.rows, [{ phone: PHONE, callback_phone: CALLBACK_PHONE }]);
  });

  test("students and admins still read every other column of the rows they could read before", async () => {
    for (const actor of [{ id: p.student }, { id: ID.ADMIN }] as Actor[]) {
      const r = await attempt(actor, `select ${PAYMENT_VISIBLE_COLUMNS} from payment_transactions where id = $1`, [p.id]);
      assert.ok(r.ok && r.rows.length === 1, JSON.stringify(actor));
    }
    // …and the row-level rule is unchanged: an unrelated student or coach sees no row at all.
    for (const actor of [{ id: ID.S7 }, { id: ID.T4 }] as Actor[]) {
      const r = await attempt(actor, "select id from payment_transactions where id = $1", [p.id]);
      assert.ok(r.ok && r.rows.length === 0, JSON.stringify(actor));
    }
  });

  test("the server (service role) still reads and writes the numbers for verification and reconciliation", async () => {
    const r = await attempt("service", "select phone, callback_phone from payment_transactions where id = $1", [p.id]);
    assert.ok(r.ok);
    assert.deepEqual(r.rows, [{ phone: PHONE, callback_phone: CALLBACK_PHONE }]);
    const w = await attempt("service", "update payment_transactions set callback_phone = $2 where id = $1 and status = 'pending'", [p.id, PHONE]);
    assert.ok(w.ok);
  });
});

describe("the visible column list stays in step with the database", () => {
  test("PAYMENT_VISIBLE_COLUMNS is exactly every column except phone and callback_phone, and matches the grant", async () => {
    const all = (await db.query<{ c: string }>(
      "select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'payment_transactions' order by ordinal_position",
    )).rows.map((r) => r.c);
    const granted = (await db.query<{ c: string }>(
      "select column_name as c from information_schema.column_privileges where table_name = 'payment_transactions' and grantee = 'authenticated' and privilege_type = 'SELECT'",
    )).rows.map((r) => r.c);
    const listed = PAYMENT_VISIBLE_COLUMNS.split(",").map((c) => c.trim());

    const expected = all.filter((c) => c !== "phone" && c !== "callback_phone").sort();
    assert.deepEqual([...listed].sort(), expected);
    assert.deepEqual([...granted].sort(), expected);
  });

  test("no page or server file selects \"*\" from payment_transactions as the signed-in person", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk("app");
    walk("lib");
    walk("components");
    const offenders = files.filter((f) =>
      /from\("payment_transactions"\)\s*\.select\(\s*["'`]\*/.test(readFileSync(f, "utf8")),
    );
    assert.deepEqual(offenders, []);
  });
});
