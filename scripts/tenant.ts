// Creates a Business AI workspace for a business and its owner account.
//   npm run tenant -- --name "Sparkle Cleaning" --slug sparkle --industry residential-cleaning --plan growth --email owner@example.com --owner "Owner Name"
// The password is read from BAI_OWNER_PASSWORD (never from the command line, which shell history keeps).
import { parseArgs } from "node:util";
import { createContainer } from "../src/container.ts";
import { createTenant } from "../src/tenants.ts";
import { INDUSTRY_PACKS } from "../src/catalog/industries.ts";
import { PLANS } from "../src/catalog/plans.ts";

const { values } = parseArgs({ options: {
  name: { type: "string" }, slug: { type: "string" }, industry: { type: "string" }, plan: { type: "string", default: "starter" },
  email: { type: "string" }, owner: { type: "string" }, "marketplace-ref": { type: "string" },
} });
const password = process.env.BAI_OWNER_PASSWORD;
if (!values.name || !values.slug || !values.industry || !values.email || !values.owner || !password) {
  console.error("Required: --name --slug --industry --email --owner, and BAI_OWNER_PASSWORD (12+ characters) in the environment.");
  console.error(`Industries: ${INDUSTRY_PACKS.map((p) => p.id).join(", ")}`);
  console.error(`Plans: ${PLANS.map((p) => p.id).join(", ")}`);
  process.exit(1);
}
const c = await createContainer();
const r = await createTenant(c.db, { name: values.name, slug: values.slug, industry: values.industry, plan: values.plan!, owner: { email: values.email, name: values.owner, password },
  ...(values["marketplace-ref"] ? { marketplaceProviderRef: values["marketplace-ref"] } : {}) }, "system:cli");
console.log(`Created workspace ${values.slug} (${r.tenantId}). The owner can sign in to the control centre and finish onboarding.`);
await c.close();
