/**
 * Plan names, monthly prices (CAD, before tax) and feature lists, managed by platform owners.
 * The catalogue in src/catalog/plans.ts stays the source of which agents each plan includes; this adds what the
 * business decides commercially. Drafts until published; history kept.
 */
import { z } from "zod";
import type { Db } from "../shared/db.ts";
import { json, maybeOne } from "../shared/db.ts";
import { PermanentError } from "../shared/errors.ts";
import { PLANS } from "../catalog/plans.ts";
import { PLAN_FEATURES_FR, PLAN_NAME_FR } from "../landing/copy.ts";
import { adminAudit, type AdminSession } from "./auth.ts";

export const PlanSettingsSchema = z.object({
  priceCents: z.number().int().min(0).max(10_000_000).nullable(),
  name: z.object({ en: z.string().trim().min(1).max(40), fr: z.string().trim().min(1).max(40) }),
  features: z.object({ en: z.array(z.string().trim().min(1).max(80)).max(8), fr: z.array(z.string().trim().min(1).max(80)).max(8) }),
  recommended: z.boolean().default(false),
  /** Stripe test-mode Price id for this plan (set in Billing). */
  stripePriceId: z.string().regex(/^price_[A-Za-z0-9]{6,80}$/).nullable().default(null),
});
export type PlanSettings = z.infer<typeof PlanSettingsSchema>;
export type PlanId = (typeof PLANS)[number]["id"];

/** The built-in values (what the site shows before anything is published). */
export function defaultPlanSettings(id: string): PlanSettings {
  const p = PLANS.find((x) => x.id === id);
  if (!p) throw new PermanentError(`Unknown plan: ${id}`);
  return { priceCents: p.priceCents, name: { en: p.name, fr: PLAN_NAME_FR[p.id] ?? p.name }, features: { en: [...p.features], fr: [...(PLAN_FEATURES_FR[p.id] ?? p.features)] },
    recommended: p.id === "growth", stripePriceId: null };
}

let cache: { at: number; map: Record<string, PlanSettings> } | null = null;
export function clearPlanCache(): void { cache = null; }

/** Published settings for every plan (defaults where nothing is published). */
export async function publishedPlans(db: Db): Promise<Record<string, PlanSettings>> {
  if (cache && Date.now() - cache.at < 15_000) return cache.map;
  const rows = await db.query<{ plan_id: string; published: unknown }>("select plan_id, published from bai_plan_settings where published is not null");
  const map: Record<string, PlanSettings> = {};
  for (const p of PLANS) {
    const row = rows.find((r) => r.plan_id === p.id);
    const parsed = row ? PlanSettingsSchema.safeParse(row.published) : null;
    map[p.id] = parsed?.success ? parsed.data : defaultPlanSettings(p.id);
  }
  cache = { at: Date.now(), map };
  return map;
}

export async function planRows(db: Db): Promise<{ id: string; draft: PlanSettings; published: PlanSettings; changed: boolean; publishedAt: string | null }[]> {
  const rows = await db.query<{ plan_id: string; draft: unknown; published: unknown; draft_changed: boolean; published_at: string | null }>("select plan_id, draft, published, draft_changed, published_at from bai_plan_settings");
  return PLANS.map((p) => {
    const r = rows.find((x) => x.plan_id === p.id);
    const pub = r?.published ? PlanSettingsSchema.parse(r.published) : defaultPlanSettings(p.id);
    const draft = r?.draft_changed && r.draft ? PlanSettingsSchema.parse(r.draft) : pub;
    return { id: p.id, draft, published: pub, changed: Boolean(r?.draft_changed), publishedAt: r?.published_at ?? null };
  });
}

