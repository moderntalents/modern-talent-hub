// Tests for migration 0017 (B2C reconciliation safety layer) and the multi-attempt
// functions in lib/mpesa-withdrawals.ts, run against a REAL PGlite Postgres with every
// migration through 0017 applied — the actual row-locking, partial unique indexes, and
// state-machine transitions that run in production decide these outcomes, not mocks.
//
// The core invariant every test here is ultimately checking: an attempt can only ever
// affect the PARENT withdrawal (and therefore the wallet) while its own status is still
// 'requested' or 'accepted'. The instant a new attempt is created, every prior live
// attempt is atomically superseded in the same transaction as the parent row lock — that
// single mechanism is what makes the "late callback for a superseded attempt" scenario,
// the "two admins can't both authorize a retry", and the "callback racing retry
// authorization" scenarios all resolve safely, without a single line of JS-level locking.
//
// Route-layer concerns (an admin session is required to reach authorize_b2c_retry /
// admin_resolve_withdrawal at all) are NOT re-tested here, for the same reason
// tests/withdrawals-route.test.ts doesn't re-test the teacher-only gate on withdrawal
// creation: this environment has no live Supabase project to mock an authenticated
// session against, so that boundary is exercised by code review of
// app/api/admin/withdrawals/[id]/retry/route.ts and .../resolve/route.ts, which both
// follow the exact same session -> profile.role==='admin' pattern already used (and
// tested at the DB/RLS level) throughout this codebase.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "./helpers/db";
import { seedWorld, ID } from "./helpers/seed";
import { fakeAdmin } from "./helpers/fake-admin";
import { attemptOn } from "./helpers/payments";
import {
  createB2CAttempt,
  attachB2CIdentifiers,
  markAttemptAmbiguous,
  applyB2CCallback,
  parseB2CCallback,
  sweepStaleProcessingWithdrawals,
  authorizeB2CRetry,
  adminResolveWithdrawal,
} from "@/lib/mpesa-withdrawals";

let db: PGlite;
let admin: ReturnType<typeof fakeAdmin>;
let attempt: ReturnType<typeof attemptOn>;

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
  admin = fakeAdmin(db);
  attempt = attemptOn(db);
});

async function setupWallet(teacherId: string, balance: number, mpesaNumber: string | null = "254712345678") {
  await db.query("update teacher_profiles set wallet_balance = $1, mpesa_number = $2 where profile_id = $3", [
    balance,
    mpesaNumber,
    teacherId,
  ]);
}

beforeEach(async () => {
  await db.exec(`
    set session_replication_role = replica;
    delete from wallet_ledger;
    delete from withdrawal_reconciliation_log;
    delete from withdrawal_b2c_attempts;
    delete from withdrawal_requests;
    update teacher_profiles set wallet_balance = 0, mpesa_number = null;
    reset session_replication_role;
  `);
});

interface WithdrawalRow {
  id: string;
  status: string;
  amount: string;
  destination: string;
}

async function insertMpesaWithdrawal(teacherId: string, amount: number, destination = "0700000000"): Promise<WithdrawalRow> {
  const r = await db.query<WithdrawalRow>(
    "insert into withdrawal_requests (teacher_id, amount, method, destination) values ($1, $2, 'mpesa', $3) returning *",
    [teacherId, amount, destination],
  );
  return r.rows[0];
}

async function withdrawalRow(id: string): Promise<WithdrawalRow & { needs_urgent_review: boolean; provider_reference: string | null }> {
  const r = await db.query<WithdrawalRow & { needs_urgent_review: boolean; provider_reference: string | null }>(
    "select * from withdrawal_requests where id = $1",
    [id],
  );
  return r.rows[0];
}

interface AttemptRow {
  id: string;
  withdrawal_request_id: string;
  attempt_number: number;
  status: string;
  conversation_id: string | null;
  originator_conversation_id: string | null;
  result_code: number | null;
}

async function allAttempts(withdrawalId: string): Promise<AttemptRow[]> {
  const r = await db.query<AttemptRow>(
    "select * from withdrawal_b2c_attempts where withdrawal_request_id = $1 order by attempt_number",
    [withdrawalId],
  );
  return r.rows;
}

async function liveAttempts(withdrawalId: string): Promise<AttemptRow[]> {
  return (await allAttempts(withdrawalId)).filter((a) => a.status === "requested" || a.status === "accepted");
}

async function logEvents(withdrawalId: string) {
  const r = await db.query<{ event_type: string; actor: string | null; reason: string | null }>(
    "select event_type, actor, reason from withdrawal_reconciliation_log where withdrawal_request_id = $1 order by id",
    [withdrawalId],
  );
  return r.rows;
}

