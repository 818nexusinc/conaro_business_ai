import type { Db } from "./db.ts";
import { MIGRATIONS } from "../generated/assets.ts";

/**
 * Forward-only SQL migrations, each in its own transaction. The SQL is embedded at build time
 * (src/generated/assets.ts, from db/migrations) so a bundled deployment reads no files.
 * The ledger is `bai_schema_migrations` (not `schema_migrations`) and every object is prefixed
 * `bai_`, so this application can share a PostgreSQL database with the CONARO operating system
 * without either seeing the other's migrations.
 */
export async function migrate(db: Db, migrations: readonly { name: string; sql: string }[] = MIGRATIONS): Promise<string[]> {
  await db.exec("create table if not exists bai_schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  const ran: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    await db.tx(async (tx) => {
      await tx.query("set local lock_timeout = '15s'");
      // Serialise concurrent migrators (several instances starting together).
      await tx.query("select pg_advisory_xact_lock(hashtext('bai_schema_migrations'))");
      if ((await tx.query("select 1 from bai_schema_migrations where version = $1", [m.name])).length) return;
      await tx.exec(m.sql);
      await tx.query("insert into bai_schema_migrations (version) values ($1)", [m.name]);
      ran.push(m.name);
    });
  }
  return ran;
}
