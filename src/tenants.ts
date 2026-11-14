import { z } from "zod";
import type { Db } from "./shared/db.ts";
import { json, maybeOne, one } from "./shared/db.ts";
import { PermanentError } from "./shared/errors.ts";
import { hashPassword } from "./shared/passwords.ts";
import { withTenant, type TenantDb } from "./tenancy.ts";
import { tenantAudit } from "./audit.ts";
import { AGENTS, agentDef } from "./catalog/agents.ts";
import { PACK_BY_ID } from "./catalog/industries.ts";
import { billableAgents, isEntitled, planFor, PLAN_BY_ID } from "./catalog/plans.ts";
import { DEFAULT_POLICY } from "./settings.ts";
import { refreshIntelligence } from "./profile.ts";

export const INTEGRATION_PROVIDERS = [
  "conaro-marketplace", "google-calendar", "microsoft-outlook", "email", "sms", "facebook", "instagram", "linkedin", "tiktok",
  "google-business-profile", "stripe", "quickbooks", "xero", "google-analytics", "google-search-console", "meta-ads", "google-ads",
] as const;

export const NewTenantSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  industry: z.string().refine((i) => PACK_BY_ID.has(i), "unknown industry"),
  plan: z.string().refine((p) => PLAN_BY_ID.has(p as never), "unknown plan"),
  owner: z.object({ email: z.string().email(), name: z.string().min(1).max(120), password: z.string().min(12).max(200) }),
  marketplaceProviderRef: z.string().max(100).optional(),
});

/**
 * Creates an isolated workspace: tenant, owner account and membership,
 * subscription, agents (entitled operational agents enabled, approval mode),
 * default policy (all rules off), integration rows (not connected).
 */
export async function createTenant(db: Db, input: z.input<typeof NewTenantSchema>, actor = "system:signup"): Promise<{ tenantId: string; ownerId: string }> {
  const t = NewTenantSchema.parse(input);
  const email = t.owner.email.trim().toLowerCase();
  const passwordHash = await hashPassword(t.owner.password);
  return db.tx(async (tx) => {
    const tenant = await one<{ id: string }>(tx,
      "insert into bai_tenants (slug, name, industry, marketplace_provider_ref) values ($1, $2, $3, $4) returning id",
      [t.slug, t.name, t.industry, t.marketplaceProviderRef ?? null]);
    const existing = await maybeOne<{ id: string }>(tx, "select id from bai_users where email = $1", [email]);
    const user = existing ?? await one<{ id: string }>(tx,
      "insert into bai_users (email, display_name, password_hash) values ($1, $2, $3) returning id", [email, t.owner.name, passwordHash]);
    await withTenant(tx, tenant.id, async (tdb) => {
      await tdb.query("insert into bai_memberships (user_id, role) values ($1, 'owner')", [user.id]);
      await tdb.query("insert into bai_subscriptions (plan) values ($1)", [t.plan]);
      await tdb.query("insert into bai_subscription_events (event, detail, actor) values ('created', $1::text::jsonb, $2)", [json({ plan: t.plan }), actor]);
      const entitled = new Set(billableAgents(t.plan));
      for (const a of AGENTS) {
        await tdb.query("insert into bai_agents (agent_id, enabled, autonomy) values ($1, $2, 'approval')", [a.id, entitled.has(a.id)]);
      }
      await tdb.query("insert into bai_settings (policy, updated_by) values ($1::text::jsonb, $2)", [json(DEFAULT_POLICY), actor]);
      for (const p of INTEGRATION_PROVIDERS) await tdb.query("insert into bai_integrations (provider) values ($1)", [p]);
      await refreshIntelligence(tdb);
      await tenantAudit(tdb, { actor, action: "tenant.created", subjectType: "tenant", subjectId: tenant.id, detail: { plan: t.plan, industry: t.industry } });
    });
    return { tenantId: tenant.id, ownerId: user.id };
  });
}

