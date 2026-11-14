import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, SECRET } from "./fixtures.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { AGENT_COPY, CONTROL_SCRIPT } from "../src/landing/agents-copy.ts";
import { COPY, INDUSTRY_FR, PLAN_FEATURES_FR, PLAN_NAME_FR } from "../src/landing/copy.ts";
import { AGENTS } from "../src/catalog/agents.ts";
import { INDUSTRY_PACKS } from "../src/catalog/industries.ts";
import { PLANS } from "../src/catalog/plans.ts";
import { resolveLang } from "../src/i18n.ts";
import { buildPresenterDoc } from "../scripts/gen-assets.ts";

type Landing = { signupOpen: boolean; videoBase?: string; audioBase?: string; frReviewedBy?: string };
let db: Db; let server: Server; let base: string;
async function start(landing: Landing | undefined) {
  server = createPortalServer({ db, app: bai(new Date()), linkSecret: SECRET, ...(landing ? { landing } : {}) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const form = (over: Record<string, string> = {}) => new URLSearchParams({
  plan: "growth", business: "Pilot Cleaning Co", industry: "residential-cleaning", name: "Owner", email: "owner@pilot-cleaning.example.com",
  password: "correct horse battery staple", pilot: "yes", ...over });
const signup = (body: URLSearchParams, q = "") => fetch(`${base}/signup${q}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body });

beforeEach(async () => { db = await freshDb(); });
afterEach(async () => { if (server?.listening) await new Promise((r) => server.close(r)); await db.close(); });

describe("explainer content", () => {
  it("has one bilingual explainer per working agent and none for planned agents", () => {
    const operational = AGENTS.filter((a) => a.status === "operational").map((a) => a.id).sort();
    expect(AGENT_COPY.map((a) => a.id).sort()).toEqual(operational);
    for (const a of AGENT_COPY) {
      expect(a.script.en.length, a.id).toBeGreaterThanOrEqual(3);
      expect(a.script.fr.length, a.id).toBe(a.script.en.length);
      expect(a.how.fr.length, a.id).toBe(a.how.en.length);
      for (const l of [...a.script.en, ...a.how.en, a.summary.en]) expect(l, a.id).not.toMatch(/soumission|réservation/i);
      // CONARO glossary: a quote is a "soumission", never a "devis"; no invented figures in either language.
      for (const l of [...a.script.fr, ...a.how.fr, a.summary.fr]) expect(l, a.id).not.toMatch(/\bdevis\b|\d+ ?%/i);
      for (const l of [...a.script.en, ...a.how.en]) expect(l, a.id).not.toMatch(/\d+ ?%|guarantee/i);
    }
    expect(CONTROL_SCRIPT.fr.length).toBe(CONTROL_SCRIPT.en.length);
  });

  it("translates every industry, plan and plan feature", () => {
    for (const p of INDUSTRY_PACKS) expect(INDUSTRY_FR[p.id], p.id).toBeTruthy();
    for (const p of PLANS) { expect(PLAN_NAME_FR[p.id]).toBeTruthy(); expect(PLAN_FEATURES_FR[p.id]?.length).toBe(p.features.length); }
    expect(COPY.fr.faq.length).toBe(COPY.en.faq.length);
    expect(COPY.fr.steps.length).toBe(COPY.en.steps.length);
  });

  it("chooses the language from the link, then the remembered choice, then the browser", () => {
    expect(resolveLang("fr", "en", "en-CA")).toEqual({ lang: "fr", remember: true });
    expect(resolveLang(null, "fr", "en-CA")).toEqual({ lang: "fr", remember: false });
    expect(resolveLang(null, undefined, "fr-CA,fr;q=0.9,en;q=0.8")).toEqual({ lang: "fr", remember: false });
    expect(resolveLang(null, undefined, "en-US,fr;q=0.5")).toEqual({ lang: "en", remember: false });
    expect(resolveLang(null, undefined, undefined)).toEqual({ lang: "en", remember: false });
  });

  it("the generated presenter scripts document is current (npm run gen:assets)", () => {
    expect(readFileSync(new URL("../docs/PRESENTER_SCRIPTS.md", import.meta.url), "utf8")).toBe(buildPresenterDoc());
  });
});

describe("landing page", () => {
  it("shows every agent in its own tab with a speaking presenter, every plan, and no invented prices", async () => {
    await start({ signupOpen: true });
    const r = await fetch(`${base}/?lang=en&plan=premium`);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    const body = await r.text();
    expect(body).toContain('<html lang="en-CA">');
    expect(body).toContain('<script src="/static/landing.js" defer></script>');
    expect(body.match(/role="tab" /g)?.length).toBe(AGENT_COPY.length);
    for (const a of AGENT_COPY) {
      expect(body, a.id).toContain(`id="agent-${a.id}"`);
      expect(body, a.id).toContain(a.script.en[0]!.replaceAll("'", "&#39;"));
    }
    expect(body.match(/data-play /g)?.length).toBe(AGENT_COPY.length + 2); // + hero + control
    for (const p of PLANS) expect(body).toContain(`plan=${p.id}#start`);
    expect(body).toMatch(/name="plan" value="premium" checked/);
    expect(body).not.toMatch(/\$\d|\d \$/);
    expect(body).not.toMatch(/testimonial|★/i);
    expect(body).toContain('hreflang="fr-CA"');
    expect((await fetch(`${base}/static/landing.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/`, { method: "HEAD" })).status).toBe(200);
  });

  it("is fully French with ?lang=fr (and remembers it), from the browser's language, with a review note until a reviewer is recorded", async () => {
    await start({ signupOpen: true });
    const r = await fetch(`${base}/?lang=fr`);
    expect(r.headers.get("set-cookie")).toMatch(/bai_lang=fr/);
    expect(r.headers.get("content-language")).toBe("fr-CA");
    const body = await r.text();
    expect(body).toContain('<html lang="fr-CA">');
    expect(body).toContain("Votre entreprise. Votre équipe IA.");
    expect(body).toContain("Version française en cours de révision.");
    for (const a of AGENT_COPY) expect(body, a.id).toContain(a.name.fr.replaceAll("'", "&#39;"));
    expect(body).toContain("Prix annoncé avant le début de la facturation");
    expect(body).toContain("Déneigement");
    expect(body).not.toContain("Choose your plan");
    const fromBrowser = await (await fetch(`${base}/`, { headers: { "accept-language": "fr-CA,fr;q=0.9" } })).text();
    expect(fromBrowser).toContain('<html lang="fr-CA">');
    const remembered = await (await fetch(`${base}/`, { headers: { cookie: "bai_lang=fr" } })).text();
    expect(remembered).toContain('<html lang="fr-CA">');
    await new Promise((res) => server.close(res));
    await start({ signupOpen: true, frReviewedBy: "Reviewer Name" });
    expect(await (await fetch(`${base}/?lang=fr`)).text()).not.toContain("en cours de révision");
  });

  it("serves captions in both languages from the scripts", async () => {
    await start({ signupOpen: true });
    const en = await (await fetch(`${base}/captions/en/booking.vtt`)).text();
    const fr = await (await fetch(`${base}/captions/fr/booking.vtt`)).text();
    expect(en.startsWith("WEBVTT")).toBe(true);
    for (const l of AGENT_COPY.find((a) => a.id === "booking")!.script.fr) expect(fr).toContain(l);
    expect(en).toContain("I look after your schedule.");
    expect((await fetch(`${base}/captions/de/booking.vtt`)).status).toBe(404);
    expect((await fetch(`${base}/captions/en/unknown.vtt`)).status).toBe(404);
  });

  it("plays recorded natural-voice narration or video when configured, allowing only that host for media", async () => {
    await start({ signupOpen: true, audioBase: "https://voices.example.com/bai" });
    const a = await fetch(`${base}/?lang=fr`);
    expect(a.headers.get("content-security-policy")).toContain("media-src 'self' https://voices.example.com");
    expect(await a.text()).toContain('data-audio="https://voices.example.com/bai/fr/booking.mp3"');
    await new Promise((res) => server.close(res));
    await start({ signupOpen: true, videoBase: "https://media.example.com/bai/" });
    const v = await (await fetch(`${base}/?lang=en`)).text();
    expect(v).toContain('<source src="https://media.example.com/bai/en/booking.mp4" type="video/mp4">');
    expect(v).toContain('src="/captions/en/booking.vtt" default');
  });

  it("without the landing option, / keeps its old behaviour", async () => {
    await start(undefined);
    expect((await fetch(`${base}/`, { redirect: "manual" })).status).toBe(303);
  });
});

