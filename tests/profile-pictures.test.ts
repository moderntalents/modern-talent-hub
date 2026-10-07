// Coach profile pictures (migration 0020 + lib/avatars/*), run against the real database rules and an
// in-memory bucket. Most of these tests are about WHO may change a picture (only the coach themself,
// enforced by the server and the database, never by anything the browser says) and WHAT may be stored
// (only a real, reasonably sized JPEG / PNG / WebP — judged from the file's own bytes).

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTestDb, rejects } from "./helpers/db";
import { ID, seedWorld } from "./helpers/seed";
import { makeFakeAdmin, type FakeAdmin } from "./helpers/fake-admin";
import * as avatars from "../lib/avatars/service";
import * as directory from "../lib/directory/service";
import {
  AVATAR_BUCKET,
  MAX_AVATAR_BYTES,
  avatarPath,
  centerSquare,
  detectImage,
  friendlyAvatarError,
  isValidAvatarPath,
  validateAvatarBytes,
  validatePickedPhoto,
} from "../lib/avatars/rules";
import { avatarSrc } from "../lib/directory/rules";

const SUPABASE_URL = "https://abcdefgh.supabase.co";
const FILE_A = "11111111-1111-4111-8111-111111111111";
const FILE_B = "22222222-2222-4222-8222-222222222222";

// ---- tiny images, built by hand: just enough real structure for the size to be read ----
const u8 = (...n: number[]) => Uint8Array.from(n);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);
const be32 = (n: number) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const be16 = (n: number) => u8((n >> 8) & 255, n & 255);
const le16 = (n: number) => u8(n & 255, (n >> 8) & 255);
const le24 = (n: number) => u8(n & 255, (n >> 8) & 255, (n >> 16) & 255);
const pad = (bytes: Uint8Array, total: number) => (bytes.length >= total ? bytes : cat(bytes, new Uint8Array(total - bytes.length)));

const png = (w: number, h: number) => cat(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), be32(13), text("IHDR"), be32(w), be32(h), u8(8, 2, 0, 0, 0), be32(0));
const jpeg = (w: number, h: number) =>
  cat(u8(0xff, 0xd8), u8(0xff, 0xe0), be16(16), text("JFIF\0"), u8(1, 1, 0), be16(1), be16(1), u8(0, 0), u8(0xff, 0xdb), be16(4), u8(0, 0), u8(0xff, 0xc0), be16(11), u8(8), be16(h), be16(w), u8(1, 1, 0x11, 0), u8(0xff, 0xd9));
const webpLossy = (w: number, h: number) => cat(text("RIFF"), be32(0), text("WEBP"), text("VP8 "), be32(10), u8(0, 0, 0), u8(0x9d, 0x01, 0x2a), le16(w), le16(h), new Uint8Array(8));
const webpLossless = (w: number, h: number) => {
  const wm = w - 1, hm = h - 1;
  return cat(text("RIFF"), be32(0), text("WEBP"), text("VP8L"), be32(5), u8(0x2f, wm & 255, ((wm >> 8) & 0x3f) | ((hm & 3) << 6), (hm >> 2) & 255, (hm >> 10) & 0x0f), new Uint8Array(8));
};
const webpExtended = (w: number, h: number, animated = false) => cat(text("RIFF"), be32(0), text("WEBP"), text("VP8X"), be32(10), u8(animated ? 0x02 : 0, 0, 0, 0), le24(w - 1), le24(h - 1), new Uint8Array(8));

let db: PGlite;
let fake: FakeAdmin;

const rows = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const avatarOf = async (id: string) => (await rows("select avatar_url from profiles where id = $1", [id]))[0].avatar_url as string | null;

before(async () => {
  db = await createTestDb();
  await seedWorld(db);
  await db.exec(`update profiles set full_name = 'David Pagni' where id = '${ID.T2}';`);
});

beforeEach(async () => {
  await db.exec("delete from auth_rate_limits; update profiles set avatar_url = null;");
  fake = makeFakeAdmin(db);
});

