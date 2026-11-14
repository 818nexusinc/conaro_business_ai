import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, SECRET } from "./fixtures.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { PRESENTERS } from "../src/landing/presenters.ts";
import { AGENTS } from "../src/catalog/agents.ts";
import { PLANS } from "../src/catalog/plans.ts";
import { buildPresenterDoc } from "../scripts/gen-assets.ts";

let db: Db; let server: Server; let base: string;
async function start(landing: { signupOpen: boolean; videoBase?: string } | undefined) {
  server = createPortalServer({ db, app: bai(new Date()), linkSecret: SECRET, ...(landing ? { landing } : {}) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const form = (over: Record<string, string> = {}) => new URLSearchParams({
  plan: "growth", business: "Pilot Cleaning Co", industry: "residential-cleaning", name: "Owner", email: "owner@pilot-cleaning.example.com",
  password: "correct horse battery staple", pilot: "yes", ...over });
const signup = (body: URLSearchParams) => fetch(`${base}/signup`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body });

beforeEach(async () => { db = await freshDb(); });
afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

describe("landing page", () => {
  it("is what signed-out visitors see at /, with every presenter, every plan and only real agents", async () => {
    await start({ signupOpen: true });
    const r = await fetch(`${base}/?plan=premium`);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("font-src 'self'");
    const body = await r.text();
    for (const p of PRESENTERS) expect(body, p.id).toContain(`id="video-${p.id}"`);
    for (const p of PLANS) expect(body).toContain(`href="/?plan=${p.id}#start"`);
    expect(body).toMatch(/name="plan" value="premium" checked/);
    // No prices are set, so none may appear.
    expect(body).not.toMatch(/\$\d/);
    expect(body).toContain("Price announced before billing starts");
    // Agents shown exist and work today; planned ones are only listed as coming next.
    const operational = AGENTS.filter((a) => a.status === "operational").length;
    expect(body).toContain(`${operational} AI agents answer enquiries`);
    for (const p of PRESENTERS) for (const id of p.agents) expect(AGENTS.find((a) => a.id === id)?.status, id).toBe("operational");
    expect(body).not.toMatch(/testimonial|★|\d+% (more|increase)/i);
    expect((await fetch(`${base}/static/landing.css`)).status).toBe(200);
    expect((await fetch(`${base}/static/manrope.woff2`)).headers.get("content-type")).toBe("font/woff2");
    expect((await fetch(`${base}/`, { method: "HEAD" })).status).toBe(200);
  });

  it("serves captions generated from each script", async () => {
    await start({ signupOpen: true });
    const vtt = await (await fetch(`${base}/captions/front-desk.vtt`)).text();
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    for (const line of PRESENTERS.find((p) => p.id === "front-desk")!.script) expect(vtt).toContain(line);
    expect((await fetch(`${base}/captions/unknown.vtt`)).status).toBe(404);
  });

  it("shows real video players (and allows only that host for media) once BAI_PRESENTER_VIDEO_BASE is set", async () => {
    await start({ signupOpen: true, videoBase: "https://media.example.com/bai/" });
    const r = await fetch(`${base}/`);
    expect(r.headers.get("content-security-policy")).toContain("media-src 'self' https://media.example.com");
    const body = await r.text();
    expect(body).toContain('<source src="https://media.example.com/bai/manager.mp4" type="video/mp4">');
    expect(body).toContain('src="/captions/manager.vtt" default');
    expect(body).not.toContain("Presenter video coming soon");
  });

  it("without the landing option (or when signed in) / keeps its old behaviour", async () => {
    await start(undefined);
    expect((await fetch(`${base}/`, { redirect: "manual" })).status).toBe(303);
  });

  it("the generated presenter scripts document is current (npm run gen:assets)", () => {
    expect(readFileSync(new URL("../docs/PRESENTER_SCRIPTS.md", import.meta.url), "utf8")).toBe(buildPresenterDoc());
  });
});

describe("pilot sign-up", () => {
  it("creates a pilot workspace on the chosen plan and signs the owner in", async () => {
    await start({ signupOpen: true });
    const r = await signup(form({ plan: "professional", marketing: "yes" }));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(/^\/settings\?ok=Welcome/);
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(await (await fetch(`${base}/`, { headers: { cookie } })).text()).toContain("Pilot Cleaning Co");
    const s = (await db.query<{ plan: string; status: string; is_demo: boolean; marketing_consent: boolean; consent_wording: string }>(
      `select sub.plan, sub.status, t.is_demo, g.marketing_consent, g.consent_wording from bai_signups g join bai_tenants t on t.id = g.tenant_id
       join bai_subscriptions sub on sub.tenant_id = t.id`))[0]!;
    expect(s).toMatchObject({ plan: "professional", status: "trial", is_demo: false, marketing_consent: true });
    expect(s.consent_wording).toMatch(/unsubscribe/);
  });

  it("refuses an existing email, a missing pilot confirmation and bots, keeping what was typed (never the password)", async () => {
    await start({ signupOpen: true });
    expect((await signup(form())).status).toBe(303);
    const dup = await signup(form({ business: "Another Co" }));
    expect(dup.status).toBe(400);
    const dupBody = await dup.text();
    expect(dupBody).toContain("already exists");
    expect(dupBody).toContain('value="Another Co"');
    expect(dupBody).not.toContain("correct horse battery staple");
    const noPilot = form({ email: "x@pilot.example.com" }); noPilot.delete("pilot");
    expect(await (await signup(noPilot)).text()).toContain("confirm you understand the pilot");
    expect((await signup(form({ email: "bot@pilot.example.com", website: "http://spam.example" }))).status).toBe(400);
    expect((await db.query("select 1 from bai_users where email = 'bot@pilot.example.com'")).length).toBe(0);
  });

  it("can be closed, and is rate-limited per connection", async () => {
    await start({ signupOpen: false });
    expect((await signup(form())).status).toBe(403);
    expect(await (await fetch(`${base}/`)).text()).toContain("Sign-ups are paused");
    await new Promise((r) => server.close(r));
    await start({ signupOpen: true });
    for (let i = 0; i < 5; i++) expect((await signup(form({ email: `o${i}@pilot.example.com` }))).status).toBe(303);
    expect(await (await signup(form({ email: "o6@pilot.example.com" }))).text()).toContain("Too many sign-ups");
  });
});
