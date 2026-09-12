import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Signed, time-limited download URL for a private storage object (1 hour). */
export async function getSignedUrl(bucket: string, path: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  if (error) return null;
  return data.signedUrl;
}
