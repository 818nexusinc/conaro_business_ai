// End-to-end demonstration of CONARO Business AI on an in-memory database with
// SYNTHETIC data. Nothing leaves the machine: every external action is simulated.
//   npm run demo            # print the run
//   npm run demo -- --serve # then open the control centre at http://localhost:8790
//                                 (owner@demo.example.test / demo-password-123)
import { createPgliteDb } from "../src/shared/db.ts";
import { migrate } from "../src/shared/migrate.ts";
import { SimulatedReasoning } from "../src/shared/reasoning.ts";
import { createBusinessAi } from "../src/index.ts";
import { withTenant } from "../src/tenancy.ts";
import { addEmployee, configureAgent, createTenant, upsertService } from "../src/tenants.ts";
import { saveProfile } from "../src/profile.ts";
import { updatePolicy } from "../src/settings.ts";
import { receiveEnquiry } from "../src/tools/revenue.ts";
import { acceptQuote } from "../src/effects.ts";
import { runTool } from "../src/tools/index.ts";
import { processTenant } from "../src/workflows.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { addDays, localParts, zonedTime } from "../src/time.ts";

const db = await createPgliteDb();
await migrate(db);
const secret = "demo-link-secret-not-for-production-000";
const app = createBusinessAi({ reasoning: new SimulatedReasoning(), publicBaseUrl: "http://localhost:8790", linkSecret: secret });
const say = (s: string) => console.log(`\n▶ ${s}`);

say("Onboarding a synthetic residential cleaning business (Professional plan)");
const { tenantId } = await createTenant(db, { name: "Demo Cleaning Co", slug: "demo", industry: "residential-cleaning", plan: "professional",
  owner: { email: "owner@demo.example.test", name: "Demo Owner", password: "demo-password-123" } });
const week = { "1": ["08:00", "17:00"], "2": ["08:00", "17:00"], "3": ["08:00", "17:00"], "4": ["08:00", "17:00"], "5": ["08:00", "17:00"] } as Record<"1", [string, string]>;
await withTenant(db, tenantId, async (t) => {
  const p = await saveProfile(t, {
    identity: { description: "Residential cleaning for homes in Greater Moncton: weekly, biweekly and move-out cleans, with our own supplies.", province: "NB",
      serviceAreas: ["Moncton", "Dieppe", "Riverview"], hours: week, email: "hello@demo.example.test", mailingAddress: "100 Example Street, Moncton, NB E1C 0A0" },
    objectives: { monthlyRevenueTargetCents: 800_000, growthPriorities: ["More recurring clients"] },
    operations: { cancellationPolicy: "Free cancellation up to 24 hours before.", paymentMethods: ["e-transfer", "card"], bookingLeadTimeHours: 12 },
    financial: { gstHstRegistered: true },
  }, "demo");
  console.log(`  profile ${p.completeness}% complete; missing: ${p.missing.join("; ") || "nothing"}`);
  await upsertService(t, { name: "Standard clean", category: "house cleaning", description: "Kitchen, bathrooms, dusting, floors and vacuuming throughout the home.", pricingUnit: "fixed", priceCents: 15_000, durationMinutes: 180, requiredSkill: "cleaning" }, "demo");
  await upsertService(t, { name: "Deep clean", category: "house cleaning", description: "Everything in a standard clean plus inside appliances, baseboards and cabinets.", pricingUnit: "hourly", priceCents: 5_500, durationMinutes: 300, requiredSkill: "cleaning" }, "demo");
  await addEmployee(t, { name: "Alex", skills: ["cleaning"], availability: week }, "demo");
  await addEmployee(t, { name: "Sam", skills: ["cleaning"], availability: week }, "demo");
  await updatePolicy(t, { auto_send_quotes: true, max_auto_quote_cents: 50_000, auto_confirm_bookings: true, auto_issue_invoices: true, auto_feedback_requests: true }, "demo");
  for (const a of ["sales", "quotation", "booking", "customer-service", "crm", "invoicing", "reputation", "workforce", "operations"]) await configureAgent(t, a, { autonomy: "rules" }, "demo");
});