/** Adds a person to a tenant (owner or manager only, checked by the caller's role). */
export async function addMember(db: Db, tenantId: string, input: { email: string; name: string; password: string; role: "manager" | "staff" | "accountant" | "viewer" }, actor: string): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 12) throw new PermanentError("password must be at least 12 characters");
  const hash = await hashPassword(input.password);
  return db.tx(async (tx) => {
    const user = (await maybeOne<{ id: string }>(tx, "select id from bai_users where email = $1", [email]))
      ?? await one<{ id: string }>(tx, "insert into bai_users (email, display_name, password_hash) values ($1, $2, $3) returning id", [email, input.name, hash]);
    await withTenant(tx, tenantId, async (tdb) => {
      await tdb.query("insert into bai_memberships (user_id, role) values ($1, $2) on conflict (tenant_id, user_id) do update set role = excluded.role", [user.id, input.role]);
      await tenantAudit(tdb, { actor, action: "member.added", subjectType: "user", subjectId: user.id, detail: { role: input.role } });
    });
    return user.id;
  });
}

/** Kill switch: stops all agent work and every gateway action immediately. */
export async function setPaused(tdb: TenantDb, paused: boolean, reason: string, actor: string): Promise<void> {
  await tdb.query("update bai_tenants set paused = $1, paused_at = case when $1 then now() else null end, paused_reason = $2", [paused, paused ? reason : null]);
  if (paused) await tdb.query("update bai_workflow_runs set status = 'paused' where status in ('running','retry_scheduled')");
  else await tdb.query("update bai_workflow_runs set status = 'retry_scheduled', next_attempt_at = now() where status = 'paused'");
  await tenantAudit(tdb, { actor, action: paused ? "tenant.paused" : "tenant.resumed", subjectType: "tenant", subjectId: tdb.tenantId, detail: { reason } });
}

export async function tenantInfo(tdb: TenantDb) {
  return one<{ id: string; name: string; slug: string; industry: string; status: string; paused: boolean; paused_reason: string | null; time_zone: string }>(
    tdb, "select id, name, slug, industry, status, paused, paused_reason, time_zone from bai_tenants");
}

export async function subscription(tdb: TenantDb) {
  return one<{ plan: string; status: string; addons: string[]; billing_status: string }>(tdb, "select plan, status, addons, billing_status from bai_subscriptions");
}

/** Plan change. Billing is not connected, so this records the change and its effect on entitlements only. */
export async function changePlan(tdb: TenantDb, plan: string, actor: string): Promise<{ disabled: string[] }> {
  planFor(plan);
  const sub = await subscription(tdb);
  await tdb.query("update bai_subscriptions set plan = $1, updated_at = now()", [plan]);
  await tdb.query("insert into bai_subscription_events (event, detail, actor) values ('plan_changed', $1::text::jsonb, $2)", [json({ from: sub.plan, to: plan }), actor]);
  const enabled = await tdb.query<{ agent_id: string }>("select agent_id from bai_agents where enabled");
  const disabled = enabled.map((r) => r.agent_id).filter((id) => !isEntitled(plan, sub.addons, id));
  if (disabled.length) await tdb.query("update bai_agents set enabled = false, updated_at = now() where agent_id = any($1::text[])", [disabled]);
  await tenantAudit(tdb, { actor, action: "subscription.plan_changed", subjectType: "subscription", detail: { from: sub.plan, to: plan, disabled } });
  return { disabled };
}

