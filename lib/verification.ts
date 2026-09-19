import "server-only";
import { createHmac, randomInt } from "node:crypto";
import { isMailerConfigured, sendMail } from "@/lib/mailer";

// Registration verification codes (see supabase/migrations/0005_registration_codes.sql
// for the storage and limits). Sending uses the shared SMTP mailer (lib/mailer.ts).
// Required environment variables:
//   SMTP_USER / SMTP_PASS        mailbox that sends the code (Gmail: an *app password*)
//   VERIFICATION_CODE_SECRET     32+ random characters — keys the code hash
// This is deliberately separate from password reset (/api/auth/forgot-password).

export const CODE_LENGTH = 5;
export const CODE_TTL_SECONDS = 10 * 60;

export function isVerificationConfigured(): boolean {
  return Boolean(
    isMailerConfigured() &&
      process.env.VERIFICATION_CODE_SECRET &&
      process.env.VERIFICATION_CODE_SECRET.length >= 32,
  );
}

/** Uniformly random 5-digit number (10000–99999) from the OS CSPRNG — never Math.random. */
export function generateCode(): string {
  return String(randomInt(10_000, 100_000));
}

/**
 * Keyed hash of the code. Only this hash is stored: with just 90,000 possible
 * codes a plain hash could be reversed instantly if the table ever leaked, so
 * it is an HMAC with a server-side secret, bound to the email address.
 */
export function hashCode(email: string, code: string): string {
  return createHmac("sha256", process.env.VERIFICATION_CODE_SECRET!)
    .update(`${email.toLowerCase()}:${code}`)
    .digest("hex");
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^\S+@\S+\.\S+$/.test(email) ? email : null;
}

/** Client IP as set by the hosting proxy (Vercel overwrites x-forwarded-for). */
export function getClientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Emails the code. Deliberately contains no link of any kind. */
export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  const minutes = CODE_TTL_SECONDS / 60;

  await sendMail({
    to,
    subject: "Your Registration Verification Code",
    text:
      `Your Registration Verification Code is: ${code}\n\n` +
      `This code expires in ${minutes} minutes. If you didn't try to register for ` +
      `Modern Talent Hub, you can ignore this email.`,
    html:
      `<div style="font-family:Arial,sans-serif;font-size:16px;color:#111">` +
      `<p>Your Registration Verification Code is:</p>` +
      `<p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:8px 0">${code}</p>` +
      `<p style="color:#555;font-size:14px">This code expires in ${minutes} minutes. ` +
      `If you didn't try to register for Modern Talent Hub, you can ignore this email.</p>` +
      `</div>`,
  });
}
