import type { Metadata } from "next";
import Link from "next/link";
import { H2, LegalPage, P, UL } from "@/components/legal/LegalPage";
import { CONTACT_EMAIL, DELETION_REQUEST_DAYS } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Delete your account — Modern Talent Hub",
  description: "How to delete your Modern Talent Hub account and data, and what is removed or kept.",
};

// The public "web link where users can request account deletion" that Google Play
// requires. Works without signing in.
export default function DeleteAccountPage() {
  return (
    <LegalPage title="Delete your account">
      <P>
        You can delete your Modern Talent Hub account and the information linked to it. This page explains how, and what
        happens.
      </P>

      <H2>Option 1 — Delete it yourself (instant)</H2>
      <UL>
        <li>
          <Link href="/login?next=%2Faccount" className="font-semibold text-brand-cyan-deep">
            Sign in
          </Link>{" "}
          to the website or the Android app.
        </li>
        <li>
          Open <strong>Account &amp; privacy</strong> (in the menu, next to “Sign out”).
        </li>
        <li>
          Choose <strong>Delete my account</strong>, type <strong>DELETE</strong> to confirm, and tap the delete button.
        </li>
      </UL>
      <P>Your account is deleted immediately. This cannot be undone.</P>

      <H2>Option 2 — Ask us to do it</H2>
      <P>
        If you cannot sign in, or you are a parent or guardian asking on behalf of your child, email{" "}
        <a href={`mailto:${CONTACT_EMAIL}?subject=Delete%20my%20account`} className="font-semibold text-brand-cyan-deep">
          {CONTACT_EMAIL}
        </a>{" "}
        with the subject “Delete my account”. Send it from the email address on the account, and include the account holder’s
        full name (for a child, tell us you are the parent or guardian). We may reply to confirm it is really you. We complete
        requests within {DELETION_REQUEST_DAYS} days.
      </P>

      <H2>What is deleted</H2>
      <UL>
        <li>Your login, name, email address and phone number.</li>
        <li>Your date of birth and, if you are under 18, your parent or guardian’s email address and their answer.</li>
        <li>
          Your grade, school, bio and what you teach, and the payout details you saved (M-Pesa number or bank account). Your
          Google sign-in details are removed too.
        </li>
        <li>Files you uploaded (such as assignment submissions), your activity enrolments, and your live-class records.</li>
        <li>
          <strong>Teachers and coaches:</strong> your activities and their files, and any draft lessons, are deleted. Lessons you had{" "}
          <strong>published</strong> are kept so students can keep using them, but they are no longer linked to you — your name and
          details are removed.
        </li>
      </UL>

      <H2>What we may keep</H2>
      <UL>
        <li>
          Payment and payout records, where the law requires us to keep them for tax and accounting. If you have any, we
          remove your name, email address, phone number and payout details (M-Pesa number or bank account) from them. What
          remains is an anonymous record: amounts, dates, statuses and payment reference numbers.
        </li>
        <li>
          Published lessons, as described above, without your name or details.
        </li>
        <li>
          Nothing else is kept about you in our system once your account is deleted. Our service providers may keep routine
          backups or technical logs for a limited time under their own policies, so a deleted item can remain in a backup
          copy for a while before it is overwritten.
        </li>
      </UL>

      <H2>Before you delete</H2>
      <UL>
        <li>A teacher with money left in their wallet, or a withdrawal still being processed, must finish withdrawing first.</li>
        <li>Administrator accounts cannot be deleted from the app; contact us instead.</li>
      </UL>

      <P>
        See our{" "}
        <Link href="/privacy" className="font-semibold text-brand-cyan-deep">
          Privacy Policy
        </Link>{" "}
        for how we handle information.
      </P>
    </LegalPage>
  );
}