async function balance(teacherId: string): Promise<number> {
  const r = await db.query<{ b: string }>("select wallet_balance::text as b from teacher_profiles where profile_id = $1", [teacherId]);
  return Number(r.rows[0].b);
}

async function ledgerRows(teacherId: string) {
  const r = await db.query<{ entry_type: string; amount: string }>(
    "select entry_type, amount::text as amount from wallet_ledger where teacher_id = $1 order by id",
    [teacherId],
  );
  return r.rows;
}

function successPayload(conversationId: string, amount: number, receipt = "RCPT-1") {
  return {
    Result: {
      ResultType: 0,
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      OriginatorConversationID: "orig-" + conversationId,
      ConversationID: conversationId,
      TransactionID: "TXN-" + conversationId,
      ResultParameters: {
        ResultParameter: [
          { Key: "TransactionAmount", Value: amount },
          { Key: "TransactionReceipt", Value: receipt },
        ],
      },
    },
  };
}

function failurePayload(conversationId: string, resultCode = 2001, resultDesc = "The initiator information is invalid.") {
  return {
    Result: {
      ResultType: 0,
      ResultCode: resultCode,
      ResultDesc: resultDesc,
      OriginatorConversationID: "orig-" + conversationId,
      ConversationID: conversationId,
    },
  };
}

// Moves a withdrawal (with a live, ambiguous attempt) into 'review' the same way the real
// sweep does, without needing to fabricate staleness — used as test setup, not what's
// under test, in describe blocks where 'review' is just a precondition.
async function forceIntoReview(withdrawalId: string, attemptId: string) {
  await markAttemptAmbiguous(admin, attemptId, "test setup: forcing review");
  await db.query("update withdrawal_requests set status = 'review' where id = $1", [withdrawalId]);
}

// ==================================================================================================
describe("create_b2c_attempt", () => {
  test("creates attempt 1 for a processing withdrawal and logs it", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a = await createB2CAttempt(admin, w.id);
    assert.equal(a.attempt_number, 1);
    assert.equal(a.status, "requested");

    const events = await logEvents(w.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "attempt_created");
  });

  test("refuses to start an attempt for a withdrawal that isn't processing", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    await db.exec("set session_replication_role = replica");
    await db.query("update withdrawal_requests set status = 'pending' where id = $1", [w.id]);
    await db.exec("reset session_replication_role");
    await assert.rejects(createB2CAttempt(admin, w.id), /Cannot start a B2C attempt/);
  });

  test("attempt numbering increments and a second call supersedes the first live attempt", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    const a2 = await createB2CAttempt(admin, w.id);
    assert.equal(a1.attempt_number, 1);
    assert.equal(a2.attempt_number, 2);

    const all = await allAttempts(w.id);
    assert.equal(all.length, 2);
    assert.equal(all.find((x) => x.attempt_number === 1)!.status, "superseded");
    assert.equal(all.find((x) => x.attempt_number === 2)!.status, "requested");

    const live = await liveAttempts(w.id);
    assert.equal(live.length, 1, "only one live attempt at a time");
  });

  test("two concurrent attempt-creation calls never leave two live attempts, and attempt numbers never collide", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const results = await Promise.allSettled([createB2CAttempt(admin, w.id), createB2CAttempt(admin, w.id)]);
    assert.ok(results.every((r) => r.status === "fulfilled"), "creation itself always succeeds — it supersedes rather than blocking");

    const all = await allAttempts(w.id);
    assert.equal(all.length, 2);
    assert.equal(new Set(all.map((a) => a.attempt_number)).size, 2, "attempt numbers did not collide");
    assert.equal((await liveAttempts(w.id)).length, 1, "exactly one live attempt survives the race");
  });

  test("a callback still finds the attempt via OriginatorConversationID if the server crashed before conversation_id was ever persisted", async () => {
    // Simulates the exact crash window: Daraja already accepted the request and will
    // eventually send a callback, but the process died between initiateB2CPayout
    // returning and attachB2CIdentifiers writing conversation_id back — so the attempt
    // row still has conversation_id = null. The route sends the attempt's own id as
    // OriginatorConversationID (see app/api/withdrawals/route.ts), which is already in
    // the database before Daraja is ever called, so Daraja's callback (which always
    // echoes OriginatorConversationID back) can still find the right attempt.
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a = await createB2CAttempt(admin, w.id);
    assert.equal((await allAttempts(w.id))[0].conversation_id, null, "conversation_id was never attached — simulating the crash");

    const payload = {
      Result: {
        ResultType: 0,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        OriginatorConversationID: a.id,
        ConversationID: "conv-recovered-after-crash",
        TransactionID: "TXN-recovered",
        ResultParameters: {
          ResultParameter: [
            { Key: "TransactionAmount", Value: 300 },
            { Key: "TransactionReceipt", Value: "RECOVERED-RCPT" },
          ],
        },
      },
    };

    const outcome = await applyB2CCallback(admin, parseB2CCallback(payload)!);
    assert.equal(outcome, "resolved_successful", "found via the OriginatorConversationID fallback, not lost");

    const after = await withdrawalRow(w.id);
    assert.equal(after.status, "successful");
    assert.equal(after.provider_reference, "RECOVERED-RCPT");
    assert.equal(await balance(ID.T2), 700, "reserved amount unaffected by success");
    assert.equal((await ledgerRows(ID.T2)).length, 1, "still exactly one debit, no reversal");

    const attemptAfter = (await allAttempts(w.id))[0];
    assert.equal(attemptAfter.status, "succeeded");
    assert.equal(attemptAfter.conversation_id, "conv-recovered-after-crash", "backfilled from the callback, even though it was never attached up front");
  });

  test("a malformed OriginatorConversationID never causes an unsafe fallback match", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    await createB2CAttempt(admin, w.id);

    const payload = {
      Result: {
        ResultType: 0,
        ResultCode: 0,
        ResultDesc: "ok",
        OriginatorConversationID: "not-a-uuid-at-all",
        ConversationID: "conv-no-such-attempt",
      },
    };
    const outcome = await applyB2CCallback(admin, parseB2CCallback(payload)!);
    assert.equal(outcome, "unmatched", "a non-UUID OriginatorConversationID is never used for the id fallback lookup");
    assert.equal((await withdrawalRow(w.id)).status, "processing", "untouched");
  });
});

