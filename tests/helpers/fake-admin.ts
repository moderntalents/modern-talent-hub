// A minimal stand-in for the Supabase service-role client (`createAdminClient()`),
// backed directly by the PGlite test database, so lib/mpesa-payments.ts can be
// exercised exactly as it runs in production — including the REAL 0013 triggers
// and constraints — without needing a live Supabase project. It implements only
// the small slice of the query-builder chain that file actually calls:
//   .from(t).select(cols).eq(c,v).maybeSingle()
//   .from(t).insert(obj).select(cols).single()
//   .from(t).insert(obj)                              (no .select())
//   .from(t).update(obj).eq(c,v)[.eq(c2,v2) | .in(c2,[..])]
// Every statement runs as the 'service' role (bypasses RLS, same as production),
// via the same `as(db, actor, fn)` role-switching helper the Phase 1 tests use.
import type { PGlite } from "@electric-sql/pglite";
import { as } from "./db";
import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "in"; val: unknown };
type Result = { data: unknown; error: { message: string } | null };

/** A bound placeholder for one value, e.g. "$3" or "$3::jsonb" for an object/array. */
function bindValue(values: unknown[], v: unknown): string {
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    values.push(JSON.stringify(v));
    return `$${values.length}::jsonb`;
  }
  values.push(v);
  return `$${values.length}`;
}

class QueryBuilder implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private cols = "*";
  private selectCalled = false;
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private wantSingle: "single" | "maybeSingle" | null = null;

  constructor(
    private db: PGlite,
    private table: string,
  ) {}

  select(cols = "*") {
    this.cols = cols;
    this.selectCalled = true;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push({ col, op: "in", val: vals });
    return this;
  }
  insert(payload: Row) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  single() {
    this.wantSingle = "single";
    return this;
  }
  maybeSingle() {
    this.wantSingle = "maybeSingle";
    return this;
  }

  private whereClause(values: unknown[]): string {
    if (!this.filters.length) return "";
    const parts = this.filters.map((f) => {
      if (f.op === "eq") return `${f.col} = ${bindValue(values, f.val)}`;
      const placeholders = (f.val as unknown[]).map((v) => bindValue(values, v));
      return `${f.col} in (${placeholders.join(",")})`;
    });
    return ` where ${parts.join(" and ")}`;
  }

  private build(): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    if (this.mode === "insert") {
      const cols = Object.keys(this.payload!);
      const placeholders = cols.map((c) => bindValue(values, this.payload![c]));
      let text = `insert into ${this.table} (${cols.join(",")}) values (${placeholders.join(",")})`;
      if (this.selectCalled || this.wantSingle) text += ` returning ${this.cols}`;
      return { text, values };
    }
    if (this.mode === "update") {
      const cols = Object.keys(this.payload!);
      const sets = cols.map((c) => `${c} = ${bindValue(values, this.payload![c])}`);
      let text = `update ${this.table} set ${sets.join(", ")}`;
      text += this.whereClause(values);
      if (this.selectCalled || this.wantSingle) text += ` returning ${this.cols}`;
      return { text, values };
    }
    let text = `select ${this.cols} from ${this.table}`;
    text += this.whereClause(values);
    return { text, values };
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const exec = async (): Promise<Result> => {
      const { text, values } = this.build();
      try {
        const r = await as(this.db, "service", () => this.db.query<Row>(text, values));
        let data: unknown = r.rows;
        if (this.wantSingle === "single") {
          if (r.rows.length !== 1) {
            return { data: null, error: { message: `expected exactly one row, got ${r.rows.length}` } };
          }
          data = r.rows[0];
        } else if (this.wantSingle === "maybeSingle") {
          data = r.rows[0] ?? null;
        } else if (this.mode !== "select" && !this.selectCalled) {
          data = null;
        }
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    };
    return exec().then(onfulfilled, onrejected);
  }
}

// Postgres functions (called via .rpc() in real Supabase) that return a single
// composite row (not a scalar, not a SETOF) — real supabase-js hands these back as one
// plain object, not wrapped in an array. Every other function here is scalar or void.
const COMPOSITE_RETURNING_FUNCTIONS = new Set(["create_b2c_attempt", "authorize_b2c_retry"]);

class RpcCall implements PromiseLike<Result> {
  constructor(
    private db: PGlite,
    private fn: string,
    private args: Record<string, unknown>,
  ) {}

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const exec = async (): Promise<Result> => {
      const values: unknown[] = [];
      const keys = Object.keys(this.args);
      const callArgs = keys.map((k) => `${k} := ${bindValue(values, this.args[k])}`).join(", ");
      const composite = COMPOSITE_RETURNING_FUNCTIONS.has(this.fn);
      const text = composite
        ? `select * from ${this.fn}(${callArgs})`
        : `select ${this.fn}(${callArgs}) as result`;
      try {
        const r = await as(this.db, "service", () => this.db.query<Row>(text, values));
        const data = composite ? (r.rows[0] ?? null) : (r.rows[0]?.result ?? null);
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    };
    return exec().then(onfulfilled, onrejected);
  }
}

export function fakeAdmin(db: PGlite): AdminClient {
  return {
    from: (table: string) => new QueryBuilder(db, table),
    rpc: (fn: string, args: Record<string, unknown> = {}) => new RpcCall(db, fn, args),
  } as unknown as AdminClient;
}

// A stand-in for the server's Supabase client, for the service tests.
//   * rpc() runs the REAL SQL functions in the test Postgres, as the service role.
//   * storage is an in-memory bucket that behaves like Supabase Storage for the calls we make.
// Only the browser's upload is simulated (Supabase Storage's own 10 MB / PDF-only bucket limit is
// enforced by Supabase, not by our code, so it can't be exercised here — the server-side checks that
// back it up are what these tests prove).

import type { Admin } from "../../lib/messages/service";

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