/** The whole honest flow: server issues a link, the browser uploads, the server checks and saves. */
async function upload(user: string, bytes: Uint8Array, contentType = "image/jpeg") {
  const ticket = await avatars.prepareAvatarUpload(fake.admin, user, { contentType, size: bytes.length });
  assert.ok(ticket.ok, `setup: upload link: ${JSON.stringify(ticket)}`);
  fake.browserUpload(ticket.path, bytes);
  return { path: ticket.path, result: await avatars.saveAvatar(fake.admin, user, { path: ticket.path }) };
}
const goodJpeg = () => pad(jpeg(512, 512), 40_000);

describe("uploading, changing and removing", () => {
  test("a coach uploads a picture: it is stored in their own folder and becomes their profile picture", async () => {
    const { path, result } = await upload(ID.T2, goodJpeg());
    assert.ok(result.ok);
    assert.match(path, new RegExp(`^${ID.T2}/[0-9a-f-]{36}\\.jpg$`));
    assert.equal(await avatarOf(ID.T2), path);
    assert.ok(fake.files.has(path));
  });

  test("changing it replaces the profile picture and deletes the old file — nothing piles up", async () => {
    const first = await upload(ID.T2, goodJpeg());
    const second = await upload(ID.T2, pad(png(300, 300), 5000), "image/png");
    assert.ok(first.result.ok && second.result.ok);
    assert.equal(await avatarOf(ID.T2), second.path);
    assert.ok(!fake.files.has(first.path), "the old picture is gone");
    assert.ok(fake.removed.includes(first.path));
    assert.deepEqual([...fake.files.keys()], [second.path], "only the current picture remains");
    assert.match(second.path, /\.png$/);
  });

  test("an abandoned upload left in the folder is cleaned up with the next save", async () => {
    const stray = await avatars.prepareAvatarUpload(fake.admin, ID.T2, { contentType: "image/jpeg", size: 1000 });
    assert.ok(stray.ok);
    fake.browserUpload(stray.path, goodJpeg()); // uploaded, never saved
    const { path, result } = await upload(ID.T2, goodJpeg());
    assert.ok(result.ok);
    assert.deepEqual([...fake.files.keys()], [path]);
  });

  test("removing it clears the profile picture and deletes every file", async () => {
    await upload(ID.T2, goodJpeg());
    const stray = await avatars.prepareAvatarUpload(fake.admin, ID.T2, { contentType: "image/jpeg", size: 1000 });
    assert.ok(stray.ok);
    fake.browserUpload(stray.path, goodJpeg());
    assert.deepEqual(await avatars.removeAvatar(fake.admin, ID.T2), { ok: true });
    assert.equal(await avatarOf(ID.T2), null);
    assert.equal(fake.files.size, 0);
    assert.deepEqual(await avatars.removeAvatar(fake.admin, ID.T2), { ok: true }, "removing again is harmless");
  });

  test("the picture only ever touches the person's own folder", async () => {
    await upload(ID.T2, goodJpeg());
    await upload(ID.T1, goodJpeg());
    const folders = [...fake.files.keys()].map((p) => p.split("/")[0]).sort();
    assert.deepEqual(folders, [ID.T1, ID.T2].sort());
    await avatars.removeAvatar(fake.admin, ID.T2);
    assert.deepEqual([...fake.files.keys()].map((p) => p.split("/")[0]), [ID.T1], "removing one coach's picture leaves the other's");
  });
});