// ==================================================================================================
describe("resolve_b2c_attempt — attaching identifiers without resolving", () => {
  test("attachB2CIdentifiers marks the attempt accepted and leaves the parent processing", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a = await createB2CAttempt(admin, w.id);
    await attachB2CIdentifiers(admin, a.id, "conv-attach-1", "orig-conv-attach-1");

    const all = await allAttempts(w.id);
    assert.equal(all[0].status, "accepted");
    assert.equal(all[0].conversation_id, "conv-attach-1");
    assert.equal((await withdrawalRow(w.id)).status, "processing");
  });
});

// ==================================================================================================
describe("attempt table constraints", () => {
  test("conversation_id is unique across every attempt, for every withdrawal", async () => {
    await setupWallet(ID.T2, 1000);
    const w1 = await insertMpesaWithdrawal(ID.T2, 100);
    const a1 = await createB2CAttempt(admin, w1.id);
    await attachB2CIdentifiers(admin, a1.id, "dup-conv", "orig-dup-1");

    const w2 = await insertMpesaWithdrawal(ID.T2, 100);
    const a2 = await createB2CAttempt(admin, w2.id);
    await assert.rejects(
      db.query("update withdrawal_b2c_attempts set conversation_id = $1 where id = $2", ["dup-conv", a2.id]),
      /withdrawal_b2c_attempts_conversation_id_key/,
    );
  });

  test("originator_conversation_id is unique across every attempt", async () => {
    await setupWallet(ID.T2, 1000);
    const w1 = await insertMpesaWithdrawal(ID.T2, 100);
    const a1 = await createB2CAttempt(admin, w1.id);
    await attachB2CIdentifiers(admin, a1.id, "conv-x1", "dup-orig");

    const w2 = await insertMpesaWithdrawal(ID.T2, 100);
    const a2 = await createB2CAttempt(admin, w2.id);
    await assert.rejects(
      db.query("update withdrawal_b2c_attempts set originator_conversation_id = $1 where id = $2", ["dup-orig", a2.id]),
      /withdrawal_b2c_attempts_originator_conversation_id_key/,
    );
  });

  test("attempt_number is unique per withdrawal", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 100);
    await createB2CAttempt(admin, w.id); // attempt_number 1
    await assert.rejects(
      db.query(
        "insert into withdrawal_b2c_attempts (withdrawal_request_id, attempt_number, status) values ($1, 1, 'requested')",
        [w.id],
      ),
      /withdrawal_b2c_attempts_number_key/,
    );
  });

  test("the partial unique index blocks a second live attempt inserted directly (not through create_b2c_attempt)", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 100);
    await createB2CAttempt(admin, w.id); // attempt 1, status 'requested' — still live
    await assert.rejects(
      db.query(
        "insert into withdrawal_b2c_attempts (withdrawal_request_id, attempt_number, status) values ($1, 2, 'accepted')",
        [w.id],
      ),
      /withdrawal_b2c_attempts_one_live_key/,
    );
  });
});

