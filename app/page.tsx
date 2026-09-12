import Image from "next/image";
import { redirect } from "next/navigation";
import { LinkButton } from "@/components/ui/Button";
import { getSessionProfile } from "@/lib/auth";

export default async function SplashPage() {
  const session = await getSessionProfile();
  if (session) {
    redirect(`/${session.profile.role}`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-6 p-6 text-center">
      <div className="inline-flex items-center gap-3 rounded-[22px] border border-line bg-surface px-7 py-5 shadow-[var(--shadow)]">
        <Image src="/icons/logo-source.png" alt="Modern Talent Hub" width={172} height={120} priority />
      </div>
      <div>
        <h1 className="font-head text-2xl font-extrabold">Modern Talent Hub</h1>
        <p className="mt-1 text-sm text-ink-soft">
          CBC subjects, lessons and Kenya&apos;s co-curricular marketplace — Sports, Martial Arts,
          Performing Arts &amp; Music, and Creative Tech &amp; Mind Games.
        </p>
      </div>
      <div className="flex w-full flex-col gap-3">
        <LinkButton href="/signup" className="w-full">
          Get started
        </LinkButton>
        <LinkButton href="/login" variant="outline" className="w-full">
          I already have an account
        </LinkButton>
      </div>
    </main>
  );
}