/** Reads the admin form: price in dollars (blank = not announced), names, features one per line. */
export function settingsFromForm(f: URLSearchParams, current: PlanSettings): PlanSettings {
  const priceText = (f.get("price") ?? "").replace(/[$\s,]/g, "");
  let priceCents: number | null = null;
  if (priceText !== "") {
    const n = Number(priceText);
    if (!Number.isFinite(n) || n < 0) throw new PermanentError("The price must be a number of dollars, or left blank.");
    priceCents = Math.round(n * 100);
  }
  const lines = (v: string | null) => (v ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const parsed = PlanSettingsSchema.safeParse({
    priceCents, name: { en: f.get("name_en") ?? "", fr: f.get("name_fr") ?? "" },
    features: { en: lines(f.get("features_en")), fr: lines(f.get("features_fr")) },
    recommended: f.get("recommended") === "yes", stripePriceId: current.stripePriceId,
  });
  if (!parsed.success) throw new PermanentError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

export async function savePlanDraft(db: Db, admin: AdminSession, id: string, s: PlanSettings): Promise<void> {
  if (!PLANS.some((p) => p.id === id)) throw new PermanentError(`Unknown plan: ${id}`);
  const v = PlanSettingsSchema.parse(s);
  await db.query(`insert into bai_plan_settings (plan_id, draft, draft_changed, updated_by, updated_at) values ($1, $2::text::jsonb, true, $3, now())
    on conflict (plan_id) do update set draft = excluded.draft, draft_changed = true, updated_by = excluded.updated_by, updated_at = now()`, [id, json(v), admin.adminId]);
  await db.query("insert into bai_plan_settings_history (plan_id, value, action, admin_id) values ($1, $2::text::jsonb, 'save', $3)", [id, json(v), admin.adminId]);
}

/** Only one plan may be marked "recommended" on the website. */
export async function publishPlans(db: Db, admin: AdminSession): Promise<number> {
  const rows = await db.query<{ plan_id: string; draft: unknown }>(
    "update bai_plan_settings set published = draft, draft_changed = false, published_at = now(), updated_by = $1 where draft_changed returning plan_id, draft", [admin.adminId]);
  for (const r of rows) await db.query("insert into bai_plan_settings_history (plan_id, value, action, admin_id) values ($1, $2::text::jsonb, 'publish', $3)", [r.plan_id, json(r.draft), admin.adminId]);
  await adminAudit(db, { adminId: admin.adminId, actor: `admin:${admin.adminId}`, action: "plans.published", detail: { plans: rows.map((r) => ({ id: r.plan_id, value: r.draft })) } });
  clearPlanCache();
  return rows.length;
}

export async function setStripePrice(db: Db, admin: AdminSession, id: string, priceId: string | null): Promise<void> {
  const row = (await planRows(db)).find((r) => r.id === id);
  if (!row) throw new PermanentError(`Unknown plan: ${id}`);
  // The Stripe price is operational wiring, not marketing copy: it applies to both draft and published values at once.
  const apply = (s: PlanSettings) => PlanSettingsSchema.parse({ ...s, stripePriceId: priceId });
  const existing = await maybeOne<{ plan_id: string }>(db, "select plan_id from bai_plan_settings where plan_id = $1", [id]);
  if (existing) await db.query("update bai_plan_settings set draft = $2::text::jsonb, published = $3::text::jsonb, updated_by = $4, updated_at = now() where plan_id = $1",
    [id, json(apply(row.draft)), json(apply(row.published)), admin.adminId]);
  else await db.query("insert into bai_plan_settings (plan_id, draft, published, draft_changed, updated_by, published_at) values ($1, $2::text::jsonb, $2::text::jsonb, false, $3, now())",
    [id, json(apply(row.published)), admin.adminId]);
  await adminAudit(db, { adminId: admin.adminId, actor: `admin:${admin.adminId}`, action: "plans.stripe_price_set", subject: id, detail: { priceId } });
  clearPlanCache();
}

export const planHistory = (db: Db) => db.query<{ plan_id: string; value: PlanSettings; action: string; occurred_at: string; who: string | null }>(
  "select h.plan_id, h.value, h.action, h.occurred_at, a.display_name who from bai_plan_settings_history h left join bai_platform_admins a on a.id = h.admin_id order by h.id desc limit 60");