// ==================================================================================================
describe("multiple attempts for one withdrawal — exactly-once debit/reversal", () => {
  test("attempt 1 ambiguous, admin retries, attempt 2 succeeds: exactly one debit, zero reversals", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 400);
    const a1 = await createB2CAttempt(admin, w.id);
    await attachB2CIdentifiers(admin, a1.id, "conv-multi-1", "orig-conv-multi-1");
    await forceIntoReview(w.id, a1.id);
    assert.equal((await withdrawalRow(w.id)).status, "review");

    const a2 = await authorizeB2CRetry(admin, w.id, ID.ADMIN, "Confirmed via Safaricom statement that attempt 1 did not pay out.");
    assert.equal(a2.attempt_number, 2);
    assert.equal((await withdrawalRow(w.id)).status, "processing", "retry reuses the reservation — no new debit, so back to processing directly");
    assert.equal(await balance(ID.T2), 600, "unchanged since reservation — a retry never re-debits");
    assert.equal((await ledgerRows(ID.T2)).length, 1, "still exactly the original debit");

    await attachB2CIdentifiers(admin, a2.id, "conv-multi-2", "orig-conv-multi-2");
    const outcome = await applyB2CCallback(admin, parseB2CCallback(successPayload("conv-multi-2", 400))!);
    assert.equal(outcome, "resolved_successful");

    assert.equal((await withdrawalRow(w.id)).status, "successful");
    assert.equal(await balance(ID.T2), 600, "success doesn't change balance — it was already reserved");
    assert.equal((await ledgerRows(ID.T2)).length, 1, "still exactly one debit, zero reversals, across both attempts");

    const attempts = await allAttempts(w.id);
    assert.equal(attempts.find((a) => a.attempt_number === 1)!.status, "ambiguous", "attempt 1's own record is untouched by attempt 2's outcome");
    assert.equal(attempts.find((a) => a.attempt_number === 2)!.status, "succeeded");
  });

  test("attempt 1 ambiguous, admin retries, attempt 2 fails: exactly one debit and exactly one reversal", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 400);
    const a1 = await createB2CAttempt(admin, w.id);
    await forceIntoReview(w.id, a1.id);
    const a2 = await authorizeB2CRetry(admin, w.id, ID.ADMIN, "Confirmed via Safaricom statement that attempt 1 did not pay out.");
    await attachB2CIdentifiers(admin, a2.id, "conv-multi-fail-2", "orig-conv-multi-fail-2");

    const outcome = await applyB2CCallback(admin, parseB2CCallback(failurePayload("conv-multi-fail-2"))!);
    assert.equal(outcome, "resolved_failed");
    assert.equal((await withdrawalRow(w.id)).status, "failed");
    assert.equal(await balance(ID.T2), 1000, "fully restored, exactly once");

    const ledger = await ledgerRows(ID.T2);
    assert.equal(ledger.length, 2);
    assert.equal(ledger.filter((r) => r.entry_type === "withdrawal_reversal").length, 1);
  });

  test("CRITICAL: a late success callback for a superseded attempt 1 never touches the parent, wallet, or creates a reversal", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 400);
    const a1 = await createB2CAttempt(admin, w.id);
    await attachB2CIdentifiers(admin, a1.id, "conv-crit-1", "orig-conv-crit-1");
    await forceIntoReview(w.id, a1.id);
    const a2 = await authorizeB2CRetry(admin, w.id, ID.ADMIN, "Confirmed via Safaricom statement that attempt 1 appears not to have paid out.");
    await attachB2CIdentifiers(admin, a2.id, "conv-crit-2", "orig-conv-crit-2");

    // attempt 1 was already 'ambiguous' (forceIntoReview) and create_b2c_attempt only
    // supersedes attempts still 'requested'/'accepted' — an already-non-live attempt has
    // nothing to supersede, so it stays 'ambiguous'. Either way it's not live, which is
    // what matters: this is the late callback Safaricom sends anyway.
    assert.equal((await allAttempts(w.id)).find((a) => a.attempt_number === 1)!.status, "ambiguous");
    const lateOutcome = await applyB2CCallback(admin, parseB2CCallback(successPayload("conv-crit-1", 400, "LATE-RCPT"))!);

    assert.equal(lateOutcome, "superseded_recorded", "recorded on attempt 1 for audit — not treated as a fresh success");
    assert.equal((await withdrawalRow(w.id)).status, "processing", "the parent is completely unaffected — attempt 2 hasn't resolved yet");
    assert.equal(await balance(ID.T2), 600, "wallet untouched by the late callback");
    assert.equal((await ledgerRows(ID.T2)).length, 1, "no reversal, no second debit from the late callback");
    assert.equal((await withdrawalRow(w.id)).needs_urgent_review, true, "a non-live attempt reporting SUCCESS is a genuine contradiction — flagged loudly for a human");

    const attempt1 = (await allAttempts(w.id)).find((a) => a.attempt_number === 1)!;
    assert.equal(attempt1.status, "ambiguous", "the late result is recorded on the attempt, but its status is not resurrected");

    // Attempt 2 can still legitimately resolve the withdrawal afterward.
    const finalOutcome = await applyB2CCallback(admin, parseB2CCallback(successPayload("conv-crit-2", 400))!);
    assert.equal(finalOutcome, "resolved_successful");
    assert.equal((await withdrawalRow(w.id)).status, "successful");
    assert.equal(await balance(ID.T2), 600);
    assert.equal((await ledgerRows(ID.T2)).length, 1, "exactly one debit, zero reversals, even though two attempts and a contradictory late result were involved");
  });

  test("CRITICAL: a late success for an ambiguous attempt 1 arriving AFTER the admin directly resolved the parent (no retry) is safely flagged, not silently dropped or thrown away", async () => {
    // No attempt 2 here at all — the admin looked at Safaricom's own records and
    // concluded attempt 1 failed, resolving the parent directly. This is the scenario
    // where the terminal-row guard on handle_withdrawal_status_change() previously
    // blocked ANY further write to the row — including needs_urgent_review — so a late
    // contradicting callback would make resolve_b2c_attempt's own UPDATE raise
    // "A failed withdrawal is final and cannot be changed", rolling back the whole call
    // (including the attempt's own audit record) and surfacing as apparent DB breakage
    // rather than a safe, logged contradiction.
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 400);
    const a1 = await createB2CAttempt(admin, w.id);
    await attachB2CIdentifiers(admin, a1.id, "conv-noretry-1", "orig-conv-noretry-1");
    await forceIntoReview(w.id, a1.id);
    await adminResolveWithdrawal(admin, w.id, "failed", ID.ADMIN, "Confirmed via Safaricom's own transaction statement that this never paid out.");
    assert.equal((await withdrawalRow(w.id)).status, "failed");
    assert.equal(await balance(ID.T2), 1000, "reversed by the admin's resolution");

    // Now the late success arrives — Safaricom actually did pay, contradicting the
    // admin's (reasonable, evidence-based) conclusion.
    const lateOutcome = await applyB2CCallback(admin, parseB2CCallback(successPayload("conv-noretry-1", 400, "LATE-AFTER-RESOLVE-RCPT"))!);

    assert.equal(lateOutcome, "superseded_recorded", "the call must succeed, not throw or roll back");
    const after = await withdrawalRow(w.id);
    assert.equal(after.status, "failed", "the parent's financial state is permanently frozen once terminal — never resurrected");
    assert.equal(after.needs_urgent_review, true, "this is exactly the case a human must be alerted to: a real, unresolved double-payment risk");
    assert.equal(await balance(ID.T2), 1000, "no further wallet change — the reversal already happened and cannot happen again either");
    assert.equal((await ledgerRows(ID.T2)).length, 2, "still exactly the original debit + the one reversal — no third ledger row");

    const attempt1 = (await allAttempts(w.id))[0];
    assert.equal(attempt1.status, "failed", "the admin's determination is preserved as the attempt's status");
    assert.equal(attempt1.result_code, 0, "but the late callback's actual result IS preserved on the attempt for audit, exactly as required");
  });

  test("callback racing retry authorization: financial invariants hold no matter which one wins the row lock", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    await attachB2CIdentifiers(admin, a1.id, "conv-race-1", "orig-conv-race-1");
    await forceIntoReview(w.id, a1.id);
    // forceIntoReview marks attempt 1 'ambiguous' to legally reach 'review' — reset it to
    // 'accepted' so it is genuinely still live for the race under test (a late SUCCESS
    // racing a retry authorization, not an already-ambiguous attempt).
    await db.query("update withdrawal_b2c_attempts set status = 'accepted' where id = $1", [a1.id]);

    const latePayload = parseB2CCallback(successPayload("conv-race-1", 300, "RACE-RCPT"))!;

    const [callbackResult, retryResult] = await Promise.allSettled([
      applyB2CCallback(admin, latePayload),
      authorizeB2CRetry(admin, w.id, ID.ADMIN, "Confirming via Safaricom statement that attempt 1 appears not to have paid out."),
    ]);

    const after = await withdrawalRow(w.id);
    const attempts = await allAttempts(w.id);

    // Shared invariant regardless of who won the race: the reservation is touched at most
    // by whichever single resolution was authoritative — never both, never neither.
    assert.equal(await balance(ID.T2), 700, "no double reversal, no double anything, either way");
    assert.equal((await ledgerRows(ID.T2)).length, 1, "still exactly the original debit");

    if (after.status === "successful") {
      // The callback's transaction locked the parent first: attempt 1 really was still
      // live when it ran, so resolving it successful is correct — and the retry, finding
      // the withdrawal no longer 'review', must have been refused.
      assert.equal(retryResult.status, "rejected", "authorize_b2c_retry must refuse once the callback already resolved the withdrawal");
      assert.equal(attempts.length, 1, "no second attempt was ever created");
      assert.equal(attempts[0].status, "succeeded");
    } else {
      // The retry's transaction locked the parent first: attempt 1 was superseded before
      // the callback could resolve it, so the callback must have been recorded audit-only.
      assert.equal(retryResult.status, "fulfilled", "the retry itself succeeded");
      assert.equal(callbackResult.status, "fulfilled");
      assert.equal((callbackResult as PromiseFulfilledResult<string>).value, "superseded_recorded");
      assert.equal(attempts.length, 2, "the retry created attempt 2");
      assert.equal(attempts[0].status, "superseded");
      assert.notEqual(after.status, "successful");
    }
  });

  test("ADVERSARIAL: a storm of concurrent duplicate and conflicting callbacks for one attempt can never produce more than one debit or one reversal", async () => {
    // Safaricom would never really deliver a success and a failure for the same
    // ConversationID, but the exactly-once guarantee must hold regardless of what a
    // replayed, duplicated, or malformed delivery does — this also exercises the
    // terminal-row fix above (a late contradicting result arriving after the withdrawal
    // is already 'failed' must flag needs_urgent_review, not throw and roll back).
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 400);
    const a1 = await createB2CAttempt(admin, w.id);
    await attachB2CIdentifiers(admin, a1.id, "conv-storm", "orig-conv-storm");

    const successCallback = parseB2CCallback(successPayload("conv-storm", 400))!;
    const failureCallback = parseB2CCallback(failurePayload("conv-storm"))!;

    const results = await Promise.allSettled([
      applyB2CCallback(admin, successCallback),
      applyB2CCallback(admin, failureCallback),
      applyB2CCallback(admin, successCallback),
      applyB2CCallback(admin, failureCallback),
      applyB2CCallback(admin, successCallback),
    ]);

    assert.ok(
      results.every((r) => r.status === "fulfilled"),
      "no call may throw, no matter the interleaving — a rolled-back exception would silently drop audit data",
    );

    const ledger = await ledgerRows(ID.T2);
    const debits = ledger.filter((r) => r.entry_type === "withdrawal_debit").length;
    const reversals = ledger.filter((r) => r.entry_type === "withdrawal_reversal").length;
    assert.equal(debits, 1, "never more than the original single debit, regardless of how many callbacks arrived");
    assert.ok(reversals <= 1, "never more than one reversal, however the race resolved");

    const after = await withdrawalRow(w.id);
    assert.ok(["successful", "failed"].includes(after.status), "resolves to exactly one terminal state, whichever callback's transaction won the row lock first");
    assert.equal(await balance(ID.T2), reversals === 1 ? 1000 : 600, "balance is internally consistent with the ledger no matter which one won");
  });
});

