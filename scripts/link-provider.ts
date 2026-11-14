// Links a Business AI workspace to its marketplace provider (the provider reference the marketplace
// uses in /api/bai/v1/provider-feed). Each provider can be linked to one workspace only.
//   npm run link-provider -- --slug sparkle --provider <marketplace provider id>
import { parseArgs } from "node:util";
import { createContainer } from "../src/container.ts";
import { withTenant } from "../src/tenancy.ts";
import { tenantAudit } from "../src/audit.ts";

const { values } = parseArgs({ options: { slug: { type: "string" }, provider: { type: "string" } } });
if (!values.slug || !values.provider) { console.error("Required: --slug and --provider"); process.exit(1); }
const c = await createContainer();
const t = (await c.db.query<{ id: string }>("select id from bai_tenants where slug = $1", [values.slug]))[0];
if (!t) { console.error(`No workspace with slug ${values.slug}`); process.exit(1); }
await withTenant(c.db, t.id, async (tdb) => {
  await tdb.query("update bai_tenants set marketplace_provider_ref = $1", [values.provider]);
  await tdb.query("update bai_integrations set status = 'authorised_untested', detail = 'Linked; waiting for the first successful read of the marketplace feed.' where provider = 'conaro-marketplace'");
  await tenantAudit(tdb, { actor: "system:cli", action: "marketplace.linked", subjectType: "tenant", subjectId: t.id, detail: { provider: values.provider } });
});
console.log(`Linked ${values.slug} to marketplace provider ${values.provider}. The next cycle reads its requests and bookings.`);
await c.close();
