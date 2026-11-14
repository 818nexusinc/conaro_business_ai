/**
 * Minimal database port. Production uses postgres.js against PostgreSQL
 * (e.g. a dedicated Supabase project); tests and local simulation use PGlite
 * (real PostgreSQL compiled to WASM), so the same SQL runs in both.
 */
export interface Db {
  /** Run a parameterised statement ($1, $2 ...). Never interpolate values into `text`. */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run `fn` in a transaction. Nested calls reuse the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Run a multi-statement script without parameters (migrations only). */
  exec(script: string): Promise<void>;
  close(): Promise<void>;
  /** Statements still waiting for the database, oldest first (text only, never parameters). */
  pending?(): string[];
}

export async function one<T>(db: Db, text: string, params?: readonly unknown[]): Promise<T> {
  const rows = await db.query<T>(text, params);
  if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
  return rows[0] as T;
}

export async function maybeOne<T>(db: Db, text: string, params?: readonly unknown[]): Promise<T | null> {
  const rows = await db.query<T>(text, params);
  return rows[0] ?? null;
}

/** postgres.js adapter (production). */
export async function createPostgresDb(url: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const transactionPooler = /:6543\b/.test(url);
  const host = new URL(url).hostname;
  const local = ["localhost", "127.0.0.1", "::1", "db"].includes(host) || /sslmode=disable/.test(url);
  const sql = postgres(url, {
    // Hosted databases (e.g. Supabase) are always reached over TLS.
    ssl: local ? false : "require",
    max: 5,
    connect_timeout: 10,
    prepare: !transactionPooler,
    onnotice: () => {},
    // bigint columns come back as strings (as with PGlite's text protocol); callers use Number(...).
  });
  type Runner = { unsafe: (text: string, params?: never[]) => Promise<unknown> };
  // Every statement in progress, so a timed-out page can log what it is waiting for.
  const inFlight = new Map<number, { text: string; at: number; inTx: boolean }>();
  let seq = 0;
  const track = async <T>(text: string, inTx: boolean, run: () => Promise<T>): Promise<T> => {
    const id = ++seq;
    inFlight.set(id, { text: text.replace(/\s+/g, " ").trim().slice(0, 100), at: Date.now(), inTx });
    try { return await run(); } finally { inFlight.delete(id); }
  };
  const wrap = (runner: Runner, inTx: boolean): Db => ({
    async query<T>(text: string, params: readonly unknown[] = []) {
      return track(text, inTx, async () => (await runner.unsafe(text, params.map(normaliseParam) as never[])) as unknown as T[]);
    },
    pending() {
      const now = Date.now();
      return [...inFlight.values()].map((q) => `${Math.round((now - q.at) / 1000)}s${q.inTx ? " (in transaction)" : ""}: ${q.text}`);
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTx) return fn(wrap(runner, true));
      return (await track("[transaction open]", false, () => sql.begin(async (t) => {
        // Safety limits for every transaction. With a connection pooler, a client that dies
        // mid-transaction can leave the server session "idle in transaction", holding its locks;
        // the server now ends such a session after 30 s. Lock waits fail after 15 s instead of
        // hanging until the statement timeout.
        await (t as unknown as Runner).unsafe("set local idle_in_transaction_session_timeout = '30s'; set local lock_timeout = '15s'");
        return fn(wrap(t as unknown as Runner, true));
      }))) as T;
    },
    async exec(script: string) {
      await runner.unsafe(script);
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  });
  return wrap(sql as unknown as Runner, false);
}

/** PGlite adapter (tests, local simulation). Pass a directory to persist, or nothing for memory. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir, { recursive: true });
  }
  const pg = new PGlite(dataDir);
  type Q = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (s: string) => Promise<unknown> };
  const wrap = (runner: Q, inTx: boolean): Db => ({
    async query<T>(text: string, params: readonly unknown[] = []) {
      const res = await runner.query(text, params.map(normaliseParam));
      return res.rows as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTx) return fn(wrap(runner, true));
      return pg.transaction((t) => fn(wrap(t as unknown as Q, true)));
    },
    async exec(script: string) {
      await runner.exec(script);
    },
    async close() {
      await pg.close();
    },
  });
  return wrap(pg as unknown as Q, false);
}

/**
 * Parameters behave the same on both drivers: undefined becomes SQL NULL and
 * Dates are sent as ISO strings.
 */
function normaliseParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/**
 * Serialises a value for a JSON column. Always write the placeholder as
 * `$n::text::jsonb`: with a bare `$n::jsonb`, postgres.js would JSON-encode
 * the string a second time and store a JSON string instead of an object.
 * undefined/null become SQL NULL.
 */
export function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
