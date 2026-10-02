// What Settings' "Age & Guardian" section shows: the person's OWN stored age/guardian details, and
// links into the existing flows that can change them. Pure, with no framework imports, so it can be
// unit tested. It never grants or changes anything — the age gate (lib/age-gate.ts), the consent flow
// (lib/consent.ts) and the database stay the only things that decide access.
//
// The date of birth is deliberately NOT self-editable: lib/consent.ts recordAge() is insert-only "so
// nobody can come back and 'correct' their age to skip consent" — corrections go through support.
// This summary makes the stored details visible and gives that correction route, instead of hiding
// everything behind "nothing outstanding".

import { ageInYears } from "@/lib/age";
import type { AgeState } from "@/lib/account-setup";

export interface StoredAgeRecord {
  date_of_birth: string;
  guardian_email: string | null;
  consent_status: "not_required" | "pending" | "granted" | "declined";
}

export interface AgeSummaryRow {
  label: string;
  value: string;
}

export interface AgeSummaryLink {
  href: string;
  label: string;
}

export interface AgeSummary {
  rows: AgeSummaryRow[];
  /** One sentence about where things stand. */
  status: string;
  /** Existing flows the person can use from here, most relevant first. */
  links: AgeSummaryLink[];
  /** Shown when the stored details can only be corrected by support. */
  correctionNote: string | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2010-03-12" -> "12 March 2010" (no time zone involved, so the day never shifts). */
export function formatBirthDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "parent@example.com" -> "p•••@example.com" — same masking lib/consent.ts uses on the child's screens. */
function mask(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return "•••";
  return `${name.slice(0, 1)}•••@${domain}`;
}

const CONSENT_LABEL: Record<StoredAgeRecord["consent_status"], string> = {
  not_required: "Not needed (18 or over when you joined)",
  pending: "Waiting for your parent or guardian",
  granted: "Approved by your parent or guardian",
  declined: "Not approved",
};

export function ageSummary(
  /** Account setup, from lib/account-setup.ts: the same source of truth the gates and Messages use. */
  setup: AgeState,
  record: StoredAgeRecord | null,
  supportEmail: string,
  now: Date = new Date(),
): AgeSummary {
  const correction: AgeSummaryLink = {
    href: `mailto:${supportEmail}?subject=${encodeURIComponent("Correction to my date of birth or guardian details")}`,
    label: "Ask us to correct these details",
  };

  if (setup.kind === "needs_age" || !record) {
    return {
      rows: [],
      status: "You haven't finished your age check yet.",
      links: [{ href: "/age-check", label: "Finish the age check" }],
      correctionNote: null,
    };
  }

  const age = ageInYears(record.date_of_birth, now);
  const rows: AgeSummaryRow[] = [
    { label: "Date of birth", value: formatBirthDate(record.date_of_birth) },
    { label: "Age", value: `${age}` },
  ];
  if (record.guardian_email) rows.push({ label: "Parent or guardian", value: mask(record.guardian_email) });
  rows.push({ label: "Guardian approval", value: CONSENT_LABEL[record.consent_status] });

  const links: AgeSummaryLink[] = [];
  let status: string;
  if (setup.kind === "pending") {
    status = "Waiting for your parent or guardian to approve your account.";
    links.push({ href: "/consent-pending", label: "Resend the email or change your parent or guardian's email" });
  } else if (setup.kind === "declined") {
    status = "Your parent or guardian didn't approve your account.";
    links.push({ href: "/consent-pending", label: "See what you can do next" });
  } else {
    status = "Your account is set up.";
  }
  links.push(correction);

  return {
    rows,
    status,
    links,
    correctionNote:
      "For safety, your date of birth and a parent or guardian's approval can't be changed from here. If something is wrong, email us and we'll correct it.",
  };
}
