"use client";

import { AVATAR_OUTPUT_SIZE, MAX_AVATAR_BYTES, centerSquare, validatePickedPhoto } from "@/lib/avatars/rules";

export type PreparedAvatar = { ok: true; blob: Blob; previewUrl: string } | { ok: false; message: string };

const UNREADABLE = "We couldn't read that photo. Please choose a JPG, PNG or WebP picture.";

/**
 * Turns the photo a coach picked into what gets uploaded: the middle square of the picture, shrunk to
 * 512 × 512 and saved as a JPEG (a transparent background becomes white). Phone photos can be many
 * megabytes and sideways; this reads the photo the right way up and makes it a small, uniform picture.
 * It runs in the browser only for convenience — the server checks the file it actually receives.
 */
export async function prepareAvatarImage(file: File): Promise<PreparedAvatar> {
  const problem = validatePickedPhoto(file);
  if (problem) return { ok: false, message: problem };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, message: UNREADABLE };
  }

  try {
    const [left, top, side] = centerSquare(bitmap.width, bitmap.height);
    if (side < 1) return { ok: false, message: UNREADABLE };

    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_OUTPUT_SIZE;
    canvas.height = AVATAR_OUTPUT_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return { ok: false, message: UNREADABLE };
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, left, top, side, side, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);

    for (const quality of [0.9, 0.8, 0.65]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.type === "image/jpeg" && blob.size > 0 && blob.size <= MAX_AVATAR_BYTES) {
        return { ok: true, blob, previewUrl: URL.createObjectURL(blob) };
      }
    }
    return { ok: false, message: UNREADABLE };
  } finally {
    bitmap.close();
  }
}
