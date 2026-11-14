import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Db } from "../src/shared/db.ts";
import { createPgliteDb } from "../src/shared/db.ts";
import { migrate } from "../src/shared/migrate.ts";
import { freshDb, bai, seedBusiness, SECRET } from "./fixtures.ts";
import { emailHash, linkSignature, signLinkRequest, verifyLinkRequest } from "../src/interop/protocol.ts";
import { MarketplaceFeedClient, syncMarketplace, type ProviderFeed } from "../src/interop/marketplace.ts";
import { signSsoToken } from "../src/interop/sso.ts";
import { withTenant } from "../src/tenancy.ts";
import { processTenant, businessAiCycle } from "../src/workflows.ts";
import { createPortalServer } from "../src/portal/server.ts";

const MK = "marketplace-link-key-0123456789abcdef-test";
const BOS = "bos-link-key-0123456789abcdef-test-0000";
const NOW = new Date("2026-11-18T14:00:00Z");

describe("link protocol (shared with the marketplace and the operating system)", () => {
  it("matches the vector both other applications test", () => {
    // Same values as conaro-autonomous-business-os tests/link.test.ts and nexus-marketplace tests/unit/bos-link.test.ts.
    expect(linkSignature("test-link-secret-0123456789abcdef0123", "GET", "/api/bos/v1/daily-metrics?since=2026-11-01", "1763000000", "nonce-0123456789abcdef", ""))
      .toBe("v1=8aa8fb896065bc98fadc6c306eaaa061f881e359d9a12149d7ce3b469920452a");
    expect(emailHash(" Info@Example.CA ")).toBe("67d6b71492f4a64c8b786ed311df9bc9a9528fd98268386df6f6f710623332e6");
  });
});

describe("coexistence with existing builds", () => {
  it("creates only bai_ objects and its own migration ledger, so it can share a database with the operating system", async () => {
    const db = await createPgliteDb();
    // An existing application's tables and migration ledger in the same database.
    await db.exec(`create table schema_migrations (version text primary key, applied_at timestamptz not null default now());
      insert into schema_migrations (version) values ('0001_foundation.sql');
      create table tasks (id serial primary key, title text); insert into tasks (title) values ('existing');`);
    await migrate(db);
    expect(await db.query("select version from schema_migrations")).toEqual([{ version: "0001_foundation.sql" }]);
    expect(await db.query("select title from tasks")).toEqual([{ title: "existing" }]);
    const foreign = await db.query<{ name: string }>(
      `select relname name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','v','m','S','i') and relname not like 'bai\\_%' and relname not in ('schema_migrations','schema_migrations_pkey','tasks','tasks_pkey','tasks_id_seq')`);
    expect(foreign).toEqual([]);
    const fns = await db.query<{ proname: string }>("select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname not like 'bai\\_%'");
    expect(fns).toEqual([]);
    expect(await migrate(db)).toEqual([]);
    await db.close();
  });
});

