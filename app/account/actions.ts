"use server";

import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CONTACT_EMAIL } from "@/lib/legal";

// "Delete my account" — the in-app deletion path Google Play requires.
//
// Who is asked to delete is taken from the login session, never from the request,
// so nobody can delete anyone else. Failures are returned as { ok: false, message }
// (production hides thrown server-action errors behind a generic screen).
//
// Two ways an account goes:
//   * HARD DELETE (normal): the login and everything tied to it is removed. A teacher's
//     PUBLISHED lessons stay but become ownerless (lessons.teacher_id is set to NULL by
//     the database when the profile goes), so the teacher's name/details disappear.
//   * SCRUB (only if the person has payment/payout records): those records reference the
//     user and the law expects them to be kept, so the row stays but every personal
//     detail is blanked (including the M-Pesa number / bank account on payout requests and
//     the phone number on activation payments), the login identities (e.g. Google) are
//     removed, the login is disabled and the email replaced. What stays is an anonymous
//     ledger: amounts, dates, statuses and payment reference numbers. (Payments may be
//     switched off, in which case nobody has records — this is ready for when they do.)

export type DeleteAccountResult = { ok: true } | { ok: false; message: string };

type Admin = ReturnType<typeof createAdminClient>;

const fail = (message: string): DeleteAccountResult => ({ ok: false, message });

// Throws if a database step failed, so we never report success on a half-done deletion.
function must(result: { error: { message: string } | null }, step: string) {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
}

async function removeStoredFiles(admin: Admin, bucket: string, paths: string[]) {
  const clean = paths.filter(Boolean);
  for (let i = 0; i < clean.length; i += 100) {
    const { error } = await admin.storage.from(bucket).remove(clean.slice(i, i + 100));
    // Files are best-effort: a leftover file is not worth abandoning the deletion.
    if (error) console.error(`[delete-account] some files in "${bucket}" could not be removed:`, error.message);
  }
}

async function hasFinancialRecords(admin: Admin, userId: string): Promise<boolean> {
  const [transactions, activations, withdrawals] = await Promise.all([
    admin
      .from("payment_transactions")
      .select("id", { count: "exact", head: true })
      .or(`student_id.eq.${userId},teacher_id.eq.${userId}`),
    admin.from("coach_activation_payments").select("id", { count: "exact", head: true }).eq("teacher_id", userId),
    admin.from("withdrawal_requests").select("id", { count: "exact", head: true }).eq("teacher_id", userId),
  ]);
  must(transactions, "check payments");
  must(activations, "check activation payments");
  must(withdrawals, "check withdrawals");
  return (transactions.count ?? 0) + (activations.count ?? 0) + (withdrawals.count ?? 0) > 0;
}

// A student's uploaded assignment files.
async function removeStudentFiles(admin: Admin, userId: string) {
  const { data } = await admin.from("assignment_submissions").select("storage_path").eq("student_id", userId);
  await removeStoredFiles(admin, "assignment-submissions", (data ?? []).map((s) => s.storage_path));
}

// A teacher's activities' files, and their DRAFT lessons (with those lessons' files and
// student submissions). Published lessons are left alone — they are kept, ownerless.
async function cleanUpTeacherContent(admin: Admin, userId: string) {
  const { data: activities } = await admin.from("activities").select("id").eq("teacher_id", userId);
  const activityIds = (activities ?? []).map((a) => a.id);
  if (activityIds.length > 0) {
    const { data: materials } = await admin.from("activity_materials").select("storage_path").in("activity_id", activityIds);
    await removeStoredFiles(admin, "activity-materials", (materials ?? []).map((m) => m.storage_path));
    must(await admin.from("activity_materials").delete().in("activity_id", activityIds), "delete activity materials");
  }

  const { data: drafts } = await admin.from("lessons").select("id").eq("teacher_id", userId).eq("status", "draft");
  const draftIds = (drafts ?? []).map((l) => l.id);
  if (draftIds.length > 0) {
    const { data: materials } = await admin.from("lesson_materials").select("storage_path").in("lesson_id", draftIds);
    await removeStoredFiles(admin, "lesson-materials", (materials ?? []).map((m) => m.storage_path));

    const { data: assignments } = await admin.from("assignments").select("id").in("lesson_id", draftIds);
    const assignmentIds = (assignments ?? []).map((a) => a.id);
    if (assignmentIds.length > 0) {
      const { data: submissions } = await admin
        .from("assignment_submissions")
        .select("storage_path")
        .in("assignment_id", assignmentIds);
      await removeStoredFiles(admin, "assignment-submissions", (submissions ?? []).map((s) => s.storage_path));
    }

    // Cascades to the lessons' materials, assignments and submissions rows.
    must(await admin.from("lessons").delete().in("id", draftIds), "delete draft lessons");
  }
}

// Payment/payout tables have NOT NULL phone/destination columns, so personal values are
// replaced by this marker instead of NULL.
const REMOVED = "removed";

