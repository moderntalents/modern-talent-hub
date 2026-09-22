import type { Metadata } from "next";
import { LegalPage, P } from "@/components/legal/LegalPage";
import { CONTACT_EMAIL } from "@/lib/legal";

export const metadata: Metadata = { title: "Thank you — Modern Talent Hub", robots: { index: false, follow: false } };

const MESSAGES: Record<string, { title: string; body: string }> = {
  approved: {
    title: "Thank you — approved",
    body: "The young person can now use Modern Talent Hub. They just need to press “check again” on their waiting screen, or sign in again. Private messaging stays off; they can ask you for it separately later.",
  },
  "approved-messaging": {
    title: "Thank you — approved",
    body: "The young person can now use Modern Talent Hub, including private messages with their teachers. They just need to press “check again” on their waiting screen, or sign in again.",
  },
  "messaging-approved": {
    title: "Thank you — messaging allowed",
    body: `Private messages with their teachers are now switched on. You can switch messaging off again at any time by emailing ${CONTACT_EMAIL}.`,
  },
  "messaging-declined": {
    title: "Messaging not allowed",
    body: "Private messaging stays off. Nothing else about their account has changed — they can keep using Modern Talent Hub as before.",
  },
  "declined-removed": {
    title: "Declined — account removed",
    body: "You declined. The account has been removed and cannot be used.",
  },
  "declined-locked": {
    title: "Declined",
    body: `You declined. The account cannot be used. If you would also like it deleted, email ${CONTACT_EMAIL} and we will do it.`,
  },
  used: { title: "Already answered", body: "This request has already been answered. Thank you." },
  expired: {
    title: "This link has expired",
    body: "Ask the young person to open Modern Talent Hub and choose “Send the email again”. Only the newest email works.",
  },
  invalid: { title: "This link isn't valid", body: "Please use the newest email we sent you." },
};

export default async function GuardianDonePage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  const message = (r && MESSAGES[r]) || {
    title: "Something went wrong",
    body: `We couldn't record your answer. Please try the link in the email again, or write to ${CONTACT_EMAIL}.`,
  };

  return (
    <LegalPage title={message.title}>
      <P>{message.body}</P>
    </LegalPage>
  );
}
