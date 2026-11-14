import { randomBytes } from "node:crypto";
import { createPgliteDb, createPostgresDb, type Db } from "../src/shared/db.ts";
import { migrate } from "../src/shared/migrate.ts";
import { SimulatedReasoning, type ReasoningPort } from "../src/shared/reasoning.ts";
import { createBusinessAi, type BusinessAi } from "../src/index.ts";
import { withTenant } from "../src/tenancy.ts";
import { addEmployee, configureAgent, createTenant, upsertService } from "../src/tenants.ts";
import { saveProfile } from "../src/profile.ts";
import { updatePolicy, type Policy } from "../src/settings.ts";

/**
 * A fresh, migrated database per test. PGlite by default; with TEST_DATABASE_URL (a PostgreSQL server
 * where the user may create databases and roles) each test gets its own real database through postgres.js.
 */
export async function freshDb(): Promise<Db> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) {
    const db = await createPgliteDb();
    await migrate(db);
    return db;
  }
  const name = `bai_test_${randomBytes(6).toString("hex")}`;
  const root = await createPostgresDb(admin);
  await root.exec(`create database ${name}`);
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const db = await createPostgresDb(url.toString());
  await migrate(db);
  const close = db.close.bind(db);
  db.close = async () => { await close(); await root.exec(`drop database if exists ${name} with (force)`); await root.close(); };
  return db;
}

export const SECRET = "test-link-secret-0123456789abcdef0123";

export function bai(now: Date, reasoning: ReasoningPort = new SimulatedReasoning()): BusinessAi {
  return createBusinessAi({ reasoning, publicBaseUrl: "https://bai.example.test", linkSecret: SECRET, now: () => now });
}

const WEEKDAYS: Partial<Record<"1" | "2" | "3" | "4" | "5" | "6" | "7", [string, string]>> = { "1": ["08:00", "17:00"], "2": ["08:00", "17:00"], "3": ["08:00", "17:00"], "4": ["08:00", "17:00"], "5": ["08:00", "17:00"] };

/** A configured residential cleaning business in Moncton (synthetic data only). */
export async function seedBusiness(db: Db, slug: string, opts: { plan?: string; policy?: Partial<Policy>; autonomy?: "approval" | "rules" | "autonomous" } = {}) {
  const { tenantId, ownerId } = await createTenant(db, {
    name: `Sparkle ${slug}`, slug, industry: "residential-cleaning", plan: opts.plan ?? "premium",
    owner: { email: `owner@${slug}.example.test`, name: "Owner", password: "correct horse battery staple" },
  });
  const ids = await withTenant(db, tenantId, async (tdb) => {
    await saveProfile(tdb, {
      identity: { description: "Residential cleaning for homes in Greater Moncton: weekly, biweekly and move-out cleans.", province: "NB", serviceAreas: ["Moncton", "Dieppe"],
        hours: WEEKDAYS, email: `hello@${slug}.example.test`, mailingAddress: "123 Main Street, Moncton, NB E1C 0A1" },
      objectives: { monthlyRevenueTargetCents: 1_000_000, growthPriorities: ["More recurring clients"] },
      operations: { cancellationPolicy: "Free cancellation up to 24 hours before.", paymentMethods: ["e-transfer"] },
      financial: { gstHstRegistered: true },
    }, "test");
    const serviceId = await upsertService(tdb, { name: "Standard clean", category: "house cleaning", description: "Kitchen, bathrooms, dusting, floors and vacuuming throughout the home.", pricingUnit: "fixed", priceCents: 15_000, durationMinutes: 180 }, "test");
    const employeeId = await addEmployee(tdb, { name: "Alex", skills: ["cleaning"], availability: WEEKDAYS }, "test");
    if (opts.policy) await updatePolicy(tdb, opts.policy, "test");
    if (opts.autonomy) {
      for (const a of ["sales", "quotation", "booking", "customer-service", "crm", "invoicing", "reputation", "workforce", "operations"]) {
        await configureAgent(tdb, a, { autonomy: opts.autonomy }, "test");
      }
    }
    return { serviceId, employeeId };
  });
  return { tenantId, ownerId, ...ids };
}