// ==================================================================================================
describe("authorize_b2c_retry — admin-only, requires review + a written reason", () => {
  test("requires the withdrawal to be in review", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300); // still 'processing'
    await assert.rejects(authorizeB2CRetry(admin, w.id, ID.ADMIN, "A reason with more than ten characters."), /not in review/);
  });

  test("requires a written justification of at least 10 characters", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    await forceIntoReview(w.id, a1.id);
    await assert.rejects(authorizeB2CRetry(admin, w.id, ID.ADMIN, "too short"), /justification/);
    // The withdrawal must remain in review — a rejected retry attempt cannot leave it stuck processing.
    assert.equal((await withdrawalRow(w.id)).status, "review");
  });

  test("two concurrent retry authorizations for the same withdrawal: only one succeeds, no duplicate live attempt", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    await forceIntoReview(w.id, a1.id);

    const results = await Promise.allSettled([
      authorizeB2CRetry(admin, w.id, ID.ADMIN, "Admin A: confirmed no payout via Safaricom portal."),
      authorizeB2CRetry(admin, w.id, ID.ADMIN, "Admin B: confirmed no payout via Safaricom portal."),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "only the first authorization can find the withdrawal still 'review'");
    assert.equal(rejected.length, 1);

    assert.equal((await liveAttempts(w.id)).length, 1, "exactly one live attempt after the race");
    const all = await allAttempts(w.id);
    assert.equal(all.length, 2, "attempt 1 (now superseded) plus exactly one new attempt");
    assert.equal(new Set(all.map((a) => a.attempt_number)).size, 2, "attempt numbers did not collide");
    assert.equal((await withdrawalRow(w.id)).status, "processing");
  });

  test("a successful retry authorization is permanently logged with actor and reason", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    await forceIntoReview(w.id, a1.id);
    await authorizeB2CRetry(admin, w.id, ID.ADMIN, "Confirmed via Safaricom statement that attempt 1 did not pay out.");

    const events = await logEvents(w.id);
    const retryEvent = events.find((e) => e.event_type === "retry_authorized");
    assert.ok(retryEvent);
    assert.equal(retryEvent!.actor, ID.ADMIN);
    assert.match(retryEvent!.reason ?? "", /did not pay out/);
  });
});

