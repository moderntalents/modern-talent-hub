import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { requireAgeCleared } from "@/lib/age-gate";
import { AppShell } from "@/components/nav/AppShell";

const NAV_ITEMS = [
  { href: "/student", label: "Home", icon: "🏠" },
  { href: "/student/subjects", label: "Subjects", icon: "📘" },
  { href: "/student/marketplace", label: "Marketplace", icon: "🎯" },
  { href: "/student/subscriptions", label: "Payments", icon: "💳" },
];

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const { user, profile } = await requireRole("student");
  // Age check + parent/guardian approval for under-18s (Stage 2). Redirects if not cleared.
  await requireAgeCleared(await createClient(), user, "student");

  return (
    <AppShell navItems={NAV_ITEMS} userName={profile.full_name} roleLabel="Student">
      {children}
    </AppShell>
  );
}
