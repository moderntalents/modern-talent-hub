import type { Metadata } from "next";
import Link from "next/link";
import { H2, LegalPage, P, UL } from "@/components/legal/LegalPage";
import { CONTACT_EMAIL, DELETION_REQUEST_DAYS, SITE_URL } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy Policy — Modern Talent Hub",
  description: "How Modern Talent Hub collects, uses, shares and protects personal information, including children's information.",
};

// A public page: no login needed. It describes what the app actually does today.
export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <P>
        Modern Talent Hub (“we”, “us”) is a learning and talent platform for students, teachers and coaches in Kenya. It
        is available as a website at {SITE_URL} and as an Android app. This policy explains what personal information we
        collect, why, who we share it with, how long we keep it, and the choices you have. We have tried to keep it
        plain and short.
      </P>

      <H2>The short version</H2>
      <UL>
        <li>We collect only what we need to run your account, lessons, activities and live classes.</li>
        <li>We do not show advertising, we do not sell your information, and we do not use tracking or analytics tools.</li>
        <li>We do not collect your location, your contacts or your advertising ID.</li>
        <li>You can delete your account and your data yourself, at any time (see “Deleting your account”).</li>
        <li>
          Questions or requests: <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-brand-cyan-deep">{CONTACT_EMAIL}</a>
        </li>
      </UL>

      <H2>Information we collect</H2>
      <P><strong>Everyone who creates an account</strong></P>
      <UL>
        <li>Your full name, email address, phone number and password (we cannot see your password; it is stored in a scrambled form).</li>
        <li>Whether you are a student, teacher or administrator.</li>
        <li>
          If you sign in with Google: the name, email address and profile details Google shares with us. We never receive
          your Google password.
        </li>
      </UL>
      <P><strong>Students</strong></P>
      <UL>
        <li>Your grade or class and, if you choose to give it, your school.</li>
        <li>The activities you join, and the assignments and files you upload.</li>
        <li>The live classes you join and when you joined them.</li>
      </UL>
      <P><strong>Teachers and coaches</strong></P>
      <UL>
        <li>What you teach and an optional short bio.</li>
        <li>The lessons, activities, videos and files you create and upload.</li>
        <li>Payout details you enter to withdraw earnings (an M-Pesa number or bank account details) and your wallet and payout records.</li>
        <li>Live classes you host, and the list of students who joined.</li>
      </UL>
      <P><strong>Live classes (video and audio)</strong></P>
      <UL>
        <li>
          When you join a live class you first see a screen to check your camera and microphone. Your microphone starts
          off; your camera may be on when you join. You can turn either off at any time. (A teacher hosting a class starts
          with their microphone on.) While your camera or microphone is on, your video and audio are sent to the other
          people in that class through our video provider (Daily). Your phone or browser asks your permission first. We do
          not record live classes.
        </li>
        <li>
          Live classes have a group text chat. Your name is shown to the other people in the class. We do not offer private
          messages between users.
        </li>
      </UL>
      <P><strong>Payments</strong></P>
      <UL>
        <li>
          Some features can be paid for with M-Pesa (Safaricom) when payment is switched on for them. You confirm the
          payment with your PIN on your own phone; we never see it. For a payment for an activity, the phone number you
          enter goes to Safaricom and we do not keep it. We keep a record of each payment: who paid and who was paid, the
          amount and currency, the status, the M-Pesa receipt number, the reference numbers Safaricom gives us for that
          payment, and how the amount was shared between the teacher and the platform. For a coach activation fee we also
          keep the phone number used and Safaricom’s result message.
        </li>
      </UL>
      <P><strong>Emails we send you</strong></P>
      <UL>
        <li>Your 5-digit verification code when you register, and password-reset links. These pass through Google’s Gmail service.</li>
      </UL>
      <P><strong>Technical information</strong></P>
      <UL>
        <li>
          Your IP address and browser or device type appear in our hosting and security logs. We also keep short-lived
          security records (for example, to limit repeated sign-up or password-reset requests) for up to a day.
        </li>
        <li>A cookie or similar storage on your device that keeps you signed in. We do not use advertising or tracking cookies.</li>
      </UL>

      <H2>Why we use it</H2>
      <UL>
        <li>To create and secure your account and to verify your email.</li>
        <li>To provide lessons, activities, assignments, live classes and teacher–student communication inside classes.</li>
        <li>To let teachers see who is in their classes, and to let administrators approve teachers and look after the platform.</li>
        <li>To process payments and payouts and to keep the records the law requires.</li>
        <li>To keep the service safe, prevent misuse and fix problems.</li>
      </UL>

      <H2>Who we share it with</H2>
      <P>
        We share information only with the companies that help us run Modern Talent Hub, and only for that purpose. We do
        not sell personal information.
      </P>
      <UL>
        <li><strong>Supabase</strong> — accounts, our database and file storage.</li>
        <li><strong>Vercel</strong> — hosting of the website and app.</li>
        <li><strong>Daily</strong> — live video and audio for live classes.</li>
        <li><strong>Google</strong> — “Sign in with Google”, and Gmail for the emails we send you. When a teacher adds a YouTube video to a lesson, YouTube (Google) may collect information when it is played, under Google’s own policy. We use YouTube’s privacy-enhanced player.</li>
        <li><strong>Safaricom (M-Pesa)</strong> — to process payments and payouts.</li>
      </UL>
      <P>
        Inside the platform, teachers can see the names of the students in their classes and activities, and
        administrators can see account details so they can run the service. We may also disclose information if the law
        requires it or to protect people’s safety.
      </P>
      <P>
        Some of our service providers may process information outside Kenya, including in the United States. We choose
        providers that protect information with appropriate safeguards.
      </P>

      <H2>Children</H2>
      <P>
        Modern Talent Hub is used by students of different ages, including children under 13, and by older students,
        teachers and coaches. We take children’s privacy seriously:
      </P>
      <UL>
        <li>We collect only the information listed above and only what is needed to provide the service.</li>
        <li>We show no advertising, we do not sell children’s information, and we do not track children for marketing.</li>
        <li>We do not collect a child’s location, contacts or advertising ID.</li>
        <li>Children cannot send private messages.</li>
        <li>
          When you join a live class you first see a screen to check your camera and microphone. Your microphone starts
          off; your camera may be on when you join. You can turn either off at any time.
        </li>
        <li>
          <strong>Parents and guardians:</strong> you can ask us at any time to show you what we hold about your child, to correct it,
          or to delete your child’s account and data — email us at{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-brand-cyan-deep">{CONTACT_EMAIL}</a> from the email
          address on the account, or see “Deleting your account”. If you believe a child has given us information without
          your permission, tell us and we will delete it.
        </li>
      </UL>

      <H2>How long we keep information</H2>
      <UL>
        <li>Your account information and content are kept while your account exists and are deleted when you delete it.</li>
        <li>
          Payment and payout records are kept for as long as tax and accounting law requires. When you delete your account,
          your name, email address, phone number and payout details (M-Pesa number or bank account) are removed from them.
          What remains is an anonymous record: amounts, dates, statuses and payment reference numbers.
        </li>
        <li>Email verification codes expire after 10 minutes. Short-lived security records are kept for up to a day.</li>
        <li>
          Our providers may keep their own technical logs and routine backups for a limited time under their own
          policies, so a deleted item can remain in a backup copy for a while before it is overwritten.
        </li>
      </UL>

      <H2>Your rights</H2>
      <P>
        Under the Kenya Data Protection Act, 2019 you have the right to know what information we hold about you, to have
        it corrected, to have it deleted, to object to how it is used, and to receive a copy of it. To use any of these
        rights, email <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-brand-cyan-deep">{CONTACT_EMAIL}</a>. If
        you are unhappy with our response you can complain to the Office of the Data Protection Commissioner of Kenya
        (odpc.go.ke).
      </P>

      <H2>Deleting your account</H2>
      <P>
        You can delete your account yourself: sign in, open <strong>Account &amp; privacy</strong>, and choose{" "}
        <strong>Delete my account</strong>. You can also request deletion without signing in — see the{" "}
        <Link href="/delete-account" className="font-semibold text-brand-cyan-deep">
          account deletion page
        </Link>
        . We complete emailed requests within {DELETION_REQUEST_DAYS} days.
      </P>

      <H2>How we protect information</H2>
      <UL>
        <li>All traffic uses encrypted connections (HTTPS).</li>
        <li>Passwords are stored in a scrambled (hashed) form, and email codes are stored only as one-way hashes.</li>
        <li>
          Uploaded files are not public. Lesson and activity files can be opened only by signed-in users, through
          short-lived links. Students’ assignment files can be seen only by the student and their teacher. Access rules
          also restrict who can see which records.
        </li>
        <li>Teachers are approved by an administrator before they can publish content.</li>
      </UL>
      <P>No system is perfectly secure, but we work to protect your information and will act quickly on any problem we find.</P>

      <H2>Changes to this policy</H2>
      <P>
        If we change this policy we will update this page and the date at the top. If a change is significant we will tell
        you in the app or by email.
      </P>

      <H2>Contact us</H2>
      <P>
        Modern Talent Hub —{" "}
        <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-brand-cyan-deep">{CONTACT_EMAIL}</a>
      </P>
    </LegalPage>
  );
}
