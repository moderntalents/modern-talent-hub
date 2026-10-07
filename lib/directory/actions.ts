"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AGE_GATE_MESSAGE, isAgeCleared } from "@/lib/age-gate";
import { DIRECTORY_UNAVAILABLE, listDirectory, type DirectoryPage } from "@/lib/directory/service";

// "Load more" in the teacher/coach directory. Like the messaging actions, it works out WHO is asking
// from their login (never from anything the browser sends), applies the age gate, and only lets
// students in; the rule about which teachers they may see is applied again inside the database.
// Failures come back as { ok: false, message } because production hides thrown server-action errors.

export async function loadMoreTeachers(input: { query: string; cursor: string }): Promise<DirectoryPage> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, message: "Please sign in again." };

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "student") return { ok: false, message: "The teacher directory is for students." };
    if (!(await isAgeCleared(user.id, profile.role))) return { ok: false, message: AGE_GATE_MESSAGE };

    return await listDirectory(createAdminClient(), user.id, {
      query: input?.query,
      cursor: input?.cursor,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    });
  } catch (err) {
    console.error("[directory] load more failed:", err);
    return { ok: false, message: DIRECTORY_UNAVAILABLE };
  }
}
