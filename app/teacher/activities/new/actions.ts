"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { ActivityCategory, BillingCycle } from "@/lib/supabase/types";

export interface FormState {
  error?: string;
}

export async function createActivity(_prevState: FormState, formData: FormData): Promise<FormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in required." };

  const { data: teacherProfile } = await supabase
    .from("teacher_profiles")
    .select("approved")
    .eq("profile_id", user.id)
    .single();
  if (!teacherProfile?.approved) {
    return { error: "Your teacher account must be approved before publishing activities." };
  }

  const category = formData.get("category") as ActivityCategory;
  const activityType = (formData.get("activityType") as string)?.trim();
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const level = (formData.get("level") as string)?.trim();
  const ageRange = (formData.get("ageRange") as string)?.trim();
  const location = (formData.get("location") as string)?.trim();
  const billing = formData.get("billing") as BillingCycle;
  const priceRaw = formData.get("price") as string;
  const price = billing === "free" ? 0 : Number(priceRaw);

  if (!category) return { error: "Choose a category." };
  if (!activityType) return { error: "Enter the activity type (e.g. Karate, Piano)." };
  if (!title) return { error: "Enter a title." };
  if (!billing) return { error: "Choose a billing cycle." };
  if (billing !== "free" && (!priceRaw || Number.isNaN(price) || price <= 0)) {
    return { error: "Enter a valid price." };
  }

  const { data: activity, error } = await supabase
    .from("activities")
    .insert({
      teacher_id: user.id,
      category,
      activity_type: activityType,
      title,
      description: description || null,
      level: level || null,
      age_range: ageRange || null,
      location: location || null,
      price,
      billing,
      status: "draft",
    })
    .select()
    .single();

  if (error) return { error: error.message };

  redirect(`/teacher/activities/${activity.id}`);
}
