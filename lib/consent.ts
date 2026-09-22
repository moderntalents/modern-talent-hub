import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { isMailerConfigured, sendMail } from "@/lib/mailer";
import { getSiteUrl } from "@/lib/site";
import { CONTACT_EMAIL } from "@/lib/legal";
import { ageInYears, guardianEmailProblem, needsGuardian } from "@/lib/age";
import { CURRENT_CONSENT_VERSION, type ConsentPurpose } from "@/lib/consent-versions";

// Guardian consent for under-18s: creating the request, emailing the guardian, and the
// bookkeeping around it. Everything here runs on the server with the service role.
//
// There are two kinds of request (0014): "platform" (may they use the app at all — with an optional
// messaging choice on the same page) and "messaging" (a student already approved for the platform asks
// for private messaging separately). Every new request is sent with the current wording version.

type Admin = ReturnType<typeof createAdminClient>;

export const CONSENT_LINK_DAYS = 7;

// The email link carries a random 256-bit secret. Only its SHA-256 hash is stored, so a
// database leak cannot be turned into approvals.
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** "parent@example.com" -> "p•••@example.com", so the child's screen doesn't expose the whole address. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return "•••";
  return `${name.slice(0, 1)}•••@${domain}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type IssueResult = { ok: true } | { ok: false; message: string };

type EmailContent = { subject: string; text: string; html: string };

/**
 * Closes any earlier unanswered request of the same purpose, creates a new one with the current
 * wording version, and emails the guardian the link. Only the newest email of each kind works.
 */
async function issueRequest(
  admin: Admin,
  p: { profileId: string; guardianEmail: string; purpose: ConsentPurpose; path: string },
  content: (link: string) => EmailContent,
): Promise<IssueResult> {
  if (!isMailerConfigured()) {
    console.error("[consent] email isn't configured (SMTP_USER / SMTP_PASS missing)");
    return { ok: false, message: "We couldn't send the email to your parent or guardian right now. Please try again later." };
  }

  const guardianEmail = p.guardianEmail.trim().toLowerCase();
  const token = newToken();
  const tokenHash = hashToken(token);

  const closed = await admin
    .from("guardian_consent_requests")
    .update({ expires_at: new Date().toISOString() })
    .eq("profile_id", p.profileId)
    .eq("purpose", p.purpose)
    .is("decided_at", null);
  if (closed.error) {
    console.error("[consent] could not close earlier requests:", closed.error.message);
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  const created = await admin.from("guardian_consent_requests").insert({
    profile_id: p.profileId,
    guardian_email: guardianEmail,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + CONSENT_LINK_DAYS * 24 * 3600 * 1000).toISOString(),
    purpose: p.purpose,
    consent_version: CURRENT_CONSENT_VERSION,
  });
  if (created.error) {
    console.error("[consent] could not save request:", created.error.message);
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  const link = `${getSiteUrl()}${p.path}?token=${token}`;
  try {
    await sendMail({ to: guardianEmail, ...content(link) });
  } catch (err) {
    console.error("[consent] sending the guardian email failed:", err instanceof Error ? err.message : err);
    // Nothing reached the guardian, so this request must not count as "email sent": close it.
    await admin.from("guardian_consent_requests").update({ expires_at: new Date().toISOString() }).eq("token_hash", tokenHash);
    return { ok: false, message: "We couldn't send the email to your parent or guardian. Check the address and try again." };
  }

  return { ok: true };
}

const button = (link: string, label: string) =>
  `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#00a6ed;color:#0b1b2b;` +
  `border-radius:10px;font-weight:700;text-decoration:none">${label}</a></p>` +
  `<p style="font-size:13px;color:#555">Or copy this address into your browser:<br>${link}</p>`;

/**
 * Creates a fresh platform consent request for a child and emails the guardian the link.
 * Any earlier unanswered platform request for the same child is closed first.
 */
