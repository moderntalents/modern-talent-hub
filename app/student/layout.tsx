import { requireRole } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";

const NAV_ITEMS = [
  { href: "/student", label: "Home", icon: "🏠" },
  { href: "/student/subjects", label: "Subjects", icon: "📘" },
  { href: "/student/marketplace", label: "Marketplace", icon: "🎯" },
  { href: "/student/subscriptions", label: "Payments", icon: "💳" },
];

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireRole("student");

  return (
    <AppShell navItems={NAV_ITEMS} userName={profile.full_name} roleLabel="Student">
      {children}
    </AppShell>
  );
}
