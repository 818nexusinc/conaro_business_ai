import { createHmac, timingSafeEqual } from "node:crypto";
import { json, maybeOne } from "./shared/db.ts";
import type { TenantDb } from "./tenancy.ts";
import { tenantAudit } from "./audit.ts";

/**
 * Per-business CASL consent ledger for the business's own customers.
 * Validity periods follow s. 10(10) of CASL (see src/compliance/casl.ts for
 * the references): two years after a purchase, six months after an inquiry.
 * Express consent does not expire until withdrawn. Engineering control only;
 * not legal advice.
 */
export type CustomerConsentBasis = "express" | "implied_existing_business_relationship" | "implied_inquiry" | "none";
const DAY = 86_400_000;
const VALID_DAYS: Partial<Record<CustomerConsentBasis, number>> = { implied_existing_business_relationship: 730, implied_inquiry: 183 };

export async function recordCustomerConsent(tdb: TenantDb, input: {
  email: string; customerId?: string; basis: CustomerConsentBasis; source: string; obtainedAt?: Date; evidence?: Record<string, unknown>;
}, actor: string): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (input.basis === "express" && typeof input.evidence?.method !== "string") throw new Error("express consent needs evidence.method");
  const at = input.obtainedAt ?? new Date();
  const days = VALID_DAYS[input.basis];
  await tdb.query(
    `insert into bai_consents (customer_id, email, basis, source, evidence, obtained_at, expires_at) values ($1, $2, $3, $4, $5::text::jsonb, $6, $7)`,
    [input.customerId ?? null, email, input.basis, input.source, json(input.evidence ?? {}), at.toISOString(), days ? new Date(at.getTime() + days * DAY).toISOString() : null]);
  await tenantAudit(tdb, { actor, action: "consent.recorded", subjectType: "customer", subjectId: input.customerId ?? null, detail: { basis: input.basis, source: input.source } });
}

/** Withdraws consent and suppresses the address for this business, permanently. */
export async function unsubscribeCustomer(tdb: TenantDb, email: string, source: string): Promise<void> {
  const e = email.trim().toLowerCase();
  await tdb.query("update bai_consents set withdrawn_at = now() where email = $1 and withdrawn_at is null", [e]);
  await tdb.query("insert into bai_suppressions (email, reason) values ($1, 'unsubscribed') on conflict do nothing", [e]);
  await tenantAudit(tdb, { actor: `system:${source}`, action: "consent.unsubscribed", subjectType: "consent", detail: { source } });
}

export type CustomerConsentDecision = { allowed: true; basis: CustomerConsentBasis } | { allowed: false; reason: string };

export async function checkCustomerConsent(tdb: TenantDb, email: string, now = new Date()): Promise<CustomerConsentDecision> {
  const e = email.trim().toLowerCase();
  if (await maybeOne(tdb, "select 1 from bai_suppressions where email = $1", [e])) return { allowed: false, reason: "suppressed" };
  const rows = await tdb.query<{ basis: CustomerConsentBasis; expires_at: string | null; withdrawn_at: string | null }>(
    "select basis, expires_at, withdrawn_at from bai_consents where email = $1 order by obtained_at desc", [e]);
  if (rows.length === 0) return { allowed: false, reason: "no_consent" };
  if (rows.some((r) => r.withdrawn_at)) return { allowed: false, reason: "consent_withdrawn" };
  const ok = rows.find((r) => r.basis !== "none" && (!r.expires_at || new Date(r.expires_at) > now));
  return ok ? { allowed: true, basis: ok.basis } : { allowed: false, reason: "consent_expired" };
}

/** Signed one-click unsubscribe link for one recipient of one business (served by the portal at /u/<token>). */
export function unsubscribeToken(tenantId: string, email: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ t: tenantId, e: email.trim().toLowerCase() })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): { tenantId: string; email: string } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { t?: unknown; e?: unknown };
    return typeof v.t === "string" && typeof v.e === "string" ? { tenantId: v.t, email: v.e } : null;
  } catch { return null; }
}