export async function issueConsentRequest(
  admin: Admin,
  params: { profileId: string; childName: string; guardianEmail: string },
): Promise<IssueResult> {
  const name = params.childName.trim() || "A young person";
  return issueRequest(
    admin,
    { profileId: params.profileId, guardianEmail: params.guardianEmail, purpose: "platform", path: "/guardian/consent" },
    (link) => ({
      subject: `${name} would like to join Modern Talent Hub — your permission is needed`,
      text:
        `Hello,\n\n` +
        `${name} has asked to create an account on Modern Talent Hub, a learning platform for students, ` +
        `teachers and coaches in Kenya. Because they are under 18, we need a parent or guardian's permission ` +
        `before they can use it.\n\n` +
        `On the same page you can also choose whether to allow private messages between them and their teachers. ` +
        `This is optional and stays off unless you allow it.\n\n` +
        `Please read the details and choose Approve or Decline here:\n${link}\n\n` +
        `The link works for ${CONSENT_LINK_DAYS} days. If you don't know this person or weren't expecting this ` +
        `email, you can ignore it — the account cannot be used without your approval.\n\n` +
        `Questions? Write to ${CONTACT_EMAIL}.\n\nModern Talent Hub`,
      html:
        `<p>Hello,</p>` +
        `<p><strong>${escapeHtml(name)}</strong> has asked to create an account on Modern Talent Hub, a learning ` +
        `platform for students, teachers and coaches in Kenya. Because they are under 18, we need a parent or ` +
        `guardian's permission before they can use it.</p>` +
        `<p>On the same page you can also choose whether to allow private messages between them and their teachers. ` +
        `This is optional and stays off unless you allow it.</p>` +
        button(link, "Read the details and decide") +
        `<p>The link works for ${CONSENT_LINK_DAYS} days. If you don't know this person or weren't expecting this ` +
        `email, you can ignore it — the account cannot be used without your approval.</p>` +
        `<p>Questions? Write to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>` +
        `<p>Modern Talent Hub</p>`,
    }),
  );
}

/**
 * Asks the guardian ON RECORD (never an address the student types) to allow private messaging, for a
 * student whose platform use is already approved. Any earlier unanswered messaging request is closed.
 */
export async function issueMessagingConsentRequest(
  admin: Admin,
  params: { profileId: string; childName: string; guardianEmail: string },
): Promise<IssueResult> {
  const name = params.childName.trim() || "The young person";
  return issueRequest(
    admin,
    { profileId: params.profileId, guardianEmail: params.guardianEmail, purpose: "messaging", path: "/guardian/messaging" },
    (link) => ({
      subject: `${name} is asking to use messaging on Modern Talent Hub`,
      text:
        `Hello,\n\n` +
        `You previously allowed ${name} to use Modern Talent Hub. They are now asking for your permission to send ` +
        `and receive private messages (including PDF homework) with their teachers. Messaging stays off unless you allow it, ` +
        `and saying no does not affect the rest of their account.\n\n` +
        `Please read the details and choose Allow or Don't allow here:\n${link}\n\n` +
        `The link works for ${CONSENT_LINK_DAYS} days. If you weren't expecting this email, you can ignore it — ` +
        `messaging stays off.\n\n` +
        `Questions? Write to ${CONTACT_EMAIL}.\n\nModern Talent Hub`,
      html:
        `<p>Hello,</p>` +
        `<p>You previously allowed <strong>${escapeHtml(name)}</strong> to use Modern Talent Hub. They are now asking ` +
        `for your permission to send and receive private messages (including PDF homework) with their teachers. ` +
        `Messaging stays off unless you allow it, and saying no does not affect the rest of their account.</p>` +
        button(link, "Read the details and decide") +
        `<p>The link works for ${CONSENT_LINK_DAYS} days. If you weren't expecting this email, you can ignore it — ` +
        `messaging stays off.</p>` +
        `<p>Questions? Write to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>` +
        `<p>Modern Talent Hub</p>`,
    }),
  );
}

