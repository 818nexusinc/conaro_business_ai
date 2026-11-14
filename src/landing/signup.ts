import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "../shared/db.ts";
import { maybeOne } from "../shared/db.ts";
import { sha256 } from "../shared/hash.ts";
import { PermanentError } from "../shared/errors.ts";
import { createTenant } from "../tenants.ts";
import { PACK_BY_ID } from "../catalog/industries.ts";
import { PLAN_BY_ID } from "../catalog/plans.ts";

export const MARKETING_CONSENT_WORDING =
  "Yes, CONARO may email me product news and offers about CONARO Business AI. I can unsubscribe at any time.";
export const MARKETING_CONSENT_WORDING_FR =
  "Oui, CONARO peut m'envoyer par courriel des nouvelles et des offres sur CONARO Business AI. Je peux me désabonner en tout temps.";
const MAX_PER_IP_PER_HOUR = 5;

export const SignupSchema = z.object({
  business: z.string().trim().min(2, "enter your business name").max(120),
  name: z.string().trim().min(1, "enter your name").max(120),
  email: z.string().trim().toLowerCase().email("enter a valid email address"),
  password: z.string().min(12, "use at least 12 characters for your password").max(200),
  industry: z.string().refine((i) => PACK_BY_ID.has(i), "choose your industry"),
  plan: z.string().refine((p) => PLAN_BY_ID.has(p as never), "choose a plan"),
  pilot: z.literal("yes", { message: "please confirm you understand the pilot" }),
  marketing: z.literal("yes").optional(),
  lang: z.enum(["en", "fr"]).default("en"),
});

function slugFor(business: string): string {
  const base = business.toLowerCase().normalize("NFD").replaceAll(/[̀-ͯ]/g, "").replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 40) || "business";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

/**
 * Creates a pilot workspace on the chosen plan for a new owner. Refuses an email that already has an
 * account (they sign in instead; a sign-up must never attach to someone else's identity). Rate-limited
 * per IP. Billing is not connected, so nothing is charged.
 */
export async function signUp(db: Db, form: Record<string, string | undefined>, ip: string): Promise<{ tenantId: string; userId: string }> {
  if (form.website) throw new PermanentError("sign-up refused"); // honeypot field, invisible to people
  const ipHash = sha256(`bai-signup:${ip}`);
  const recent = await db.query<{ n: number }>("select count(*)::int n from bai_signups where ip_hash = $1 and created_at > now() - interval '1 hour'", [ipHash]);
  if ((recent[0]?.n ?? 0) >= MAX_PER_IP_PER_HOUR) throw new PermanentError("Too many sign-ups from this connection. Please try again in an hour.");
  const s = SignupSchema.parse(form);
  if (await maybeOne(db, "select 1 from bai_users where email = $1", [s.email])) {
    throw new PermanentError("An account with this email already exists. Sign in instead, or use another email.");
  }
  const { tenantId, ownerId } = await createTenant(db, {
    name: s.business, slug: slugFor(s.business), industry: s.industry, plan: s.plan,
    owner: { email: s.email, name: s.name, password: s.password },
  }, "system:signup");
  await db.query(
    `insert into bai_signups (tenant_id, business_name, owner_email, plan, industry, marketing_consent, consent_wording, ip_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, s.business, s.email, s.plan, s.industry, s.marketing === "yes", s.marketing === "yes" ? (s.lang === "fr" ? MARKETING_CONSENT_WORDING_FR : MARKETING_CONSENT_WORDING) : null, ipHash]);
  return { tenantId, userId: ownerId };
}
