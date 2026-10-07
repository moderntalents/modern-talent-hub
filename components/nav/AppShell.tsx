"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export function AppShell({
  navItems,
  userName,
  roleLabel,
  children,
}: {
  navItems: NavItem[];
  userName: string;
  roleLabel: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl">
      {/* Desktop / tablet sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface p-4 md:flex">
        <div className="mb-6 flex items-center gap-2">
          <Image
            src="/icons/logo-mark.png"
            alt="Modern Talent Hub"
            width={340}
            height={278}
            priority
            className="h-10 w-10 shrink-0 object-contain"
          />
          <div>
            <p className="font-head text-sm font-bold leading-tight">Modern Talent Hub</p>
            <p className="text-xs text-ink-faint">{roleLabel}</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium ${
                  active ? "bg-ink text-white" : "text-ink-soft hover:bg-surface-2"
                }`}
              >
                <span>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <Link
          href="/account"
          className="mt-4 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft hover:bg-surface-2"
        >
          Settings
        </Link>
        <button
          onClick={signOut}
          className="mt-1 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-brand-red-deep hover:bg-surface-2"
        >
          Sign out
        </button>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-[var(--inset-top)] z-10 flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <Image
              src="/icons/logo-mark.png"
              alt="Modern Talent Hub"
              width={340}
              height={278}
              className="h-9 w-9 shrink-0 object-contain"
            />
            <p className="truncate text-sm font-semibold">{userName}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Link href="/account" className="text-xs font-semibold text-ink-soft">
              Settings
            </Link>
            <button onClick={signOut} className="text-xs font-semibold text-brand-red-deep">
              Sign out
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 pb-[calc(6rem+var(--inset-bottom))] md:p-8 md:pb-8">{children}</main>

        {/* Mobile bottom tabs */}
        <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface pb-[var(--inset-bottom)] md:hidden">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 px-0 py-2 text-[10px] font-semibold tracking-tight ${
                  active ? "text-brand-cyan-deep" : "text-ink-faint"
                }`}
              >
                <span className="text-base">{item.icon}</span>
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
