// A stand-in for the server's Supabase client, for the service tests.
//   * rpc() runs the REAL SQL functions in the test Postgres, as the service role.
//   * storage is an in-memory bucket that behaves like Supabase Storage for the calls we make.
// Only the browser's upload is simulated (Supabase Storage's own 10 MB / PDF-only bucket limit is
// enforced by Supabase, not by our code, so it can't be exercised here — the server-side checks that
// back it up are what these tests prove).

import type { PGlite } from "@electric-sql/pglite";
import type { Admin } from "../../lib/messages/service";
import { as } from "./db";

const SETOF = new Set(["messaging_conversation_ids"]);

export interface FakeAdmin {
  admin: Admin;
  /** Bytes currently stored, by path. */
  files: Map<string, Uint8Array>;
  /** Paths that were removed, in order. */
  removed: string[];
  /** How many times the server fetched an object's bytes from storage. */
  stats: { downloads: number };
  /** Every signed download link that was created. */
  downloads: { path: string; expiresIn: number; download: unknown }[];
  /** Simulates the browser using the one-time upload link for `path`. */
  browserUpload(path: string, bytes: Uint8Array): void;
  /** Make the next storage call of this kind fail. */
  failNext(kind: "remove" | "list" | "download"): void;
}

export function makeFakeAdmin(db: PGlite, options: { rpcOverride?: (name: string) => { code: string; message: string } | null } = {}): FakeAdmin {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const downloads: FakeAdmin["downloads"] = [];
  const tickets = new Set<string>();
  const failures = new Set<string>();
  const stats = { downloads: 0 };

  const takeFailure = (kind: string) => (failures.delete(kind) ? { message: `${kind} failed (simulated)` } : null);

  const rpc = async (name: string, args: Record<string, unknown>) => {
    const override = options.rpcOverride?.(name);
    if (override) return { data: null, error: override };
    const keys = Object.keys(args);
    const sql = `select * from ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
    try {
      const { rows } = await as(db, "service", () => db.query<Record<string, unknown>>(sql, keys.map((k) => args[k])));
      const values = rows.map((r) => Object.values(r)[0]);
      return { data: SETOF.has(name) ? values : (values[0] ?? null), error: null };
    } catch (err) {
      const e = err as { message: string; code?: string };
      return { data: null, error: { message: e.message, code: e.code } };
    }
  };

  const bucket = () => ({
    createSignedUploadUrl: async (path: string) => {
      tickets.add(path);
      return { data: { signedUrl: `https://storage.test/upload/${path}`, token: `token-${path}`, path }, error: null };
    },
    download: async (path: string) => {
      stats.downloads++;
      const fail = takeFailure("download");
      if (fail) return { data: null, error: fail };
      const bytes = files.get(path);
      return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: "Object not found" } };
    },
    remove: async (paths: string[]) => {
      const fail = takeFailure("remove");
      if (fail) return { data: null, error: fail };
      for (const p of paths) {
        files.delete(p);
        removed.push(p);
      }
      return { data: [], error: null };
    },
    list: async (folder: string, opts?: { limit?: number }) => {
      const fail = takeFailure("list");
      if (fail) return { data: null, error: fail };
      const names = [...files.keys()].filter((p) => p.startsWith(`${folder}/`)).map((p) => p.slice(folder.length + 1));
      return { data: names.slice(0, opts?.limit ?? 100).map((name) => ({ name })), error: null };
    },
    createSignedUrl: async (path: string, expiresIn: number, opts?: { download?: unknown }) => {
      downloads.push({ path, expiresIn, download: opts?.download });
      return { data: { signedUrl: `https://storage.test/sign/${path}?exp=${expiresIn}` }, error: null };
    },
  });

  const admin = { rpc, storage: { from: () => bucket() } } as unknown as Admin;

  return {
    admin,
    files,
    removed,
    stats,
    downloads,
    browserUpload(path, bytes) {
      if (!tickets.delete(path)) throw new Error(`no upload link was issued for ${path}`);
      files.set(path, bytes);
    },
    failNext: (kind) => failures.add(kind),
  };
}

/** A minimal file that starts like a real PDF. */
export function pdfBytes(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
  bytes.set(new TextEncoder().encode("\n%%EOF"), Math.max(0, size - 6));
  return bytes;
}

export const textBytes = (s: string) => new TextEncoder().encode(s);