say("A customer submits a service request on the business's website");
const { leadId, ref } = await withTenant(db, tenantId, (t) => receiveEnquiry(t, { name: "Jordan Example", email: "jordan@example.test",
  description: "Hi! Could you do a standard clean of our 3-bedroom house in Dieppe? Weekday mornings work best.", area: "Dieppe", channel: "website" }, "demo"));
console.log(`  enquiry ${ref}`);
const r1 = await processTenant(db, tenantId, app.deps);
console.log(`  cycle: ${JSON.stringify(r1.runs)}`);

const quote = await withTenant(db, tenantId, async (t) => (await t.query<{ id: string; ref: string; status: string; total_cents: number }>("select id, ref, status, total_cents from bai_quotes where lead_id = $1", [leadId]))[0]!);
console.log(`  quote ${quote.ref}: $${(quote.total_cents / 100).toFixed(2)} incl. HST, ${quote.status} (simulated email)`);

say("The customer accepts and picks the next weekday at 09:00");
const today = localParts(new Date(), "America/Moncton").date;
let day = addDays(today, 1);
while ([6, 7].includes(localParts(zonedTime(day, "12:00", "America/Moncton"), "America/Moncton").weekday)) day = addDays(day, 1);
await withTenant(db, tenantId, (t) => acceptQuote(t, quote.id, zonedTime(day, "09:00", "America/Moncton").toISOString(), "customer:demo"));
await processTenant(db, tenantId, app.deps);
const booking = await withTenant(db, tenantId, async (t) => (await t.query<{ ref: string; status: string; who: string }>("select b.ref, b.status, e.name who from bai_bookings b left join bai_employees e on e.id = b.employee_id"))[0]!);
console.log(`  booking ${booking.ref}: ${booking.status}, assigned to ${booking.who}`);

say("The job is done; the business marks it complete");
await withTenant(db, tenantId, async (t) => {
  const job = (await t.query<{ id: string }>("select id from bai_jobs"))[0]!;
  await runTool(t, app.deps, "jobs.complete", { jobId: job.id, reportedBy: "user:demo" });
});
await processTenant(db, tenantId, app.deps);
await withTenant(db, tenantId, async (t) => {
  const inv = (await t.query<{ ref: string; status: string; total_cents: number }>("select ref, status, total_cents from bai_invoices"))[0]!;
  console.log(`  invoice ${inv.ref}: $${(inv.total_cents / 100).toFixed(2)}, ${inv.status}`);
  const msgs = await t.query<{ channel: string; body: string }>("select channel, body from bai_messages where direction = 'outbound' order by created_at");
  say(`Messages the agents would have sent (${msgs.length}, all SIMULATED)`);
  for (const m of msgs) console.log(`  [${m.channel}] ${m.body.split("\n")[0]!.slice(0, 110)}…`);
  const actions = await t.query<{ agent_id: string; action_type: string; status: string }>("select agent_id, action_type, status from bai_actions order by created_at");
  say(`Agent actions (${actions.length})`);
  for (const a of actions) console.log(`  ${a.agent_id.padEnd(18)} ${a.action_type.padEnd(28)} ${a.status}`);
  const summary = await runTool(t, app.deps, "manager.daily_summary", { date: today });
  say("Daily executive summary (today, for the demo)");
  console.log(JSON.stringify((summary as { output: unknown }).output, null, 2).split("\n").slice(0, 40).join("\n"));
});

if (process.argv.includes("--serve")) {
  createPortalServer({ db, app, linkSecret: secret }).listen(8790, "127.0.0.1", () =>
    console.log("\nControl centre: http://localhost:8790  (owner@demo.example.test / demo-password-123). Ctrl+C to stop."));
} else {
  await db.close();
}