export async function configureAgent(tdb: TenantDb, agentId: string, change: { enabled?: boolean; autonomy?: "draft_only" | "approval" | "rules" | "autonomous" }, actor: string): Promise<void> {
  const def = agentDef(agentId);
  if (change.enabled) {
    if (def.status !== "operational") throw new PermanentError(`${def.name} is not available yet (planned for phase ${def.phase})`);
    const sub = await subscription(tdb);
    if (!isEntitled(sub.plan, sub.addons, agentId)) throw new PermanentError(`${def.name} is not included in the ${planFor(sub.plan).name} plan`);
  }
  await tdb.query(
    `update bai_agents set enabled = coalesce($2, enabled), autonomy = coalesce($3, autonomy), updated_at = now() where agent_id = $1`,
    [agentId, change.enabled ?? null, change.autonomy ?? null]);
  await tenantAudit(tdb, { actor, action: "agent.configured", subjectType: "agent", subjectId: agentId, detail: change });
}

// ---------------------------------------------------------------- services and team

export const ServiceSchema = z.object({
  name: z.string().min(2).max(120),
  category: z.string().min(2).max(80),
  description: z.string().max(2000).default(""),
  pricingUnit: z.enum(["fixed", "hourly", "per_unit"]),
  unitLabel: z.string().max(40).optional(),
  priceCents: z.number().int().min(0).nullable().optional(),
  minChargeCents: z.number().int().min(0).default(0),
  travelFeeCents: z.number().int().min(0).default(0),
  durationMinutes: z.number().int().min(5).max(24 * 60 * 14).nullable().optional(),
  requiredSkill: z.string().max(60).optional(),
  taxable: z.boolean().default(true),
  seasonalMonths: z.array(z.number().int().min(1).max(12)).default([]),
  limitations: z.string().max(1000).default(""),
});

export async function upsertService(tdb: TenantDb, input: z.input<typeof ServiceSchema>, actor: string): Promise<string> {
  const s = ServiceSchema.parse(input);
  const row = await one<{ id: string }>(tdb,
    `insert into bai_services (name, category, description, pricing_unit, unit_label, price_cents, min_charge_cents, travel_fee_cents,
       duration_minutes, required_skill, taxable, seasonal_months, limitations)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::int[],$13)
     on conflict (tenant_id, name) do update set category = excluded.category, description = excluded.description,
       pricing_unit = excluded.pricing_unit, unit_label = excluded.unit_label, price_cents = excluded.price_cents,
       min_charge_cents = excluded.min_charge_cents, travel_fee_cents = excluded.travel_fee_cents, duration_minutes = excluded.duration_minutes,
       required_skill = excluded.required_skill, taxable = excluded.taxable, seasonal_months = excluded.seasonal_months,
       limitations = excluded.limitations, updated_at = now()
     returning id`,
    [s.name, s.category, s.description, s.pricingUnit, s.unitLabel ?? null, s.priceCents ?? null, s.minChargeCents, s.travelFeeCents,
      s.durationMinutes ?? null, s.requiredSkill ?? null, s.taxable, s.seasonalMonths, s.limitations]);
  await tenantAudit(tdb, { actor, action: "service.saved", subjectType: "service", subjectId: row.id, detail: { name: s.name, priceCents: s.priceCents ?? null } });
  await refreshIntelligence(tdb);
  return row.id;
}

export const EmployeeSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  skills: z.array(z.string().max(60)).default([]),
  availability: z.partialRecord(z.enum(["1", "2", "3", "4", "5", "6", "7"]), z.tuple([z.string().regex(/^\d\d:\d\d$/), z.string().regex(/^\d\d:\d\d$/)])).default({}),
  locationConsent: z.boolean().default(false),
});

export async function addEmployee(tdb: TenantDb, input: z.input<typeof EmployeeSchema>, actor: string): Promise<string> {
  const e = EmployeeSchema.parse(input);
  const row = await one<{ id: string }>(tdb,
    "insert into bai_employees (name, email, skills, availability, location_consent) values ($1, $2, $3::text[], $4::text::jsonb, $5) returning id",
    [e.name, e.email?.toLowerCase() ?? null, e.skills, json(e.availability), e.locationConsent]);
  await tenantAudit(tdb, { actor, action: "employee.added", subjectType: "employee", subjectId: row.id });
  await refreshIntelligence(tdb);
  return row.id;
}
