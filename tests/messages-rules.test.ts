import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_BODY_CHARS,
  attachmentPath,
  cleanFileName,
  friendlyMessagingError,
  hasPdfHeader,
  isUuid,
  isValidAttachmentPath,
  validateBody,
  validateDeclaredFile,
} from "../lib/messages/rules";

const CONV = "0a1b2c3d-1111-4222-8333-444455556666";
const FILE = "9f8e7d6c-1111-4222-8333-444455556666";

describe("messaging rules (pure)", () => {
  test("declared file: PDF only, not empty, at most 10 MB", () => {
    assert.equal(validateDeclaredFile({ name: "work.pdf", size: 1 }), null);
    assert.equal(validateDeclaredFile({ name: "WORK.PDF", size: MAX_ATTACHMENT_BYTES }), null);
    assert.match(validateDeclaredFile({ name: "work.pdf", size: MAX_ATTACHMENT_BYTES + 1 })!, /10 MB/);
    assert.match(validateDeclaredFile({ name: "work.pdf", size: 0 })!, /empty/);
    assert.match(validateDeclaredFile({ name: "work.pdf", size: Number.NaN })!, /empty/);
    for (const name of ["work.docx", "work.pdf.exe", "work.html", "work", "pdf", "work.pdf.zip", "malware.exe"]) {
      assert.match(validateDeclaredFile({ name, size: 100 })!, /PDF/, name);
    }
  });

  test("message text is limited to 2000 characters, counted as people count them", () => {
    assert.equal(validateBody(""), null);
    assert.equal(validateBody("x".repeat(MAX_BODY_CHARS)), null);
    assert.match(validateBody("x".repeat(MAX_BODY_CHARS + 1))!, /2000/);
    assert.equal(validateBody("😀".repeat(MAX_BODY_CHARS)), null); // emoji are 2 UTF-16 units but one character
  });

  test("the real bytes must start with %PDF- (a renamed web page, image or program does not)", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    assert.equal(hasPdfHeader(enc("%PDF-1.7\n...")), true);
    assert.equal(hasPdfHeader(enc("%PDF")), false);
    assert.equal(hasPdfHeader(enc("<html><script>alert(1)</script>")), false);
    assert.equal(hasPdfHeader(enc(" %PDF-1.4")), false); // leading junk
    assert.equal(hasPdfHeader(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03])), false); // Windows program
    assert.equal(hasPdfHeader(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])), false); // PNG image
    assert.equal(hasPdfHeader(new Uint8Array()), false);
  });

  test("display names are cleaned: no folders, no odd characters, always .pdf", () => {
    assert.equal(cleanFileName("Fractions worksheet.pdf"), "Fractions worksheet.pdf");
    assert.equal(cleanFileName("../../etc/passwd.pdf"), "passwd.pdf");
    assert.equal(cleanFileName("C:\\Users\\kid\\homework.PDF"), "homework.pdf");
    assert.equal(cleanFileName('a"b<script>.pdf'), "a_b_script_.pdf");
    assert.equal(cleanFileName(".pdf"), "homework.pdf");
    assert.equal(cleanFileName("..."), "homework.pdf");
    assert.equal(cleanFileName("Ünïcödé Mathématiques.pdf"), "Ünïcödé Mathématiques.pdf");
    assert.ok(cleanFileName("x".repeat(500) + ".pdf").length <= 104);
    assert.equal(cleanFileName("report.exe"), "report.exe.pdf"); // never keeps another extension as the "type"
  });

  test("storage paths must be <this conversation>/<uuid>.pdf — nothing else", () => {
    const ok = attachmentPath(CONV, FILE);
    assert.equal(isValidAttachmentPath(CONV, ok), true);
    const bad = [
      `${CONV}/${FILE}.exe`,
      `${CONV}/${FILE}.pdf/extra`,
      `${CONV}/../${CONV}/${FILE}.pdf`,
      `${CONV}//${FILE}.pdf`,
      `/${CONV}/${FILE}.pdf`,
      `${CONV}/not-a-uuid.pdf`,
      `${CONV}/${FILE}.PDF`,
      `${FILE}/${FILE}.pdf`, // a different conversation's folder
      `${CONV}/${FILE}.pdf\n`,
      "",
    ];
    for (const p of bad) assert.equal(isValidAttachmentPath(CONV, p), false, JSON.stringify(p));
    assert.equal(isValidAttachmentPath(CONV, undefined), false);
    assert.equal(isValidAttachmentPath(CONV, 42), false);
    assert.equal(isValidAttachmentPath("not-a-uuid", "not-a-uuid/x.pdf"), false);
  });

  test("uuid check", () => {
    assert.equal(isUuid(CONV), true);
    assert.equal(isUuid("nope"), false);
    assert.equal(isUuid(`${CONV}; drop table messages`), false);
    assert.equal(isUuid(undefined), false);
  });

  test("database rule failures turn into plain sentences, and unknown errors reveal nothing", () => {
    assert.match(friendlyMessagingError("messaging:closed"), /closed/);
    assert.match(friendlyMessagingError("error: messaging:not_cleared (P0001)"), /age check/);
    assert.match(friendlyMessagingError("error: messaging:not_permitted (P0001)"), /parent or guardian's permission/);
    assert.equal(friendlyMessagingError("relation \"messages\" does not exist"), "Something went wrong. Please try again.");
    assert.equal(friendlyMessagingError(null), "Something went wrong. Please try again.");
    assert.equal(friendlyMessagingError("messaging:made_up_reason"), "Something went wrong. Please try again.");
  });
});
