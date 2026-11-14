import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../shared/db.ts";
import { maybeOne } from "../shared/db.ts";
import { sha256 } from "../shared/hash.ts";
import { hashPassword, verifyPassword } from "../shared/passwords.ts";
import { withTenant } from "../tenancy.ts";
import { tenantAudit } from "../audit.ts";

export const SESSION_HOURS = 12;
const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;
const DUMMY = hashPassword(randomBytes(16).toString("hex"));

export type Role = "owner" | "manager" | "staff" | "accountant" | "viewer";

/** What each role may do in the control centre. Checked on every request, server side. */
export const PERMISSIONS = {
  "approvals.decide": ["owner", "manager"],
  "agents.configure": ["owner"],
  "policy.edit": ["owner"],
  "pause": ["owner", "manager"],
  "resume": ["owner"],
  "plan.change": ["owner"],
  "profile.edit": ["owner", "manager"],
  "members.add": ["owner"],
  "enquiry.add": ["owner", "manager", "staff"],
  "quote.accept": ["owner", "manager"],
  "job.complete": ["owner", "manager", "staff"],
  "customers.view": ["owner", "manager", "staff"],
  "finance.view": ["owner", "manager", "accountant"],
  "finance.edit": ["owner", "accountant"],
  "payment.record": ["owner", "manager", "accountant"],
  "documents": ["owner", "manager"],
  "chat": ["owner", "manager"],
  "recommendations.decide": ["owner", "manager"],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, p: Permission): boolean {
  return (PERMISSIONS[p] as readonly Role[]).includes(role);
}

export interface PortalSession { userId: string; tenantId: string; email: string; name: string; role: Role; csrf: string }

export async function portalLogin(db: Db, emailInput: string, password: string, ip: string): Promise<{ ok: true; token: string } | { ok: false; reason: "invalid" | "rate_limited" }> {
  const email = emailInput.trim().toLowerCase().slice(0, 320);
  const f = (await db.query<{ by_email: number; by_ip: number }>(
    `select count(*) filter (where email = $1)::int by_email, count(*) filter (where ip = $2)::int by_ip
     from bai_login_attempts where not success and attempted_at > now() - make_interval(mins => $3)`, [email, ip, WINDOW_MINUTES]))[0] ?? { by_email: 0, by_ip: 0 };
  if (f.by_email >= MAX_FAILURES || f.by_ip >= MAX_FAILURES * 4) return { ok: false, reason: "rate_limited" };
  const user = await maybeOne<{ id: string; password_hash: string; status: string }>(db, "select id, password_hash, status from bai_users where email = $1", [email]);
  const valid = user ? await verifyPassword(password, user.password_hash) : (await verifyPassword(password, await DUMMY), false);
  // The first active workspace the person belongs to (system lookup; tenant pages re-check membership).
  const membership = user && valid && user.status === "active"
    ? await maybeOne<{ tenant_id: string }>(db, `select m.tenant_id from bai_memberships m join bai_tenants t on t.id = m.tenant_id
        where m.user_id = $1 and t.status <> 'cancelled' order by m.created_at limit 1`, [user.id]) : null;
  const success = Boolean(membership);
  await db.query("insert into bai_login_attempts (email, ip, success) values ($1, $2, $3)", [email, ip, success]);
  if (!success || !user || !membership) return { ok: false, reason: "invalid" };
  return { ok: true, token: await createSession(db, user.id, membership.tenant_id, { ip, via: "password" }) };
}

/** Opens a session for a member of one workspace (password sign-in or the marketplace hand-over). */
export async function createSession(db: Db, userId: string, tenantId: string, detail: { ip: string; via: "password" | "marketplace" }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query("insert into bai_sessions (token_hash, user_id, tenant_id, csrf_token, expires_at) values ($1, $2, $3, $4, now() + make_interval(hours => $5))",
    [sha256(token), userId, tenantId, randomBytes(24).toString("base64url"), SESSION_HOURS]);
  await withTenant(db, tenantId, (tdb) => tenantAudit(tdb, { actor: `user:${userId}`, action: "user.signed_in", subjectType: "user", subjectId: userId, detail }));
  return token;
}

/** Resolves the session and re-reads the person's role in that workspace (a removed member loses access at once). */
export async function portalSession(db: Db, token: string | undefined): Promise<PortalSession | null> {
  if (!token || token.length > 200) return null;
  const s = await maybeOne<{ user_id: string; tenant_id: string; csrf_token: string; email: string; display_name: string; status: string }>(db,
    `select s.user_id, s.tenant_id, s.csrf_token, u.email, u.display_name, u.status from bai_sessions s join bai_users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
  if (!s || s.status !== "active") return null;
  const role = await withTenant(db, s.tenant_id, (tdb) => maybeOne<{ role: Role }>(tdb, "select role from bai_memberships where user_id = $1", [s.user_id]));
  if (!role) return null;
  return { userId: s.user_id, tenantId: s.tenant_id, email: s.email, name: s.display_name, role: role.role, csrf: s.csrf_token };
}

export async function portalLogout(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query("delete from bai_sessions where token_hash = $1", [sha256(token)]);
}

export function csrfOk(session: PortalSession, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(session.csrf);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
