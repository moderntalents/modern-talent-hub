import { requireRole } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";

const NAV_ITEMS = [
  { href: "/teacher", label: "Home", icon: "🏠" },
  { href: "/teacher/lessons", label: "Lessons", icon: "📘" },
  { href: "/teacher/activities", label: "Activities", icon: "🎯" },
  { href: "/teacher/wallet", label: "Wallet", icon: "💰" },
];

export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireRole("teacher");

  return (
    <AppShell navItems={NAV_ITEMS} userName={profile.full_name} roleLabel="Teacher">
      {children}
    </AppShell>
  );
}
