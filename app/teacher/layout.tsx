import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/nav/AppShell";
import { requireAgeCleared } from "@/lib/age-gate";
import { EmptyState } from "@/components/ui/EmptyState";

const NAV_ITEMS = [
  { href: "/teacher", label: "Home", icon: "🏠" },
  { href: "/teacher/lessons", label: "Lessons", icon: "📘" },
  { href: "/teacher/activities", label: "Activities", icon: "🎯" },
  { href: "/teacher/wallet", label: "Wallet", icon: "💰" },
];

export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  const { user, profile } = await requireRole("teacher");

  // Teachers can sign in as soon as their email is verified, but they get NO
  // teacher features until an admin approves them (Admin → Teachers). Gating
  // here covers every /teacher/* page at once; the create-lesson / create-activity
  // actions and a database trigger enforce the same rule for direct requests.
  const supabase = await createClient();
  // Age check first (Stage 2): teacher accounts are for adults. Redirects if not cleared.
  await requireAgeCleared(supabase, user, "teacher");
  const { data: teacherProfile } = await supabase
    .from("teacher_profiles")
    .select("approved")
    .eq("profile_id", user.id)
    .maybeSingle();
  const approved = teacherProfile?.approved === true;

  return (
    <AppShell navItems={approved ? NAV_ITEMS : NAV_ITEMS.slice(0, 1)} userName={profile.full_name} roleLabel="Teacher">
      {approved ? (
        children
      ) : (
        <EmptyState
          title="Your teacher account is pending approval"
          description="Your email is verified. An admin needs to review and approve your account before you can use teacher features. Once it's approved, log in again and you'll have full access."
        />
      )}
    </AppShell>
  );
}