describe("pilot sign-up", () => {
  it("creates a pilot workspace on the chosen plan and signs the owner in, keeping the consent wording shown", async () => {
    await start({ signupOpen: true });
    const r = await signup(form({ plan: "professional", marketing: "yes", lang: "fr" }), "?lang=fr");
    expect(r.status).toBe(303);
    const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]!);
    expect(cookies).toContain("bai_lang=fr");
    const home = await (await fetch(`${base}/`, { headers: { cookie: cookies.join("; ") } })).text();
    expect(home).toContain("Pilot Cleaning Co");
    expect(home).toContain('<html lang="fr-CA">');
    const s = (await db.query<{ plan: string; status: string; marketing_consent: boolean; consent_wording: string }>(
      "select sub.plan, sub.status, g.marketing_consent, g.consent_wording from bai_signups g join bai_subscriptions sub on sub.tenant_id = g.tenant_id"))[0]!;
    expect(s).toMatchObject({ plan: "professional", status: "trial", marketing_consent: true });
    expect(s.consent_wording).toMatch(/désabonner/);
  });

  it("explains problems in the visitor's language and keeps what was typed (never the password)", async () => {
    await start({ signupOpen: true });
    expect((await signup(form())).status).toBe(303);
    const dup = await signup(form({ business: "Another Co", lang: "fr" }), "?lang=fr");
    expect(dup.status).toBe(400);
    const body = await dup.text();
    expect(body).toContain("Un compte existe déjà avec ce courriel");
    expect(body).toContain('value="Another Co"');
    expect(body).not.toContain("correct horse battery staple");
    const bad = form({ email: "not-an-email", lang: "fr" }); bad.delete("pilot");
    const badBody = await (await signup(bad, "?lang=fr")).text();
    expect(badBody).toContain("Indiquez une adresse courriel valide.");
    expect(badBody).toContain("Veuillez confirmer que vous comprenez le projet pilote.");
    expect(await (await signup(form({ email: "x@pilot.example.com", pilot: "no" }))).text()).toContain("please confirm you understand the pilot");
    expect((await signup(form({ email: "bot@pilot.example.com", website: "http://spam.example" }))).status).toBe(400);
    expect((await db.query("select 1 from bai_users where email = 'bot@pilot.example.com'")).length).toBe(0);
  });

  it("can be closed, and is rate-limited per connection", async () => {
    await start({ signupOpen: false });
    expect((await signup(form())).status).toBe(403);
    expect(await (await fetch(`${base}/?lang=fr`)).text()).toContain("Les inscriptions sont suspendues");
    await new Promise((r) => server.close(r));
    await start({ signupOpen: true });
    for (let i = 0; i < 5; i++) expect((await signup(form({ email: `o${i}@pilot.example.com` }))).status).toBe(303);
    expect(await (await signup(form({ email: "o6@pilot.example.com" }))).text()).toContain("Too many sign-ups");
  });
});