describe("marketplace provider feed (read-only)", () => {
  let db: Db; let server: Server; let base: string; let feed: ProviderFeed; let calls: string[];
  beforeEach(async () => {
    db = await freshDb();
    calls = [];
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const check = verifyLinkRequest(MK, { method: req.method ?? "GET", pathAndQuery: url.pathname + url.search, headers });
      calls.push(url.pathname + url.search);
      res.setHeader("content-type", "application/json");
      if (!check.ok) { res.statusCode = 401; return res.end(JSON.stringify({ error: check.reason })); }
      if (url.searchParams.get("provider") !== feed.provider.ref) { res.statusCode = 404; return res.end("{}"); }
      res.end(JSON.stringify(feed));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

  it("imports requests and bookings into the linked business only; marketplace work stays with the marketplace", async () => {
    const a = await seedBusiness(db, "alpha", { autonomy: "rules", policy: { auto_send_quotes: true, max_auto_quote_cents: 50_000, auto_issue_invoices: true, auto_feedback_requests: true } });
    const b = await seedBusiness(db, "bravo");
    await withTenant(db, a.tenantId, (t) => t.query("update bai_tenants set marketplace_provider_ref = 'prov-123'"));
    feed = { version: 1, provider: { ref: "prov-123", status: "active" }, cursor: "c1",
      requests: [{ id: "req-0001", createdAt: "2026-11-18T12:00:00Z", category: "house cleaning", community: "Moncton", description: "Standard clean for a two-bedroom flat, weekday mornings.", desiredDate: null, customer: null, expressMarketingConsent: false }],
      bookings: [] };
    const client = new MarketplaceFeedClient(base, MK);
    const app = bai(NOW);
    await businessAiCycle(db, app.deps, { marketplace: client });
    expect(calls[0]).toBe("/api/bai/v1/provider-feed?provider=prov-123");
    await withTenant(db, a.tenantId, async (t) => {
      const lead = (await t.query<{ channel: string; status: string }>("select channel, status from bai_leads"))[0]!;
      expect(lead).toEqual({ channel: "conaro-marketplace", status: "qualified" });
      // The marketplace owns quotes on its requests: the price is prepared for the provider, never sent from here.
      expect((await t.query<{ status: string }>("select status from bai_quotes"))[0]!.status).toBe("draft");
      expect(await t.query("select 1 from bai_actions where action_type = 'quote.send'")).toEqual([]);
      expect((await t.query<{ title: string }>("select title from bai_admin_tasks where title like 'Enter quote%'")).length).toBe(1);
      expect((await t.query<{ status: string }>("select status from bai_integrations where provider = 'conaro-marketplace'"))[0]!.status).toBe("operational");
    });
    await withTenant(db, b.tenantId, async (t) => expect(await t.query("select 1 from bai_leads")).toEqual([]));

    // The customer books on the marketplace; the identity is revealed with the booking.
    feed = { ...feed, cursor: "c2", bookings: [{ id: "bk-9", requestId: "req-0001", status: "scheduled", startsAt: "2026-11-23T13:00:00Z", endsAt: "2026-11-23T16:00:00Z",
      customer: { name: "Pat Example", email: "pat@example.test", phone: null, language: "en-CA" } }] };
    await businessAiCycle(db, app.deps, { marketplace: client });
    expect(calls[1]).toBe("/api/bai/v1/provider-feed?provider=prov-123&since=c1");
    const jobId = await withTenant(db, a.tenantId, async (t) => {
      const bk = (await t.query<{ status: string; source: string; employee_id: string | null }>("select status, source, employee_id from bai_bookings"))[0]!;
      expect(bk).toMatchObject({ status: "confirmed", source: "conaro-marketplace", employee_id: a.employeeId });
      expect((await t.query<{ name: string }>("select name from bai_customers"))[0]!.name).toBe("Pat Example");
      return (await t.query<{ id: string }>("select id from bai_jobs"))[0]!.id;
    });
    expect(jobId).toBeTruthy();

    // Completed on the marketplace: no invoice, no review request, no extra message from here.
    feed = { ...feed, cursor: "c3", bookings: [{ ...feed.bookings[0]!, status: "completed" }] };
    await businessAiCycle(db, app.deps, { marketplace: client });
    await withTenant(db, a.tenantId, async (t) => {
      expect((await t.query<{ status: string }>("select status from bai_jobs"))[0]!.status).toBe("completed");
      expect(await t.query("select 1 from bai_invoices")).toEqual([]);
      expect(await t.query("select 1 from bai_actions where action_type in ('feedback.request','invoice.issue')")).toEqual([]);
      // Re-reading the same page imports nothing twice.
      const before = await t.query("select 1 from bai_external_refs");
      expect(before).toHaveLength(2);
    });
    await businessAiCycle(db, app.deps, { marketplace: client });
    await withTenant(db, a.tenantId, async (t) => expect(await t.query("select 1 from bai_leads")).toHaveLength(1));
  });

  it("a wrong key or an unknown provider is reported, and nothing is imported", async () => {
    const a = await seedBusiness(db, "alpha");
    await withTenant(db, a.tenantId, (t) => t.query("update bai_tenants set marketplace_provider_ref = 'prov-123'"));
    feed = { version: 1, provider: { ref: "prov-123", status: "active" }, cursor: "c1", requests: [], bookings: [] };
    const bad = await syncMarketplace(db, new MarketplaceFeedClient(base, "another-key-0123456789abcdef-0000000"), a.tenantId);
    expect(bad).toMatchObject({ synced: false, detail: expect.stringMatching(/refused the link key/) });
    await withTenant(db, a.tenantId, async (t) => {
      expect((await t.query<{ status: string }>("select status from bai_integrations where provider = 'conaro-marketplace'"))[0]!.status).toBe("error");
    });
    feed = { ...feed, provider: { ref: "someone-else", status: "active" } };
    expect(await syncMarketplace(db, new MarketplaceFeedClient(base, MK), a.tenantId)).toMatchObject({ synced: false });
    await processTenant(db, a.tenantId, bai(NOW).deps);
  });
});

describe("endpoints for the other applications", () => {
  let db: Db; let server: Server; let base: string;
  beforeEach(async () => {
    db = await freshDb();
    server = createPortalServer({ db, app: bai(NOW), linkSecret: SECRET, marketplaceLinkSecret: MK, bosLinkSecret: BOS });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

  it("gives the operating system an aggregate summary only, to signed callers with its own key", async () => {
    await seedBusiness(db, "alpha");
    await seedBusiness(db, "bravo", { plan: "starter" });
    const path = "/api/link/v1/summary";
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    expect((await fetch(`${base}${path}`, { headers: signLinkRequest(MK, "GET", path) })).status).toBe(401);
    const headers = signLinkRequest(BOS, "GET", path);
    const r = await fetch(`${base}${path}`, { headers });
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ version: 1, app: "conaro-business-ai", mode: "simulation", workspaces: { total: 2, byPlan: { premium: 1, starter: 1 }, byIndustry: { "residential-cleaning": 2 } } });
    expect(text).not.toMatch(/Sparkle|example\.test|@/);
    expect((await fetch(`${base}${path}`, { headers })).status).toBe(401); // replay refused
    const hs = "/api/link/v1/handshake?peer=bos";
    expect(await (await fetch(`${base}${hs}`, { headers: signLinkRequest(BOS, "GET", hs) })).json()).toMatchObject({ ok: true, peer: "bos" });
    expect((await fetch(`${base}/api/link/v1/summary`, { method: "POST" })).status).toBe(405);
  });

  it("signs in an existing member handed over from the marketplace, once, within two minutes", async () => {
    const a = await seedBusiness(db, "alpha");
    await withTenant(db, a.tenantId, (t) => t.query("update bai_tenants set marketplace_provider_ref = 'prov-123'"));
    const token = signSsoToken(MK, { providerRef: "prov-123", email: "Owner@alpha.example.test" });
    const ok = await fetch(`${base}/sso?t=${encodeURIComponent(token)}`, { redirect: "manual" });
    expect(ok.status).toBe(303);
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(await (await fetch(`${base}/`, { headers: { cookie } })).text()).toContain("Sparkle alpha");
    expect((await fetch(`${base}/sso?t=${encodeURIComponent(token)}`, { redirect: "manual" })).status).toBe(401); // single use
    const stale = signSsoToken(MK, { providerRef: "prov-123", email: "owner@alpha.example.test" }, Date.now() - 10 * 60_000);
    expect(await (await fetch(`${base}/sso?t=${encodeURIComponent(stale)}`)).text()).toMatch(/expired/);
    const stranger = signSsoToken(MK, { providerRef: "prov-123", email: "someone@else.example.test" });
    expect(await (await fetch(`${base}/sso?t=${encodeURIComponent(stranger)}`)).text()).toMatch(/Ask the workspace owner/);
    const forged = signSsoToken(BOS, { providerRef: "prov-123", email: "owner@alpha.example.test" });
    expect((await fetch(`${base}/sso?t=${encodeURIComponent(forged)}`)).status).toBe(401);
  });
});
