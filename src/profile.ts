import { z } from "zod";
import { json, maybeOne } from "./shared/db.ts";
import type { TenantDb } from "./tenancy.ts";
import { tenantAudit } from "./audit.ts";
import { industryPack, type IndustryPack } from "./catalog/industries.ts";
import { taxRateFor, TAX_SOURCE } from "./catalog/tax.ts";

const cents = z.number().int().min(0);
const HOURS = z.partialRecord(z.enum(["1", "2", "3", "4", "5", "6", "7"]), z.tuple([z.string().regex(/^\d\d:\d\d$/), z.string().regex(/^\d\d:\d\d$/)]));

/** Onboarding data (brief §3). Every section is optional so onboarding can be done in steps. */
export const ProfileSchema = z.object({
  identity: z.object({
    description: z.string().max(2000).optional(),
    structure: z.enum(["sole_proprietor", "partnership", "corporation", "other"]).optional(),
    address: z.string().max(300).optional(),
    mailingAddress: z.string().max(300).optional(),
    province: z.string().length(2).optional(),
    serviceAreas: z.array(z.string().max(80)).max(50).optional(),
    website: z.string().url().optional(),
    social: z.record(z.string(), z.string().url()).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(40).optional(),
    hours: HOURS.optional(),
    employees: z.number().int().min(0).max(10000).optional(),
    languages: z.array(z.enum(["en-CA", "fr-CA"])).optional(),
  }).default({}),
  objectives: z.object({
    monthlyRevenueTargetCents: cents.optional(),
    annualRevenueTargetCents: cents.optional(),
    targetMarginPct: z.number().min(0).max(100).optional(),
    newCustomersPerMonth: z.number().int().min(0).optional(),
    preferredCustomers: z.string().max(500).optional(),
    preferredAreas: z.array(z.string()).optional(),
    growthPriorities: z.array(z.string().max(200)).max(10).optional(),
    monthlyMarketingBudgetCents: cents.optional(),
    constraints: z.string().max(1000).optional(),
  }).default({}),
  operations: z.object({
    bookingLeadTimeHours: z.number().int().min(0).optional(),
    paymentMethods: z.array(z.string()).optional(),
    cancellationPolicy: z.string().max(2000).optional(),
    quoteRequirements: z.string().max(1000).optional(),
    equipment: z.array(z.string()).optional(),
    subcontractors: z.boolean().optional(),
  }).default({}),
  financial: z.object({
    currency: z.literal("CAD").default("CAD"),
    gstHstRegistered: z.boolean().optional(),
    gstHstNumberOnFile: z.boolean().optional(),
    filingFrequency: z.enum(["monthly", "quarterly", "annual"]).optional(),
    fiscalYearEnd: z.string().regex(/^\d\d-\d\d$/).optional(),
    accountingSoftware: z.string().max(80).optional(),
    expenseCategories: z.array(z.string().max(60)).optional(),
  }).default({ currency: "CAD" }),
});
export type ProfileData = z.infer<typeof ProfileSchema>;

const REQUIRED: [string, (p: ProfileData) => unknown][] = [
  ["Business description", (p) => p.identity.description],
  ["Province (tax jurisdiction)", (p) => p.identity.province],
  ["Service areas", (p) => p.identity.serviceAreas?.length],
  ["Business hours", (p) => p.identity.hours && Object.keys(p.identity.hours).length],
  ["Contact email or phone", (p) => p.identity.email ?? p.identity.phone],
  ["Mailing address (required in marketing messages)", (p) => p.identity.mailingAddress],
  ["Monthly revenue target", (p) => p.objectives.monthlyRevenueTargetCents],
  ["Growth priorities", (p) => p.objectives.growthPriorities?.length],
  ["Cancellation policy", (p) => p.operations.cancellationPolicy],
  ["Payment methods", (p) => p.operations.paymentMethods?.length],
  ["GST/HST registration status", (p) => p.financial.gstHstRegistered !== undefined],
];

export function missingItems(p: ProfileData, servicesCount: number, employeesCount: number): string[] {
  const missing = REQUIRED.filter(([, get]) => !get(p)).map(([label]) => label);
  if (servicesCount === 0) missing.push("At least one service with pricing");
  if (employeesCount === 0) missing.push("At least one person who does the work (employee or owner)");
  return missing;
}

export interface IntelligenceProfile {
  generatedAt: string;
  businessName: string;
  industry: { id: string; name: string };
  summary: string;
  tax: { label: string; bp: number; note?: string; source: string };
  services: { name: string; pricing: string; durationMinutes: number | null; inSeasonNow: boolean }[];
  team: { people: number; skills: string[] };
  objectives: ProfileData["objectives"];
  operatingRules: { pack: Pick<IndustryPack, "workflows" | "safety" | "regulatory" | "bookingFields" | "kpis"> };
  gaps: string[];
}

