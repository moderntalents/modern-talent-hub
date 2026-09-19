import "server-only";
import nodemailer from "nodemailer";

// Shared SMTP sender for every email this app sends itself (registration
// codes, password-reset links). Environment variables:
//   SMTP_USER / SMTP_PASS   the sending mailbox (Gmail: an *app password*)
// Optional: SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 465), SMTP_FROM.

export function isMailerConfigured(): boolean {
  return missingMailerConfig().length === 0;
}

/** Names (never values) of the required SMTP variables this server can't see — for logs. */
export function missingMailerConfig(): string[] {
  return ["SMTP_USER", "SMTP_PASS"].filter((name) => !process.env[name]);
}

export async function sendMail(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
  const port = Number(process.env.SMTP_PORT ?? 465);
  const user = process.env.SMTP_USER!;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user, pass: process.env.SMTP_PASS! },
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? `Modern Talent Hub <${user}>`,
    ...message,
  });
}
