import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

/**
 * Forward-only SQL migrations, each in its own transaction. The ledger is `bai_schema_migrations`
 * (not `schema_migrations`) and every object is prefixed `bai_`, so this application can share a
 * PostgreSQL database with the CONARO operating system without either seeing the other's migrations.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec("create table if not exists bai_schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    const script = await readFile(join(dir, file), "utf8");
    await db.tx(async (tx) => {
      await tx.query("set local lock_timeout = '15s'");
      // Serialise concurrent migrators (two instances starting together).
      await tx.query("select pg_advisory_xact_lock(hashtext('bai_schema_migrations'))");
      if ((await tx.query("select 1 from bai_schema_migrations where version = $1", [file])).length) return;
      await tx.exec(script);
      await tx.query("insert into bai_schema_migrations (version) values ($1)", [file]);
      ran.push(file);
    });
  }
  return ran;
}
