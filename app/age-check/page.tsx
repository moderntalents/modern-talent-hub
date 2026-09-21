import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { gateRedirect, getAgeState, requireSessionForGatePage } from "@/lib/age-gate";
import { AgeCheckForm } from "./AgeCheckForm";

export const metadata: Metadata = { title: "One quick question — Modern Talent Hub", robots: { index: false } };

// Shown to signed-in people who have no date of birth on record yet: new Google sign-ins and
// every account made before the age check existed. Outside the student/teacher layouts on
// purpose, so the layouts can send people here without looping.
export default async function AgeCheckPage() {
  const { user, profile } = await requireSessionForGatePage();
  if (profile.role === "admin") redirect("/admin");

  const state = await getAgeState(await createClient(), user.id);
  const target = gateRedirect(state);
  if (state.kind !== "needs_age") redirect(target ?? `/${profile.role}`);

  return <AgeCheckForm role={profile.role} accountEmail={user.email ?? ""} />;
}