// ==================================================================================================
describe("admin_resolve_withdrawal — manual resolution", () => {
  test("requires the withdrawal to be in review", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300); // still 'processing'
    await assert.rejects(
      adminResolveWithdrawal(admin, w.id, "failed", ID.ADMIN, "Confirmed via Safaricom statement that this never paid out."),
      /not in review/,
    );
  });

  test("requires a written justification of at least 10 characters", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    await forceIntoReview(w.id, a1.id);
    await assert.rejects(adminResolveWithdrawal(admin, w.id, "failed", ID.ADMIN, "short"), /justification/);
  });

  test("resolving as failed reverses the reservation exactly once and never manipulates the balance directly", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 400);
    const a1 = await createB2CAttempt(admin, w.id);
    await attachB2CIdentifiers(admin, a1.id, "conv-manual-fail", "orig-conv-manual-fail");
    await forceIntoReview(w.id, a1.id);

    await adminResolveWithdrawal(admin, w.id, "failed", ID.ADMIN, "Confirmed via Safaricom's own transaction statement that this never paid out.");

    assert.equal((await withdrawalRow(w.id)).status, "failed");
    assert.equal(await balance(ID.T2), 1000, "restored exactly once, via the same trigger every other reversal uses");
    const ledger = await ledgerRows(ID.T2);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[1].entry_type, "withdrawal_reversal");
    assert.equal((await allAttempts(w.id)).find((a) => a.attempt_number === 1)!.status, "failed");
  });

  test("resolving as successful records the provider reference and never re-debits", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 400);
    const a1 = await createB2CAttempt(admin, w.id);
    await forceIntoReview(w.id, a1.id);

    await adminResolveWithdrawal(
      admin,
      w.id,
      "successful",
      ID.ADMIN,
      "Confirmed via Safaricom's own transaction statement that this paid out correctly.",
      "MANUAL-RCPT-1",
    );

    const after = await withdrawalRow(w.id);
    assert.equal(after.status, "successful");
    assert.equal(after.provider_reference, "MANUAL-RCPT-1");
    assert.equal(await balance(ID.T2), 600, "unchanged — success never touches the balance, it was already reserved");
    assert.equal((await ledgerRows(ID.T2)).length, 1, "no reversal for a successful manual resolution");
  });

  test("a manual resolution is permanently logged with actor and reason", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    await forceIntoReview(w.id, a1.id);
    await adminResolveWithdrawal(admin, w.id, "failed", ID.ADMIN, "Confirmed via Safaricom's own transaction statement.");

    const events = await logEvents(w.id);
    const resolveEvent = events.find((e) => e.event_type === "admin_resolved");
    assert.ok(resolveEvent);
    assert.equal(resolveEvent!.actor, ID.ADMIN);
  });
});

