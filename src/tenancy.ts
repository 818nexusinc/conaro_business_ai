import type { Db } from "./shared/db.ts";
import { AccessDeniedError, PermanentError } from "./shared/errors.ts";

/**
 * A database handle bound to one tenant. It can only be obtained from
 * withTenant(), which runs the callback in a transaction as the role
 * `bai_tenant` with `bai.tenant_id` set. Row-level security then limits every
 * statement to that tenant's rows, so a query that forgets a tenant filter
 * still cannot see or write another business's data.
 */
export interface TenantDb extends Db {
  readonly tenantId: string;
  readonly __tenantScoped: true;
}

// Tenant code may not change who it is: no role or setting changes inside a tenant transaction.
const FORBIDDEN = /\b(set|reset)\s+(local\s+|session\s+)?role\b(?!\s*=)|\bset\s+(local\s+|session\s+)?(session\s+authorization|bai\.)|\bset_config\s*\(|\bsession_authorization\b/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T>(db: Db, tenantId: string, fn: (tdb: TenantDb) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new AccessDeniedError("invalid tenant id");
  return db.tx(async (tx) => {
    const current = await tx.query<{ t: string | null; r: string }>("select current_setting('bai.tenant_id', true) t, current_user r");
    const row = current[0];
    if (row?.r === "bai_tenant") {
      // Nested call: never switch tenants inside a tenant transaction.
      if (row.t !== tenantId) throw new AccessDeniedError("cannot switch tenant inside a tenant transaction");
    } else {
      await tx.query("select set_config('bai.tenant_id', $1, true)", [tenantId]);
      await tx.query("set local role bai_tenant");
    }
    const tdb: TenantDb = {
      tenantId,
      __tenantScoped: true,
      query: (text, params) => {
        if (FORBIDDEN.test(text)) throw new AccessDeniedError("tenant code may not change role or session settings");
        return tx.query(text, params);
      },
      tx: (inner) => inner(tdb),
      exec: () => {
        throw new PermanentError("exec is not available to tenant code");
      },
      close: async () => {},
    };
    return fn(tdb);
  });
}

/** Tenants the worker should process (system query; returns ids only). */
export async function activeTenantIds(db: Db): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    "select id from bai_tenants where status in ('onboarding','active') and not paused order by created_at",
  );
  return rows.map((r) => r.id);
}

/** Next human-readable reference for a tenant (Q-0001, BK-0001 ...). */
export async function nextRef(tdb: TenantDb, kind: string, prefix: string): Promise<string> {
  const rows = await tdb.query<{ value: number }>(
    `insert into bai_counters (kind, value) values ($1, 1)
     on conflict (tenant_id, kind) do update set value = bai_counters.value + 1 returning value`,
    [kind],
  );
  return `${prefix}-${String(rows[0]?.value ?? 1).padStart(4, "0")}`;
}
