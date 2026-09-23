import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { attachmentDownloadUrl } from "@/lib/messages/service";

// Download of one message attachment. There is no public URL for these files: the browser asks HERE,
// and this route
//   1. identifies the person from their login,
//   2. reads the message AS THAT PERSON (row-level security only returns messages from conversations
//      they are one of the two people in, while both are age-cleared), and
//   3. only then asks storage for a link that stops working after a minute, and sends them to it.
// Someone who changes the id in the address, or has never been in the conversation, gets "not found" —
// exactly the same answer as for a message that doesn't exist.

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return new NextResponse("Please sign in.", { status: 401, headers: HEADERS });

    const url = await attachmentDownloadUrl(
      createAdminClient(),
      async (id) => {
        const { data } = await supabase
          .from("messages")
          .select("attachment_path, attachment_name")
          .eq("id", id)
          .maybeSingle();
        return data;
      },
      messageId,
    );

    if (!url) return new NextResponse("Not found.", { status: 404, headers: HEADERS });
    return NextResponse.redirect(url, { status: 302, headers: HEADERS });
  } catch (err) {
    console.error("[messages] attachment download failed:", err);
    return new NextResponse("Something went wrong.", { status: 500, headers: HEADERS });
  }
}