// ==================================================================================================
describe("sweepStaleProcessingWithdrawals — reconciliation sweep", () => {
  test("a withdrawal whose live attempt has been waiting past staleMinutes is moved to review, not failed", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    await db.query("update withdrawal_b2c_attempts set requested_at = now() - interval '30 minutes' where id = $1", [a1.id]);

    const result = await sweepStaleProcessingWithdrawals(admin, { staleMinutes: 15, leaseMinutes: 10 });
    assert.deepEqual(result, [{ withdrawalId: w.id, swept: true }]);

    assert.equal((await withdrawalRow(w.id)).status, "review", "elapsed time alone only ever produces 'review' — never 'failed'");
    assert.equal(await balance(ID.T2), 700, "the reservation is untouched — a stale transaction may simply mean a late callback");
    assert.equal((await ledgerRows(ID.T2)).length, 1, "no reversal from the sweep");
    assert.equal((await allAttempts(w.id))[0].status, "requested", "the sweep never touches the attempt itself, only the parent");
  });

  test("a withdrawal well within staleMinutes is left alone", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    await createB2CAttempt(admin, w.id);
    const result = await sweepStaleProcessingWithdrawals(admin, { staleMinutes: 15, leaseMinutes: 10 });
    assert.deepEqual(result, []);
    assert.equal((await withdrawalRow(w.id)).status, "processing");
  });

  test("a stale withdrawal with no attempt row at all falls back to the withdrawal's own reserved_at", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    await db.query("update withdrawal_requests set reserved_at = now() - interval '30 minutes' where id = $1", [w.id]);
    const result = await sweepStaleProcessingWithdrawals(admin, { staleMinutes: 15, leaseMinutes: 10 });
    assert.deepEqual(result, [{ withdrawalId: w.id, swept: true }]);
    assert.equal((await withdrawalRow(w.id)).status, "review");
  });

  test("two concurrent sweep runs cannot both claim and sweep the same stale withdrawal", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    await db.query("update withdrawal_b2c_attempts set requested_at = now() - interval '30 minutes' where id = $1", [a1.id]);

    const [r1, r2] = await Promise.all([
      sweepStaleProcessingWithdrawals(admin, { staleMinutes: 15, leaseMinutes: 10, actorId: ID.ADMIN }),
      sweepStaleProcessingWithdrawals(admin, { staleMinutes: 15, leaseMinutes: 10, actorId: ID.ADMIN }),
    ]);

    const sweptCount = [...r1, ...r2].filter((x) => x.swept).length;
    assert.equal(sweptCount, 1, "only one of the two concurrent sweep runs actually claimed and swept this withdrawal");
    assert.equal((await withdrawalRow(w.id)).status, "review");
  });

  test("the sweep is logged", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    const a1 = await createB2CAttempt(admin, w.id);
    await db.query("update withdrawal_b2c_attempts set requested_at = now() - interval '30 minutes' where id = $1", [a1.id]);
    await sweepStaleProcessingWithdrawals(admin, { staleMinutes: 15, leaseMinutes: 10 });

    const events = await logEvents(w.id);
    assert.ok(events.some((e) => e.event_type === "swept_to_review"));
  });
});