/**
 * True if there is an email out to the guardian that can still be used: sent, not answered, not
 * expired. The waiting screen uses it to say "we've emailed …" only when that is actually true.
 */
export async function hasActiveConsentRequest(
  admin: Admin,
  profileId: string,
  purpose: ConsentPurpose = "platform",
): Promise<boolean> {
  const { count } = await admin
    .from("guardian_consent_requests")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("purpose", purpose)
    .is("decided_at", null)
    .gt("expires_at", new Date().toISOString());
  return (count ?? 0) > 0;
}

export type RecordAgeResult =
  | { ok: true; consent: "not_required" | "pending"; emailSent: boolean }
  | { ok: false; message: string };

/**
 * Records someone's date of birth ONCE and, for under-18s, sends the guardian email.
 * This is the single place that decides "adult or needs a guardian" — the server works it
 * out from the date; nothing the browser says about age is trusted.
 *
 * It is insert-only: if a record already exists it refuses, so nobody can come back and
 * "correct" their age to skip consent. (Mistakes go through support.)
 */
export async function recordAge(
  admin: Admin,
  p: {
    profileId: string;
    role: "student" | "teacher" | "admin";
    dobIso: string;
    accountEmail: string | null;
    guardianEmail: string | null;
    childName: string;
  },
): Promise<RecordAgeResult> {
  const age = ageInYears(p.dobIso);
  const minor = needsGuardian(age);

  if (p.role === "teacher" && minor) {
    return { ok: false, message: "Teacher accounts are for people aged 18 or over." };
  }

  let guardianEmail: string | null = null;
  if (minor) {
    const problem = guardianEmailProblem(p.guardianEmail ?? "", p.accountEmail);
    if (problem) return { ok: false, message: problem };
    guardianEmail = (p.guardianEmail ?? "").trim().toLowerCase();
  }

  const { error } = await admin.from("age_records").insert({
    profile_id: p.profileId,
    date_of_birth: p.dobIso,
    guardian_email: guardianEmail,
    consent_status: minor ? "pending" : "not_required",
  });
  if (error) {
    if (error.code === "23505") return { ok: false, message: "Your date of birth has already been recorded." };
    console.error("[consent] could not save age record:", error.message);
    return { ok: false, message: "Something went wrong. Please try again." };
  }

  if (!minor) return { ok: true, consent: "not_required", emailSent: false };

  const issued = await issueConsentRequest(admin, {
    profileId: p.profileId,
    childName: p.childName,
    guardianEmail: guardianEmail!,
  });
  // If the email failed the account is still locked and the waiting screen offers "Resend".
  return { ok: true, consent: "pending", emailSent: issued.ok };
}

/**
 * Deletes a STUDENT account that has never been used (no enrolments, submissions, live
 * classes or payments). Used when a guardian declines PLATFORM consent, and for an under-13 who
 * signed in with Google. Never used for a messaging decline or withdrawal: those only switch
 * messaging off. Returns false — and deletes nothing — if the account has any activity, in
 * which case the caller keeps it locked instead.
 */
export async function purgeUnusedStudent(admin: Admin, userId: string): Promise<boolean> {
  const { data: profile } = await admin.from("profiles").select("role").eq("id", userId).maybeSingle();
  if (profile?.role !== "student") return false;

  const counts = await Promise.all([
    admin.from("subscriptions").select("id", { count: "exact", head: true }).eq("student_id", userId),
    admin.from("assignment_submissions").select("id", { count: "exact", head: true }).eq("student_id", userId),
    admin.from("live_session_participants").select("id", { count: "exact", head: true }).eq("profile_id", userId),
    admin.from("payment_transactions").select("id", { count: "exact", head: true }).eq("student_id", userId),
  ]);
  if (counts.some((c) => c.error || (c.count ?? 0) > 0)) return false;

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error("[consent] could not delete unused account:", error.message);
    return false;
  }
  return true;
}
