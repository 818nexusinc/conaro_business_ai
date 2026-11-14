import { json } from "./shared/db.ts";
import { canonicalJson, sha256 } from "./shared/hash.ts";
import type { TenantDb } from "./tenancy.ts";

export interface TenantAuditInput {
  actor: string; // "user:<uuid>", "agent:<id>", "system:<component>"
  action: string;
  subjectType: string;
  subjectId?: string | null;
  detail?: Record<string, unknown>;
}

const GENESIS = "0".repeat(64);

/** Appends to the tenant's own hash chain (append-only table, one chain per tenant). */
export async function tenantAudit(tdb: TenantDb, input: TenantAuditInput): Promise<void> {
  await tdb.query("select pg_advisory_xact_lock(hashtext($1))", [`bai_audit:${tdb.tenantId}`]);
  const last = await tdb.query<{ hash: string }>("select hash from bai_audit order by id desc limit 1");
  const prevHash = last[0]?.hash ?? GENESIS;
  const occurredAt = new Date().toISOString();
  const detail = input.detail ?? {};
  const hash = sha256(canonicalJson({ tenantId: tdb.tenantId, prevHash, occurredAt, actor: input.actor, action: input.action,
    subjectType: input.subjectType, subjectId: input.subjectId ?? null, detail }));
  await tdb.query(
    `insert into bai_audit (occurred_at, actor, action, subject_type, subject_id, detail, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8)`,
    [occurredAt, input.actor, input.action, input.subjectType, input.subjectId ?? null, json(detail), prevHash, hash],
  );
}

export async function verifyTenantAudit(tdb: TenantDb): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  const rows = await tdb.query<{ id: string; occurred_at: string | Date; actor: string; action: string; subject_type: string;
    subject_id: string | null; detail: Record<string, unknown>; prev_hash: string; hash: string }>(
    "select id, occurred_at, actor, action, subject_type, subject_id, detail, prev_hash, hash from bai_audit order by id");
  let prev = GENESIS;
  for (const r of rows) {
    const expected = sha256(canonicalJson({ tenantId: tdb.tenantId, prevHash: prev, occurredAt: new Date(r.occurred_at).toISOString(),
      actor: r.actor, action: r.action, subjectType: r.subject_type, subjectId: r.subject_id, detail: r.detail }));
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, checked: rows.length, brokenAt: Number(r.id) };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}