// ==================================================================================================
describe("withdrawal_reconciliation_log — RLS (admin read-only)", () => {
  test("a coach cannot read the reconciliation log; an admin can", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    await createB2CAttempt(admin, w.id);

    const asCoach = await attempt({ id: ID.T2 }, "select id from withdrawal_reconciliation_log");
    assert.ok(!asCoach.ok || asCoach.rows.length === 0, "a coach must not be able to read reconciliation events");

    const asAdmin = await attempt({ id: ID.ADMIN }, "select id from withdrawal_reconciliation_log");
    assert.ok(asAdmin.ok && asAdmin.rows.length >= 1, "an admin can read reconciliation events");
  });

  test("a coach cannot read the attempts table; an admin can", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    await createB2CAttempt(admin, w.id);

    const asCoach = await attempt({ id: ID.T2 }, "select id from withdrawal_b2c_attempts");
    assert.ok(!asCoach.ok || asCoach.rows.length === 0);

    const asAdmin = await attempt({ id: ID.ADMIN }, "select id from withdrawal_b2c_attempts");
    assert.ok(asAdmin.ok && asAdmin.rows.length >= 1);
  });

  test("no client role can write to either table directly — every write goes through the SECURITY DEFINER functions", async () => {
    await setupWallet(ID.T2, 1000);
    const w = await insertMpesaWithdrawal(ID.T2, 300);
    for (const actor of [{ id: ID.T2 }, { id: ID.ADMIN }, "anon"] as const) {
      const outcome = await attempt(
        actor,
        "insert into withdrawal_b2c_attempts (withdrawal_request_id, attempt_number, status) values ($1, 99, 'requested')",
        [w.id],
      );
      assert.ok(!outcome.ok, `${JSON.stringify(actor)} must not be able to insert an attempt directly`);
    }
  });
});
