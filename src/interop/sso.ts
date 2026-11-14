import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../shared/db.ts";
import { maybeOne } from "../shared/db.ts";

/**
 * Sign-in handed over from the marketplace. A provider who is signed in to the marketplace clicks
 * "Open Business AI"; the marketplace redirects to /sso?t=<token> with a token it signs with the
 * shared marketplace link key:
 *   token = base64url(JSON {v:1, providerRef, email, exp, nonce}) "." base64url(HMAC-SHA256(key, "bai-sso\n" + body))
 * The token lives at most 120 seconds and works once. It only signs in a person who is ALREADY a
 * member of the workspace linked to that provider: the marketplace cannot create accounts or grant access.
 */
export const SSO_MAX_SECONDS = 120;

export function signSsoToken(secret: string, claims: { providerRef: string; email: string }, now = Date.now(), nonce = randomBytes(18).toString("base64url")): string {
  const body = Buffer.from(JSON.stringify({ v: 1, providerRef: claims.providerRef, email: claims.email.trim().toLowerCase(), exp: Math.floor(now / 1000) + SSO_MAX_SECONDS, nonce })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`bai-sso\n${body}`).digest("base64url")}`;
}

export type SsoResult = { ok: true; userId: string; tenantId: string } | { ok: false; reason: string };

export async function verifySsoToken(db: Db, secret: string | undefined, token: string, now = Date.now()): Promise<SsoResult> {
  if (!secret) return { ok: false, reason: "Sign-in from the marketplace is not set up." };
  const [body, sig] = token.split(".");
  if (!body || !sig || token.length > 2000) return { ok: false, reason: "This sign-in link is not valid." };
  const expected = createHmac("sha256", secret).update(`bai-sso\n${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "This sign-in link is not valid." };
  let c: { v?: unknown; providerRef?: unknown; email?: unknown; exp?: unknown; nonce?: unknown };
  try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, reason: "This sign-in link is not valid." }; }
  if (c.v !== 1 || typeof c.providerRef !== "string" || typeof c.email !== "string" || typeof c.exp !== "number" || typeof c.nonce !== "string") return { ok: false, reason: "This sign-in link is not valid." };
  if (c.exp < now / 1000 || c.exp > now / 1000 + SSO_MAX_SECONDS + 30) return { ok: false, reason: "This sign-in link has expired. Open Business AI again from the marketplace." };
  const fresh = await db.query("insert into bai_link_nonces (nonce) values ($1) on conflict do nothing returning nonce", [`sso:${c.nonce}`]);
  if (!fresh.length) return { ok: false, reason: "This sign-in link was already used." };
  // System lookup: the workspace linked to this provider, and an existing active member with this email.
  const m = await maybeOne<{ user_id: string; tenant_id: string }>(db,
    `select m.user_id, t.id tenant_id from bai_tenants t join bai_memberships m on m.tenant_id = t.id join bai_users u on u.id = m.user_id
     where t.marketplace_provider_ref = $1 and t.status <> 'cancelled' and u.email = $2 and u.status = 'active'`, [c.providerRef, c.email]);
  if (!m) return { ok: false, reason: "No Business AI workspace is linked to this provider for your email. Ask the workspace owner to add you." };
  return { ok: true, userId: m.user_id, tenantId: m.tenant_id };
}
