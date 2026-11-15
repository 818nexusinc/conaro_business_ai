import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, seedBusiness, SECRET } from "./fixtures.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { createAdmin } from "../src/admin/auth.ts";
import { clearPlanCache } from "../src/admin/plans.ts";
import { clearContentCache } from "../src/admin/content.ts";

const PW = "correct horse battery staple";
let db: Db; let server: Server; let base: string;
beforeEach(async () => {
  db = await freshDb(); clearPlanCache(); clearContentCache();
  server = createPortalServer({ db, app: bai(new Date("2026-11-18T14:00:00Z")), linkSecret: SECRET, landing: { signupOpen: true } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

const post = (path: string, cookie: string, body: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", redirect: "manual",
  headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams(body) });
async function signIn(email: string, path = "/admin/login") {
  const r = await fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ email, password: PW }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const page = await (await fetch(`${base}${path === "/admin/login" ? "/admin/plans" : "/"}`, { headers: { cookie } })).text();
  return { cookie, csrf: page.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "" };
}
const growthForm = (csrf: string, over: Record<string, string> = {}) => ({ _csrf: csrf, plan: "growth", price: "149", name_en: "Growth", name_fr: "Croissance",
  features_en: "Social media\nSEO and lead generation", features_fr: "Médias sociaux\nRéférencement et prospection", recommended: "yes", ...over });

describe("plans and pricing admin", () => {
  it("publishes prices to the website, sign-up and control centre only after an owner publishes", async () => {
    await createAdmin(db, { email: "owner@conaro.example", name: "Owner", password: PW, role: "owner" }, "test");
    await createAdmin(db, { email: "ed@conaro.example", name: "Editor", password: PW, role: "editor" }, "test");
    const owner = await signIn("owner@conaro.example");
    const ed = await signIn("ed@conaro.example");
    expect((await post("/admin/do/plan", ed.cookie, growthForm(ed.csrf))).status).toBe(403);

    expect(decodeURIComponent((await post("/admin/do/plan", owner.cookie, growthForm(owner.csrf, { price: "abc" }))).headers.get("location") ?? "")).toMatch(/err=The price must be a number/);
    expect((await post("/admin/do/plan", owner.cookie, growthForm(owner.csrf))).status).toBe(303);
    expect(await (await fetch(`${base}/?lang=en`)).text()).not.toContain("$149");

    expect((await post("/admin/do/plans-publish", ed.cookie, { _csrf: ed.csrf })).status).toBe(403);
    expect(decodeURIComponent((await post("/admin/do/plans-publish", owner.cookie, { _csrf: owner.csrf })).headers.get("location") ?? "")).toContain("Published 1 plan");
    clearPlanCache();
    const en = await (await fetch(`${base}/?lang=en`)).text();
    expect(en).toContain("<strong>$149</strong>");
    expect(en).toContain("+ tax");
    expect(en).toContain("SEO and lead generation");
    expect(en).toContain("Price announced before billing starts"); // the other plans are still unannounced
    const fr = await (await fetch(`${base}/?lang=fr`)).text();
    expect(fr).toContain("<strong>149 $</strong>");
    expect(fr).toContain("Référencement et prospection");

    await seedBusiness(db, "alpha");
    const biz = await signIn("owner@alpha.example.test", "/login");
    expect(await (await fetch(`${base}/plan`, { headers: { cookie: biz.cookie } })).text()).toContain("$149.00 / month");
    const hist = await (await fetch(`${base}/admin/plans`, { headers: { cookie: owner.cookie } })).text();
    expect(hist).toContain("$149 / month");
    expect((await db.query<{ action: string }>("select action from bai_admin_audit where action = 'plans.published'")).length).toBe(1);
  });
});
