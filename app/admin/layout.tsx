import { requireRole } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";

const NAV_ITEMS = [
  { href: "/admin", label: "Home", icon: "🏠" },
  { href: "/admin/teachers", label: "Teachers", icon: "🧑‍🏫" },
  { href: "/admin/withdrawals", label: "Withdrawals", icon: "💸" },
  { href: "/admin/transactions", label: "Transactions", icon: "📊" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireRole("admin");

  return (
    <AppShell navItems={NAV_ITEMS} userName={profile.full_name} roleLabel="Admin">
      {children}
    </AppShell>
  );
}
