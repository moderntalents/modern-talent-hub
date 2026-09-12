"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Free activities skip payment entirely and are activated immediately.
 * Runs the actual insert with the service role because RLS only allows a
 * client-authored subscription row in "pending_payment" state (see
 * subscriptions_student_insert in 0001_init.sql) — every price/status check
 * that would normally live in that policy is done here instead, server-side.
 */
export async function enrolFree(activityId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Sign in required.");

  const { data: activity, error: activityError } = await supabase
    .from("activities")
    .select("id, teacher_id, price, status")
    .eq("id", activityId)
    .single();
  if (activityError || !activity) throw new Error("Activity not found.");
  if (activity.price > 0) throw new Error("This activity requires payment.");
  if (activity.status !== "published") throw new Error("This activity is not available.");

  const admin = createAdminClient();
  const { error } = await admin.from("subscriptions").upsert(
    {
      student_id: user.id,
      activity_id: activity.id,
      teacher_id: activity.teacher_id,
      status: "active",
    },
    { onConflict: "student_id,activity_id" },
  );
  if (error) throw new Error(error.message);

  revalidatePath(`/student/marketplace/${activityId}`);
  revalidatePath("/student/subscriptions");
}