describe("only the coach themself, and only a real picture", () => {
  test("a student can't have a picture: the database refuses and the uploaded file is deleted", async () => {
    const { path, result } = await upload(ID.S1, goodJpeg());
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /Only coaches/);
    assert.equal(await avatarOf(ID.S1), null);
    assert.ok(!fake.files.has(path));
    const removed = await avatars.removeAvatar(fake.admin, ID.S1);
    assert.equal(removed.ok, false);
  });

  test("nobody can save, replace or remove a picture in someone else's folder", async () => {
    const mine = await upload(ID.T2, goodJpeg());
    assert.ok(mine.result.ok);
    // T1 tries to adopt T2's file, and a path of their own making in T2's folder.
    const adopt = await avatars.saveAvatar(fake.admin, ID.T1, { path: mine.path });
    assert.equal(adopt.ok, false);
    const forgedPath = avatarPath(ID.T2, FILE_A, "image/jpeg");
    fake.files.set(forgedPath, goodJpeg());
    const forge = await avatars.saveAvatar(fake.admin, ID.T1, { path: forgedPath });
    assert.equal(forge.ok, false);
    assert.equal(await avatarOf(ID.T1), null);
    assert.equal(await avatarOf(ID.T2), mine.path, "T2's picture is untouched");
    assert.ok(fake.files.has(mine.path) && fake.files.has(forgedPath), "and so are their files");
  });

  test("a path that isn't exactly <my id>/<random id>.<jpg|png|webp> is refused", async () => {
    const t2 = ID.T2;
    for (const bad of [
      `${t2}/../${ID.T1}/${FILE_A}.jpg`,
      `${t2}/${FILE_A}.jpg/../x`,
      `${t2}/${FILE_A}.svg`,
      `${t2}/${FILE_A}.gif`,
      `${t2}/${FILE_A}.JPG`,
      `${t2}/photo.jpg`,
      `${t2}/sub/${FILE_A}.jpg`,
      `${t2}//${FILE_A}.jpg`,
      `${FILE_A}.jpg`,
      `${ID.T1}/${FILE_A}.jpg`,
      `${t2}/${FILE_A}.jpg?x=1`,
      `${t2}/${FILE_A}.jpg `,
      "",
      "../etc/passwd",
    ]) {
      const r = await avatars.saveAvatar(fake.admin, t2, { path: bad });
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    for (const weird of [undefined, null, 5, {}, [`${t2}/${FILE_A}.jpg`]] as unknown[]) {
      assert.equal((await avatars.saveAvatar(fake.admin, t2, { path: weird as string })).ok, false);
    }
    assert.equal((await avatars.saveAvatar(fake.admin, t2, undefined as unknown as { path: string })).ok, false);
    assert.equal(await avatarOf(t2), null);
  });

  test("a file that isn't a picture is refused and deleted — a renamed web page, a program, a GIF, an SVG", async () => {
    const existing = await upload(ID.T2, goodJpeg());
    assert.ok(existing.result.ok);
    for (const [label, bytes] of [
      ["html", text("<!doctype html><script>alert(1)</script>".padEnd(2000, " "))],
      ["svg", text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'.padEnd(2000, " "))],
      ["gif", cat(text("GIF89a"), new Uint8Array(3000))],
      ["exe", cat(text("MZ"), new Uint8Array(3000))],
      ["pdf", cat(text("%PDF-1.4"), new Uint8Array(3000))],
      ["zip", cat(text("PK"), u8(3, 4), new Uint8Array(3000))],
      ["random", Uint8Array.from({ length: 3000 }, (_, i) => (i * 37) & 255)],
      ["almost a jpeg", cat(u8(0xff, 0xd8), new Uint8Array(3000))],
      ["truncated png", png(300, 300).slice(0, 20)],
    ] as [string, Uint8Array][]) {
      const { path, result } = await upload(ID.T2, bytes);
      assert.equal(result.ok, false, label);
      assert.match((result as { message: string }).message, /isn't a JPG, PNG or WebP|too small|empty/, label);
      assert.ok(!fake.files.has(path), `${label}: the rejected file is deleted`);
    }
    assert.equal(await avatarOf(ID.T2), existing.path, "their existing picture is untouched by all those attempts");
    assert.ok(fake.files.has(existing.path));
  });

  test("a file that claims one type but is another is refused", async () => {
    // PNG bytes uploaded to a .jpg path
    const ticket = await avatars.prepareAvatarUpload(fake.admin, ID.T2, { contentType: "image/jpeg", size: 5000 });
    assert.ok(ticket.ok);
    fake.browserUpload(ticket.path, pad(png(400, 400), 5000));
    const r = await avatars.saveAvatar(fake.admin, ID.T2, { path: ticket.path });
    assert.equal(r.ok, false);
    assert.ok(!fake.files.has(ticket.path));
    assert.equal(await avatarOf(ID.T2), null);
  });

  test("size and dimensions are checked on the real file", async () => {
    // The browser claims a small file, then uploads a big one (the bucket's own limit is a second wall).
    const ticket = await avatars.prepareAvatarUpload(fake.admin, ID.T2, { contentType: "image/jpeg", size: 1000 });
    assert.ok(ticket.ok);
    fake.browserUpload(ticket.path, pad(jpeg(512, 512), MAX_AVATAR_BYTES + 1));
    const tooBig = { path: ticket.path, result: await avatars.saveAvatar(fake.admin, ID.T2, { path: ticket.path }) };
    assert.equal(tooBig.result.ok, false);
    assert.match((tooBig.result as { message: string }).message, /too large/);
    const tiny = await upload(ID.T2, jpeg(50, 50));
    assert.match((tiny.result as { message: string }).message, /too small/);
    const huge = await upload(ID.T2, pad(png(20000, 20000), 4000));
    assert.match((huge.result as { message: string }).message, /dimensions are too large/);
    const sliver = await upload(ID.T2, pad(png(4000, 90), 4000));
    assert.match((sliver.result as { message: string }).message, /too small/);
    for (const r of [tooBig, tiny, huge, sliver]) assert.ok(!fake.files.has(r.path));
    assert.equal(fake.files.size, 0);
  });

  test("the browser saying 'saved' without uploading anything changes nothing", async () => {
    const ticket = await avatars.prepareAvatarUpload(fake.admin, ID.T2, { contentType: "image/jpeg", size: 1000 });
    assert.ok(ticket.ok);
    const r = await avatars.saveAvatar(fake.admin, ID.T2, { path: ticket.path });
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /couldn't find/);
    assert.equal(await avatarOf(ID.T2), null);
  });

  test("the upload link request is checked: type, size, and rate", async () => {
    const ask = (contentType: string, size: number) => avatars.prepareAvatarUpload(fake.admin, ID.T2, { contentType, size });
    for (const [type, size] of [["image/gif", 100], ["image/svg+xml", 100], ["text/html", 100], ["application/pdf", 100], ["", 100], ["IMAGE/JPEG", 100], ["image/jpeg", 0], ["image/jpeg", -5], ["image/jpeg", MAX_AVATAR_BYTES + 1], ["image/jpeg", NaN]] as [string, number][]) {
      assert.equal((await ask(type, size)).ok, false, `${type} ${size}`);
    }
    assert.equal((await avatars.prepareAvatarUpload(fake.admin, ID.T2, undefined as unknown as { contentType: string; size: number })).ok, false);
    assert.equal((await avatars.prepareAvatarUpload(fake.admin, "nope", { contentType: "image/jpeg", size: 10 })).ok, false);
    for (const type of ["image/jpeg", "image/png", "image/webp"]) assert.equal((await ask(type, 1000)).ok, true, type);

    await db.exec("delete from auth_rate_limits");
    let refused = 0;
    for (let i = 0; i < avatars.AVATAR_LIMIT.max + 8; i++) if (!(await ask("image/jpeg", 1000)).ok) refused++;
    assert.equal(refused, 8, "after 20 requests in an hour, further ones are refused");
  });

  test("each picture gets a new random path, so the old one is never served from a cache", async () => {
    const a = await upload(ID.T2, goodJpeg());
    const b = await upload(ID.T2, goodJpeg());
    assert.notEqual(a.path, b.path);
  });

  test("removing is rate limited like uploading", async () => {
    await db.exec("delete from auth_rate_limits");
    const results = [];
    for (let i = 0; i < avatars.AVATAR_LIMIT.max + 3; i++) results.push((await avatars.removeAvatar(fake.admin, ID.T2)).ok);
    assert.equal(results.filter((ok) => !ok).length, 3);
  });
});

describe("the picture shows up for students", () => {
  test("after an upload, the student's directory and the coach profile use the new picture; after removal, initials", async () => {
    await db.query("insert into subscriptions (student_id, activity_id, teacher_id, status) values ($1, $2, $3, 'active') on conflict do nothing", [ID.S1, ID.A1, ID.T2]);
    const { path } = await upload(ID.T2, goodJpeg());
    const expected = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}`;

    const listed = await directory.listDirectory(fake.admin, ID.S1, { query: "david", supabaseUrl: SUPABASE_URL });
    assert.ok(listed.ok);
    assert.equal(listed.teachers[0].avatarSrc, expected);
    assert.equal((await directory.getDirectoryTeacher(fake.admin, ID.S1, ID.T2, { supabaseUrl: SUPABASE_URL }))?.avatarSrc, expected);

    const second = await upload(ID.T2, goodJpeg());
    const after = await directory.getDirectoryTeacher(fake.admin, ID.S1, ID.T2, { supabaseUrl: SUPABASE_URL });
    assert.equal(after?.avatarSrc, `${SUPABASE_URL}/storage/v1/object/public/avatars/${second.path}`, "a change shows straight away, at a new address");

    await avatars.removeAvatar(fake.admin, ID.T2);
    const gone = await directory.getDirectoryTeacher(fake.admin, ID.S1, ID.T2, { supabaseUrl: SUPABASE_URL });
    assert.equal(gone?.avatarSrc, null);
  });

  test("a stored address that isn't one of ours is never shown to students", () => {
    assert.equal(avatarSrc("https://evil.example/x.png", ID.T2, SUPABASE_URL), null);
    assert.equal(avatarSrc(`${ID.T1}/${FILE_A}.jpg`, ID.T2, SUPABASE_URL), null);
  });
});

describe("account deletion removes the pictures", () => {
  test("every file in the person's folder goes, and no one else's", async () => {
    await upload(ID.T2, goodJpeg());
    const stray = await avatars.prepareAvatarUpload(fake.admin, ID.T2, { contentType: "image/jpeg", size: 1000 });
    assert.ok(stray.ok);
    fake.browserUpload(stray.path, goodJpeg());
    await upload(ID.T1, goodJpeg());
    await avatars.removeUserAvatars(fake.admin, ID.T2);
    assert.deepEqual([...fake.files.keys()].map((p) => p.split("/")[0]), [ID.T1]);
    await avatars.removeUserAvatars(fake.admin, ID.S7); // nothing to remove: fine
    await avatars.removeUserAvatars(fake.admin, "nope"); // not an id: ignored
  });

  test("a file that can't be removed stops the deletion, so it can be retried", async () => {
    await upload(ID.T2, goodJpeg());
    fake.failNext("remove");
    await assert.rejects(avatars.removeUserAvatars(fake.admin, ID.T2), /remove profile pictures/);
    fake.failNext("list");
    await assert.rejects(avatars.removeUserAvatars(fake.admin, ID.T2), /list profile pictures/);
    await avatars.removeUserAvatars(fake.admin, ID.T2);
    assert.equal(fake.files.size, 0);
  });
});

describe("the database rules (migration 0020)", () => {
  test("a signed-in person can no longer write a profile picture address directly — not their own, not anyone's", async () => {
    for (const actor of [{ id: ID.T2 }, { id: ID.S1 }, { id: ID.ADMIN }, "anon"] as const) {
      assert.equal(await rejects(db, actor, "update profiles set avatar_url = 'https://evil.example/x.png' where id = $1", [ID.T2]), true, JSON.stringify(actor));
    }
    assert.equal(await rejects(db, { id: ID.T2 }, `update profiles set avatar_url = '${ID.T2}/${FILE_A}.jpg' where id = $1`, [ID.T2]), true, "not even a valid-looking path");
    assert.equal(await avatarOf(ID.T2), null);
  });

  test("but ordinary profile edits still work for the person themself", async () => {
    assert.equal(await rejects(db, { id: ID.T2 }, "update profiles set full_name = 'David P', phone = '0700000000' where id = $1", [ID.T2]), false);
    assert.equal((await rows("select full_name from profiles where id = $1", [ID.T2]))[0].full_name, "David P");
    await db.query("update profiles set full_name = 'David Pagni' where id = $1", [ID.T2]);
    // saving the same (unchanged) picture value in a normal edit is allowed
    assert.equal(await rejects(db, { id: ID.T2 }, "update profiles set avatar_url = avatar_url, full_name = 'David Pagni' where id = $1", [ID.T2]), false);
  });

  test("the server (service role) and the SQL editor can still set it", async () => {
    assert.equal(await rejects(db, "service", `update profiles set avatar_url = '${ID.T2}/${FILE_A}.jpg' where id = $1`, [ID.T2]), false);
    assert.equal(await avatarOf(ID.T2), `${ID.T2}/${FILE_A}.jpg`);
    await db.query("update profiles set avatar_url = null where id = $1", [ID.T2]);
  });

  test("the picture functions are server-only", async () => {
    const set = "select set_profile_avatar($1, $2)";
    const clear = "select clear_profile_avatar($1)";
    for (const actor of ["anon", { id: ID.T2 }, { id: ID.S1 }] as const) {
      assert.equal(await rejects(db, actor, set, [ID.T2, `${ID.T2}/${FILE_A}.jpg`]), true, `set as ${JSON.stringify(actor)}`);
      assert.equal(await rejects(db, actor, clear, [ID.T2]), true, `clear as ${JSON.stringify(actor)}`);
    }
    assert.equal(await rejects(db, "service", set, [ID.T2, `${ID.T2}/${FILE_A}.jpg`]), false);
    assert.equal(await rejects(db, "service", clear, [ID.T2]), false);
  });

  test("set_profile_avatar: only teachers, only <their id>/<uuid>.<ext>, and it returns the picture it replaced", async () => {
    const run = (user: string, path: string | null) => as(db, "service", async () => (await db.query<{ r: string | null }>("select set_profile_avatar($1, $2) as r", [user, path])).rows[0].r);
    assert.equal(await run(ID.T2, `${ID.T2}/${FILE_A}.jpg`), null);
    assert.equal(await run(ID.T2, `${ID.T2}/${FILE_B}.webp`), `${ID.T2}/${FILE_A}.jpg`, "returns the old path so the file can be deleted");
    assert.equal(await avatarOf(ID.T2), `${ID.T2}/${FILE_B}.webp`);

    await assert.rejects(run(ID.S1, `${ID.S1}/${FILE_A}.jpg`), /avatar:not_allowed/);
    await assert.rejects(run(ID.ADMIN, `${ID.ADMIN}/${FILE_A}.jpg`), /avatar:not_allowed/);
    await assert.rejects(run(NOBODY, `${NOBODY}/${FILE_A}.jpg`), /avatar:not_allowed/);
    for (const bad of [null, "", `${ID.T1}/${FILE_A}.jpg`, `${ID.T2}/${FILE_A}.gif`, `${ID.T2}/${FILE_A}.JPG`, `${ID.T2}/x.jpg`, `${ID.T2}/${FILE_A}.jpg/x`, `${ID.T2}/../${FILE_A}.jpg`, "https://evil.example/a.jpg", `${ID.T2.toUpperCase()}/${FILE_A}.jpg`]) {
      await assert.rejects(run(ID.T2, bad), /avatar:bad_path/, String(bad));
    }
    assert.equal(await avatarOf(ID.T2), `${ID.T2}/${FILE_B}.webp`, "nothing changed by the refused attempts");
  });

  test("clear_profile_avatar: returns the old path; only teachers", async () => {
    await db.query("update profiles set avatar_url = $1 where id = $2", [`${ID.T2}/${FILE_A}.jpg`, ID.T2]);
    const clear = (user: string) => as(db, "service", async () => (await db.query<{ r: string | null }>("select clear_profile_avatar($1) as r", [user])).rows[0].r);
    assert.equal(await clear(ID.T2), `${ID.T2}/${FILE_A}.jpg`);
    assert.equal(await clear(ID.T2), null);
    await assert.rejects(clear(ID.S1), /avatar:not_allowed/);
  });

  test("the avatars bucket accepts only small JPEG/PNG/WebP files and is still public to read", async () => {
    const [bucket] = await rows("select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1", [AVATAR_BUCKET]);
    assert.equal(bucket.public, true);
    assert.equal(Number(bucket.file_size_limit), MAX_AVATAR_BYTES);
    assert.deepEqual([...(bucket.allowed_mime_types as string[])].sort(), ["image/jpeg", "image/png", "image/webp"]);
  });

  test("browsers have no storage policy for the avatars bucket: they can't upload, overwrite, delete or list", async () => {
    const policies = await rows("select policyname, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects'");
    const mentioning = policies.filter((p) => `${p.qual ?? ""} ${p.with_check ?? ""}`.includes("avatars"));
    assert.deepEqual(mentioning.map((p) => p.policyname), []);
    // behave like a browser: try to write and list as a signed-in coach and as a visitor
    await db.exec(`insert into storage.objects (bucket_id, name, owner) values ('avatars', '${ID.T2}/${FILE_A}.jpg', '${ID.T2}')`);
    for (const actor of [{ id: ID.T2 }, "anon"] as const) {
      assert.equal(await rejects(db, actor, "insert into storage.objects (bucket_id, name) values ('avatars', $1)", [`${ID.T2}/${FILE_B}.jpg`]), true, `insert as ${JSON.stringify(actor)}`);
      const visible = await as(db, actor, async () => (await db.query("select name from storage.objects where bucket_id = 'avatars'")).rows);
      assert.deepEqual(visible, [], `list as ${JSON.stringify(actor)}`);
      assert.equal(await rejects(db, actor, "update storage.objects set name = 'x' where bucket_id = 'avatars'"), true, `update as ${JSON.stringify(actor)}`);
      assert.equal(await rejects(db, actor, "delete from storage.objects where bucket_id = 'avatars'"), true, `delete as ${JSON.stringify(actor)}`);
    }
    assert.equal((await rows("select count(*)::int as n from storage.objects where bucket_id = 'avatars'"))[0].n, 1);
    await db.exec("delete from storage.objects where bucket_id = 'avatars'");
  });

  test("other buckets' policies are untouched", async () => {
    const names = (await rows("select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'")).map((p) => p.policyname as string);
    for (const keep of ["lesson_materials_storage_teacher", "activity_materials_storage_read", "submissions_storage_student"]) assert.ok(names.includes(keep), keep);
  });
});

describe("reading the file's real contents", () => {
  test("JPEG, PNG and WebP (lossy, lossless, extended) are recognised with their real size", () => {
    assert.deepEqual(detectImage(jpeg(640, 480)), { type: "image/jpeg", width: 640, height: 480 });
    assert.deepEqual(detectImage(png(1024, 768)), { type: "image/png", width: 1024, height: 768 });
    assert.deepEqual(detectImage(webpLossy(300, 200)), { type: "image/webp", width: 300, height: 200 });
    assert.deepEqual(detectImage(webpLossless(512, 512)), { type: "image/webp", width: 512, height: 512 });
    assert.deepEqual(detectImage(webpLossless(16384, 3)), { type: "image/webp", width: 16384, height: 3 });
    assert.deepEqual(detectImage(webpExtended(4000, 3000)), { type: "image/webp", width: 4000, height: 3000 });
  });

  test("animated WebP, GIF, SVG, HEIC, BMP, TIFF and everything else are not accepted", () => {
    assert.equal(detectImage(webpExtended(500, 500, true)), null);
    for (const sample of ["GIF89a", "GIF87a", "<svg", "<?xml", "BM", "II*\0", "MM\0*", "\0\0\0\x18ftypheic", "RIFF\0\0\0\0WAVE", "RIFF\0\0\0\0WEBPVP9 "]) {
      assert.equal(detectImage(pad(text(sample), 64)), null, JSON.stringify(sample));
    }
    assert.equal(detectImage(new Uint8Array(0)), null);
    assert.equal(detectImage(u8(0xff, 0xd8, 0xff)), null);
  });

  test("a JPEG is found even when the size comes after other segments (EXIF, comments, restart markers)", () => {
    const exif = cat(u8(0xff, 0xe1), be16(10), new Uint8Array(8));
    const comment = cat(u8(0xff, 0xfe), be16(6), text("hi!!"));
    const sof = cat(u8(0xff, 0xc2), be16(11), u8(8), be16(900), be16(1200), u8(1, 1, 0x11, 0));
    assert.deepEqual(detectImage(cat(u8(0xff, 0xd8), exif, comment, sof)), { type: "image/jpeg", width: 1200, height: 900 });
    // a Huffman table (0xC4) must not be mistaken for the frame header
    const dht = cat(u8(0xff, 0xc4), be16(6), u8(0, 0, 0, 0));
    assert.deepEqual(detectImage(cat(u8(0xff, 0xd8), dht, sof)), { type: "image/jpeg", width: 1200, height: 900 });
    // ...and a file that never says how big it is, isn't accepted
    assert.equal(detectImage(cat(u8(0xff, 0xd8), exif, comment, u8(0xff, 0xda), be16(4), u8(0, 0))), null);
  });

  test("garbage can't make the reader loop or crash", () => {
    for (let n = 0; n < 200; n++) {
      const junk = Uint8Array.from({ length: (n * 7) % 300 }, (_, i) => (i * (n + 3) + n) & 255);
      assert.doesNotThrow(() => detectImage(junk));
      assert.doesNotThrow(() => detectImage(cat(u8(0xff, 0xd8, 0xff), junk)));
      assert.doesNotThrow(() => detectImage(cat(png(10, 10).slice(0, 16), junk)));
      assert.doesNotThrow(() => detectImage(cat(text("RIFF\0\0\0\0WEBPVP8 "), junk)));
    }
    assert.equal(detectImage(cat(u8(0xff, 0xd8), ...Array.from({ length: 500 }, () => cat(u8(0xff, 0xe0), be16(0))))), null, "zero-length segments end the search");
  });

  test("validateAvatarBytes applies size, type and dimension limits", () => {
    assert.equal(validateAvatarBytes(jpeg(512, 512)).ok, true);
    assert.equal(validateAvatarBytes(jpeg(100, 100)).ok, true);
    assert.equal(validateAvatarBytes(jpeg(4096, 4096)).ok, true);
    assert.equal(validateAvatarBytes(jpeg(99, 500)).ok, false);
    assert.equal(validateAvatarBytes(jpeg(4097, 500)).ok, false);
    assert.equal(validateAvatarBytes(new Uint8Array(0)).ok, false);
    assert.equal(validateAvatarBytes(pad(jpeg(512, 512), MAX_AVATAR_BYTES)).ok, true);
    assert.equal(validateAvatarBytes(pad(jpeg(512, 512), MAX_AVATAR_BYTES + 1)).ok, false);
  });

  test("paths: only the shape the server creates", () => {
    assert.equal(isValidAvatarPath(ID.T2, avatarPath(ID.T2, FILE_A, "image/webp")), true);
    assert.equal(avatarPath(ID.T2.toUpperCase(), FILE_A.toUpperCase(), "image/png"), `${ID.T2}/${FILE_A}.png`);
    assert.equal(isValidAvatarPath(ID.T2, `${ID.T1}/${FILE_A}.jpg`), false);
    assert.equal(isValidAvatarPath("not-a-uuid", "not-a-uuid/x.jpg"), false);
  });

  test("the picked photo check and the square crop", () => {
    assert.equal(validatePickedPhoto({ type: "image/jpeg", size: 3_000_000 }), null);
    assert.equal(validatePickedPhoto({ type: "image/heic", size: 3_000_000 }), null, "an iPhone photo: the browser re-draws it as a JPEG");
    assert.equal(validatePickedPhoto({ type: "", size: 3_000_000 }), null, "some phones don't report a type");
    assert.match(validatePickedPhoto({ type: "application/pdf", size: 1000 }) ?? "", /choose a photo/);
    assert.match(validatePickedPhoto({ type: "image/png", size: 0 }) ?? "", /empty/);
    assert.match(validatePickedPhoto({ type: "image/png", size: 26 * 1024 * 1024 }) ?? "", /too large/);
    assert.deepEqual(centerSquare(4000, 3000), [500, 0, 3000]);
    assert.deepEqual(centerSquare(3000, 4000), [0, 500, 3000]);
    assert.deepEqual(centerSquare(512, 512), [0, 0, 512]);
  });

  test("friendly messages", () => {
    assert.match(friendlyAvatarError("avatar:not_allowed"), /Only coaches/);
    assert.match(friendlyAvatarError("avatar:bad_path"), /couldn't be used/);
    assert.match(friendlyAvatarError("anything else"), /Something went wrong/);
    assert.match(friendlyAvatarError(null), /Something went wrong/);
  });
});

const NOBODY = "99999999-0000-4000-8000-000000000999";
