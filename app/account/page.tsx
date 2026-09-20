import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { DeleteAccountPanel } from "./DeleteAccountPanel";

export const metadata: Metadata = { title: "Account & privacy — Modern Talent Hub" };

// Sits OUTSIDE the /student and /teacher areas on purpose: a teacher who is still
// waiting for approval is blocked from every /teacher page, but must still be able
// to see their privacy options and delete their account.
export default async function AccountPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login?next=%2Faccount");

  const { user, profile } = session;
  const role = profile.role;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-6">
      <div>
        <Link href={`/${role}`} className="text-sm font-semibold text-brand-cyan-deep">
          ← Back to my dashboard
        </Link>
        <h1 className="mt-2 font-head text-xl font-extrabold">Account &amp; privacy</h1>
      </div>

      <Card className="flex flex-col gap-1">
        <p className="font-semibold">{profile.full_name}</p>
        <p className="text-sm text-ink-soft">{user.email}</p>
        <p className="text-xs capitalize text-ink-faint">{role}</p>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="font-head text-base font-bold">Privacy</h2>
        <Link href="/privacy" className="text-sm font-semibold text-brand-cyan-deep">
          Read our Privacy Policy
        </Link>
        <Link href="/delete-account" className="text-sm font-semibold text-brand-cyan-deep">
          How account deletion works
        </Link>
      </Card>

      {role === "admin" ? (
        <Card>
          <h2 className="font-head text-base font-bold">Delete my account</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Administrator accounts can&apos;t be deleted from here, so the platform is never left without one. Contact the site
            owner if an administrator needs to be removed.
          </p>
        </Card>
      ) : (
        <DeleteAccountPanel role={role} />
      )}
    </main>
  );
}