/** Saves the profile (versioned, append-only history) and rebuilds the Business Intelligence Profile. */
export async function saveProfile(tdb: TenantDb, input: unknown, actor: string): Promise<{ version: number; completeness: number; missing: string[] }> {
  const prev = await maybeOne<{ data: unknown; version: number }>(tdb, "select data, version from bai_profiles");
  const merged = mergeDeep((prev?.data ?? {}) as Record<string, unknown>, input as Record<string, unknown>);
  const data = ProfileSchema.parse(merged);
  const version = (prev?.version ?? 0) + 1;
  const bip = await buildIntelligenceProfile(tdb, data);
  const total = REQUIRED.length + 2;
  const completeness = Math.round(((total - bip.gaps.length) / total) * 100);
  await tdb.query(
    `insert into bai_profiles (version, data, intelligence, completeness, updated_by) values ($1, $2::text::jsonb, $3::text::jsonb, $4, $5)
     on conflict (tenant_id) do update set version = excluded.version, data = excluded.data, intelligence = excluded.intelligence,
       completeness = excluded.completeness, updated_by = excluded.updated_by, updated_at = now()`,
    [version, json(data), json(bip), completeness, actor],
  );
  await tdb.query("insert into bai_profile_versions (version, data, created_by) values ($1, $2::text::jsonb, $3)", [version, json(data), actor]);
  await tenantAudit(tdb, { actor, action: "profile.saved", subjectType: "profile", subjectId: String(version), detail: { completeness } });
  return { version, completeness, missing: bip.gaps };
}

/** Rebuilds the BIP after services or employees change. */
export async function refreshIntelligence(tdb: TenantDb): Promise<IntelligenceProfile> {
  const data = await getProfileData(tdb);
  const bip = await buildIntelligenceProfile(tdb, data);
  const total = REQUIRED.length + 2;
  await tdb.query(
    `insert into bai_profiles (data, intelligence, completeness, updated_by) values ($1::text::jsonb, $2::text::jsonb, $3, 'system:intelligence')
     on conflict (tenant_id) do update set intelligence = excluded.intelligence, completeness = excluded.completeness, updated_at = now()`,
    [json(data), json(bip), Math.round(((total - bip.gaps.length) / total) * 100)],
  );
  return bip;
}

export async function getProfileData(tdb: TenantDb): Promise<ProfileData> {
  const row = await maybeOne<{ data: unknown }>(tdb, "select data from bai_profiles");
  return ProfileSchema.parse(row?.data ?? {});
}

export async function getIntelligence(tdb: TenantDb): Promise<IntelligenceProfile> {
  const row = await maybeOne<{ intelligence: IntelligenceProfile }>(tdb, "select intelligence from bai_profiles");
  if (row?.intelligence && "generatedAt" in row.intelligence) return row.intelligence;
  return refreshIntelligence(tdb);
}

async function buildIntelligenceProfile(tdb: TenantDb, p: ProfileData): Promise<IntelligenceProfile> {
  const tenant = (await tdb.query<{ name: string; industry: string }>("select name, industry from bai_tenants"))[0];
  if (!tenant) throw new Error("tenant not visible");
  const pack = industryPack(tenant.industry);
  const services = await tdb.query<{ name: string; pricing_unit: string; unit_label: string | null; price_cents: number | null; duration_minutes: number | null; seasonal_months: number[] }>(
    "select name, pricing_unit, unit_label, price_cents, duration_minutes, seasonal_months from bai_services where active order by name");
  const team = await tdb.query<{ skills: string[] }>("select skills from bai_employees where active");
  const month = new Date().getUTCMonth() + 1;
  const tax = taxRateFor(p.identity.province, p.financial.gstHstRegistered === true);
  const gaps = missingItems(p, services.length, team.length);
  const unpriced = services.filter((s) => s.price_cents === null).map((s) => `Price not set for "${s.name}" (quotes cannot be prepared)`);
  return {
    generatedAt: new Date().toISOString(),
    businessName: tenant.name,
    industry: { id: pack.id, name: pack.name },
    summary: p.identity.description ?? "(no description yet)",
    tax: { label: tax.label, bp: tax.bp, ...(tax.note ? { note: tax.note } : {}), source: TAX_SOURCE.rates },
    services: services.map((s) => ({
      name: s.name,
      pricing: s.price_cents === null ? "price not set" : `${(s.price_cents / 100).toFixed(2)} CAD ${s.pricing_unit === "fixed" ? "fixed" : `per ${s.unit_label ?? (s.pricing_unit === "hourly" ? "hour" : "unit")}`}`,
      durationMinutes: s.duration_minutes,
      inSeasonNow: s.seasonal_months.length === 0 || s.seasonal_months.includes(month),
    })),
    team: { people: team.length, skills: [...new Set(team.flatMap((t) => t.skills))].sort() },
    objectives: p.objectives,
    operatingRules: { pack: { workflows: pack.workflows, safety: pack.safety, regulatory: pack.regulatory, bookingFields: pack.bookingFields, kpis: pack.kpis } },
    gaps: [...gaps, ...unpriced],
  };
}

function mergeDeep(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)
      ? mergeDeep(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}