// Removes Google (or any other) sign-in identities and open sessions, using the
// delete_user_identities function from migration 0009. Throws if it is missing, so the
// deletion stops before anything else is changed and can simply be retried.
async function removeLoginIdentities(admin: Admin, userId: string) {
  const { error } = await admin.rpc("delete_user_identities", { p_user_id: userId });
  if (error) throw new Error(`remove login identities: ${error.message}`);
}

// For people with payment/payout records: keep the row, remove the person.
async function scrubAccount(admin: Admin, userId: string) {
  must(await admin.from("live_session_participants").delete().eq("profile_id", userId), "clear live-class records");
  must(await admin.from("live_sessions").delete().eq("teacher_id", userId), "clear live classes");
  must(await admin.from("assignment_submissions").delete().eq("student_id", userId), "clear submissions");
  must(await admin.from("subscriptions").update({ status: "cancelled" }).eq("student_id", userId), "cancel enrolments");
  must(await admin.from("subscriptions").update({ status: "cancelled" }).eq("teacher_id", userId), "cancel enrolments");
  // The teacher's activities stay only as hidden drafts so the payment history still points somewhere.
  must(await admin.from("activities").update({ status: "draft" }).eq("teacher_id", userId), "hide activities");
  // Published lessons are kept, no longer linked to this person.
  must(await admin.from("lessons").update({ teacher_id: null }).eq("teacher_id", userId), "detach lessons");
  must(await admin.from("student_profiles").delete().eq("profile_id", userId), "remove student details");
  // The financial ledger stays, but the personal numbers in it do not.
  must(
    await admin.from("withdrawal_requests").update({ destination: REMOVED, notes: null }).eq("teacher_id", userId),
    "remove payout details",
  );
  must(
    await admin.from("coach_activation_payments").update({ phone: REMOVED }).eq("teacher_id", userId),
    "remove activation phone numbers",
  );
  must(
    await admin
      .from("teacher_profiles")
      .update({ bio: null, specialty: null, mpesa_number: null, bank_name: null, bank_account: null, approved: false })
      .eq("profile_id", userId),
    "remove teacher details",
  );
  must(
    await admin.from("profiles").update({ full_name: "Deleted user", phone: null, avatar_url: null }).eq("id", userId),
    "remove profile details",
  );

  // Replace the email, set an unusable password, and disable the login for good.
  const { error } = await admin.auth.admin.updateUserById(userId, {
    email: `deleted-${userId}@deleted.invalid`,
    password: `${randomUUID()}${randomUUID()}`,
    user_metadata: {},
    ban_duration: "876000h",
  });
  if (error) throw new Error(`disable login: ${error.message}`);
}

export async function deleteMyAccount(confirmation: string): Promise<DeleteAccountResult> {
  try {
    if (confirmation.trim() !== "DELETE") return fail("Type DELETE, in capital letters, to confirm.");

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return fail("Please sign in again first.");

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (!profile) return fail("Your profile couldn't be found.");
    if (profile.role === "admin") {
      return fail(`Administrator accounts can't be deleted here. Please contact ${CONTACT_EMAIL}.`);
    }

    const admin = createAdminClient();

    // A teacher can't walk away from money owed to them.
    if (profile.role === "teacher") {
      const { data: teacher } = await admin
        .from("teacher_profiles")
        .select("wallet_balance")
        .eq("profile_id", user.id)
        .maybeSingle();
      if (Number(teacher?.wallet_balance ?? 0) > 0) {
        return fail("Your wallet still has money in it. Please withdraw it first, then delete your account.");
      }
      const { count } = await admin
        .from("withdrawal_requests")
        .select("id", { count: "exact", head: true })
        .eq("teacher_id", user.id)
        .in("status", ["pending", "processing"]);
      if ((count ?? 0) > 0) {
        return fail("You have a withdrawal that is still being processed. Please wait for it to finish, then delete your account.");
      }
    }

    const keepRecords = await hasFinancialRecords(admin, user.id);

    // First step on the scrub path: if this fails nothing else has been touched yet.
    // (A hard delete removes the identities together with the login, so it needs no call.)
    if (keepRecords) await removeLoginIdentities(admin, user.id);

    if (profile.role === "student") await removeStudentFiles(admin, user.id);
    if (profile.role === "teacher") await cleanUpTeacherContent(admin, user.id);

    if (keepRecords) {
      await scrubAccount(admin, user.id);
    } else {
      // Removes the login; the database then removes everything tied to it, and sets
      // the owner of any published lesson to nobody.
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) throw new Error(`delete login: ${error.message}`);
    }

    return { ok: true };
  } catch (err) {
    console.error("[delete-account] failed:", err);
    return fail(
      `We couldn't finish deleting your account. Some of your data may already be removed — please try again, or email ${CONTACT_EMAIL} and we will complete it.`,
    );
  }
}
