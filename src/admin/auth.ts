/**
 * Platform administrators: CONARO staff who run CONARO Business AI itself (website, plans and pricing, billing,
 * the platform's own agents). Separate from business owners: own table, own session cookie (scoped to /admin),
 * own audit log. Roles: owner (everything, including admins, pricing and billing), editor (website content),
 * viewer (read only).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../shared/db.ts";
import { json, maybeOne } from "../shared/db.ts";
import { sha256 } from "../shared/hash.ts";
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from "../shared/passwords.ts";
import { PermanentError } from "../shared/errors.ts";

export const ADMIN_COOKIE = "bai_admin";
export const ADMIN_SESSION_HOURS = 8;
const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;
const DUMMY = hashPassword(randomBytes(16).toString("hex"));

export type AdminRole = "owner" | "editor" | "viewer";
export const ADMIN_PERMISSIONS = {
  "site.edit": ["owner", "editor"],
  "site.publish": ["owner", "editor"],
  "plans.edit": ["owner"],
  "plans.publish": ["owner"],
  "billing.manage": ["owner"],
  "businesses.manage": ["owner"],
  "agents.run": ["owner", "editor"],
  "proposals.decide": ["owner"],
  "admins.manage": ["owner"],
  "view": ["owner", "editor", "viewer"],
} as const satisfies Record<string, readonly AdminRole[]>;
export type AdminPermission = keyof typeof ADMIN_PERMISSIONS;
export const adminCan = (role: AdminRole, p: AdminPermission) => (ADMIN_PERMISSIONS[p] as readonly AdminRole[]).includes(role);

export interface AdminSession { adminId: string; email: string; name: string; role: AdminRole; csrf: string }

export async function adminAudit(db: Db, a: { adminId?: string | null; actor: string; action: string; subject?: string; detail?: unknown }): Promise<void> {
  await db.query("insert into bai_admin_audit (admin_id, actor, action, subject, detail) values ($1, $2, $3, $4, $5::text::jsonb)",
    [a.adminId ?? null, a.actor, a.action, a.subject ?? null, json(a.detail ?? {})]);
}

export async function createAdmin(db: Db, input: { email: string; name: string; password: string; role: AdminRole }, actor: string): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PermanentError("Enter a valid email address.");
  if (!input.name.trim()) throw new PermanentError("Enter a name.");
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new PermanentError(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (await maybeOne(db, "select 1 from bai_platform_admins where email = $1", [email])) throw new PermanentError("An admin with this email already exists.");
  const row = await maybeOne<{ id: string }>(db, "insert into bai_platform_admins (email, display_name, password_hash, role) values ($1, $2, $3, $4) returning id",
    [email, input.name.trim().slice(0, 120), await hashPassword(input.password), input.role]);
  await adminAudit(db, { adminId: row!.id, actor, action: "admin.created", subject: email, detail: { role: input.role } });
  return row!.id;
}

export const ownerExists = async (db: Db) => Boolean(await maybeOne(db, "select 1 from bai_platform_admins where role = 'owner' and status = 'active' limit 1"));

export async function adminLogin(db: Db, emailInput: string, password: string, ip: string): Promise<{ ok: true; token: string } | { ok: false; reason: "invalid" | "rate_limited" }> {
  const email = emailInput.trim().toLowerCase().slice(0, 320);
  const key = `[admin]${email}`;
  const f = (await db.query<{ by_email: number; by_ip: number }>(
    `select count(*) filter (where email = $1)::int by_email, count(*) filter (where ip = $2 and email like '[admin]%')::int by_ip
     from bai_login_attempts where not success and attempted_at > now() - make_interval(mins => $3)`, [key, ip, WINDOW_MINUTES]))[0] ?? { by_email: 0, by_ip: 0 };
  if (f.by_email >= MAX_FAILURES || f.by_ip >= MAX_FAILURES * 2) return { ok: false, reason: "rate_limited" };
  const admin = await maybeOne<{ id: string; password_hash: string; status: string }>(db, "select id, password_hash, status from bai_platform_admins where email = $1", [email]);
  const valid = admin ? await verifyPassword(password, admin.password_hash) : (await verifyPassword(password, await DUMMY), false);
  const success = Boolean(admin && valid && admin.status === "active");
  await db.query("insert into bai_login_attempts (email, ip, success) values ($1, $2, $3)", [key, ip, success]);
  if (!success || !admin) return { ok: false, reason: "invalid" };
  const token = randomBytes(32).toString("base64url");
  await db.query("insert into bai_admin_sessions (token_hash, admin_id, csrf_token, expires_at) values ($1, $2, $3, now() + make_interval(hours => $4))",
    [sha256(token), admin.id, randomBytes(24).toString("base64url"), ADMIN_SESSION_HOURS]);
  await adminAudit(db, { adminId: admin.id, actor: `admin:${admin.id}`, action: "admin.signed_in", detail: { ip } });
  return { ok: true, token };
}

export async function adminSession(db: Db, token: string | undefined): Promise<AdminSession | null> {
  if (!token || token.length > 200) return null;
  const s = await maybeOne<{ admin_id: string; csrf_token: string; email: string; display_name: string; role: AdminRole; status: string }>(db,
    `select s.admin_id, s.csrf_token, a.email, a.display_name, a.role, a.status from bai_admin_sessions s join bai_platform_admins a on a.id = s.admin_id
     where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
  if (!s || s.status !== "active") return null;
  return { adminId: s.admin_id, email: s.email, name: s.display_name, role: s.role, csrf: s.csrf_token };
}

export async function adminLogout(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query("delete from bai_admin_sessions where token_hash = $1", [sha256(token)]);
}

export function adminCsrfOk(session: AdminSession, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(session.csrf); const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
