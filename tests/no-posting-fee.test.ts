// Business rule: posting a project is FREE for coaches/teachers; the only money is a student/parent payment,
// split 70% coach / 30% MTH. These tests run against the repository's ACTUAL migrations (incl. 0022).

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, readMigration } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import { attemptOn, completeAsExpected, newPayment, resetPayments, wallets } from "./helpers/payments";

const MIGRATION = "0022_remove_coach_activation_fee.sql";
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

describe("no fee is charged for posting", () => {
  test("the activation fee setting, its table and the activated flag are gone from the database", async () => {
    const setting = await db.query("select 1 from platform_settings where key = 'coach_activation_fee_kes'");
    assert.equal(setting.rows.length, 0);
    const table = await db.query("select to_regclass('public.coach_activation_payments') as t");
    assert.equal((table.rows[0] as { t: unknown }).t, null);
    const cols = await db.query("select 1 from information_schema.columns where table_name = 'teacher_profiles' and column_name in ('activated', 'activated_at')");
    assert.equal(cols.rows.length, 0);
  });

  test("an approved coach creates and publishes an activity and a lesson with no payment, and no money moves", async () => {
    const before = await wallets(db);
    const activity = await attempt({ id: ID.T2 }, "insert into activities (teacher_id, category, activity_type, title, status, price) values ($1, 'sports', 'football', 'New club', 'published', 500) returning status", [ID.T2]);
    assert.ok(activity.ok && activity.rows[0].status === "published", activity.ok ? "" : activity.error);
    const lesson = await attempt({ id: ID.T1 }, "insert into lessons (subject_id, teacher_id, title, status) values ($1, $2, 'Fractions', 'published') returning status", [ID.SUBJECT, ID.T1]);
    assert.ok(lesson.ok && lesson.rows[0].status === "published", lesson.ok ? "" : lesson.error);
    const payments = await db.query("select count(*)::int as n from payment_transactions");
    assert.equal((payments.rows[0] as { n: number }).n, 0);
    assert.deepEqual(await wallets(db), before);
  });
});

describe("a student payment is still split 70 / 30", () => {
  test("KES 1000 paid by a student -> 700 to the coach, 300 to MTH, recorded on the payment", async () => {
    const p = await newPayment(db, { amount: 1000, activity: ID.A1 });
    const w0 = await wallets(db);
    await completeAsExpected(db, p);
    const w1 = await wallets(db);
    const row = (await db.query<Record<string, unknown>>(
      "select amount::text a, teacher_share::text ts, platform_share::text ps, teacher_pct, platform_pct, status, provider_reference, completed_at is not null as dated from payment_transactions where id = $1",
      [p.id],
    )).rows[0];
    assert.deepEqual([row.a, row.ts, row.ps, row.teacher_pct, row.platform_pct, row.status, row.dated], ["1000.00", "700.00", "300.00", 70, 30, "completed", true]);
    assert.ok(String(row.provider_reference).length > 0, "has a transaction reference");
    assert.equal(w1.teacher(p.teacher) - w0.teacher(p.teacher), 700);
    assert.equal(w1.platform - w0.platform, 300);
  });
});

describe("migration 0022", () => {
  test("it is safe to run a second time", async () => {
    await db.exec(readMigration(MIGRATION));
    const after = await db.query("select to_regclass('public.coach_activation_payments') as t");
    assert.equal((after.rows[0] as { t: unknown }).t, null);
  });

  test("it removes the old fee from a database that still has it, and keeps any activation payment records", async () => {
    // Build the world as it was before 0022 (everything up to 0021).
    const old = await createTestDb({ include: (f) => f < "0022" });
    await seedWorld(old);
    await old.exec("insert into platform_settings (key, value) values ('coach_activation_fee_kes', '50')");
    await old.exec(readMigration(MIGRATION));
    assert.equal((await old.query("select 1 from platform_settings where key = 'coach_activation_fee_kes'")).rows.length, 0);
    assert.equal(((await old.query("select to_regclass('public.coach_activation_payments') as t")).rows[0] as { t: unknown }).t, null);

    // With a real activation payment on file the table is kept (financial records are never dropped silently).
    const kept = await createTestDb({ include: (f) => f < "0022" });
    await seedWorld(kept);
    await kept.exec(`insert into coach_activation_payments (teacher_id, amount, phone, status) values ('${ID.T1}', 50, '254700000000', 'failed')`);
    await kept.exec(readMigration(MIGRATION));
    assert.equal(((await kept.query("select count(*)::int as n from coach_activation_payments")).rows[0] as { n: number }).n, 1);
  });
});

describe("no fee code is left in the application", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      if (n === "node_modules" || n === ".next") return [];
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  test("nothing under app/, lib/ or components/ references the activation fee or its routes", () => {
    const bad = /coach_activation|COACH_ACTIVATION|ACTIVATION_FEE|activateCoachForFree|getCoachActivationFee|\/api\/mpesa\/activation|teacher\/activate\b/;
    const hits = ["app", "lib", "components"].flatMap(walk).filter((f) => bad.test(readFileSync(f, "utf8")));
    assert.deepEqual(hits, []);
  });
});
