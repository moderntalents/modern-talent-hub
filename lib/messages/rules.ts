// Rules for student ↔ teacher messages and their PDF attachments.
//
// Pure functions and constants with NO imports, so the same code runs in the browser (to give
// quick feedback), on the server (which is what actually enforces them) and in the tests.
// The database enforces the same limits again — see supabase/migrations/0011_messaging.sql.

export const MESSAGE_BUCKET = "message-attachments";
export const MAX_BODY_CHARS = 2000;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
export const PDF_MIME = "application/pdf";

export type MessageKind = "message" | "homework" | "submission";
export const MESSAGE_KINDS: readonly MessageKind[] = ["message", "homework", "submission"];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** null when the text is acceptable. Empty text is fine here: a message may be a file alone. */
export function validateBody(body: string): string | null {
  if ([...body.trim()].length > MAX_BODY_CHARS) return `Messages can be at most ${MAX_BODY_CHARS} characters.`;
  return null;
}

/** Quick check of what the browser SAYS it is sending. The server re-checks the real bytes. */
export function validateDeclaredFile(file: { name: string; size: number }): string | null {
  if (!/\.pdf$/i.test(file.name)) return "Only PDF files can be attached.";
  if (!Number.isFinite(file.size) || file.size <= 0) return "That file is empty.";
  if (file.size > MAX_ATTACHMENT_BYTES) return "That PDF is over 10 MB. Please send a smaller file.";
  return null;
}

/** A safe display / download name: no folders, no odd characters, always ends in .pdf. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const stem = base
    .replace(/\.pdf$/i, "")
    .replace(/[^\p{L}\p{N} ._()-]+/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/, "")
    .trim()
    .slice(0, 100)
    .trim();
  return `${stem || "homework"}.pdf`;
}

/** Every PDF starts with "%PDF-". Anything else (a web page, a program, a renamed image) is refused. */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/** The only shape of storage path the server ever creates: <conversation id>/<random id>.pdf */
export function attachmentPath(conversationId: string, fileId: string): string {
  return `${conversationId}/${fileId}.pdf`;
}

export function isValidAttachmentPath(conversationId: string, path: unknown): path is string {
  return (
    isUuid(conversationId) &&
    typeof path === "string" &&
    new RegExp(`^${conversationId.toLowerCase()}/${UUID}\\.pdf$`).test(path)
  );
}

// The database reports rule failures as "messaging:<reason>". These are the words people see.
const FRIENDLY: Record<string, string> = {
  not_allowed: "You can't message this person.",
  not_cleared: "Messaging isn't available yet — the age check or guardian approval for one of you isn't complete.",
  not_found: "That conversation couldn't be found.",
  closed: "This conversation is closed for new messages. You can still read it.",
  empty: "Write a message or attach a PDF.",
  too_long: `Messages can be at most ${MAX_BODY_CHARS} characters.`,
  bad_request: "That message couldn't be sent.",
  bad_attachment: "That file couldn't be attached. Please choose the PDF again.",
};

export function friendlyMessagingError(raw: string | null | undefined): string {
  const reason = /messaging:([a-z_]+)/.exec(raw ?? "")?.[1];
  return (reason && FRIENDLY[reason]) || "Something went wrong. Please try again.";
}
