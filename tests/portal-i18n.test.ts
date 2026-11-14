import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, seedBusiness, SECRET } from "./fixtures.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { withTenant } from "../src/tenancy.ts";
import { receiveEnquiry } from "../src/tools/revenue.ts";
import { processTenant } from "../src/workflows.ts";
import { unsubscribeToken } from "../src/consent.ts";
import { money, runInLang, translateHtml, translateText, UI_STRINGS, when } from "../src/portal/i18n.ts";
import { AGENTS } from "../src/catalog/agents.ts";

describe("French translation of rendered pages", () => {
  it("translates UI text but never records, what people typed, or submitted values", () => {
    const page = `<!doctype html><html lang="en-CA"><head><title>Approvals · Alpha Co · CONARO Business AI</title></head><body>
<nav aria-label="Sections"><a href="/">Today</a></nav><h1>Approvals</h1><span class="badge warn">pending</span>
<label>Email <input name="email" value="Save"></label><select name="channel"><option>phone</option><option value="email">email</option></select>
<pre class="json">Approvals</pre><code>Save</code><textarea name="t">Today</textarea><td>Pat Alpha&#39;s lawn</td><button>Save</button></body></html>`;
    const fr = translateHtml(page);
    expect(fr).toContain('<html lang="fr-CA">');
    expect(fr).toContain("<title>Approbations · Alpha Co · CONARO Business AI</title>");
    expect(fr).toContain('<a href="/">Aujourd&#39;hui</a>');
    expect(fr).toContain("<h1>Approbations</h1>");
    expect(fr).toContain('<span class="badge warn">en attente</span>');
    expect(fr).toContain("<label>Courriel <input");
    expect(fr).toContain('value="Save"');                      // a form value is never changed
    expect(fr).toContain("<option>phone</option>");             // no value attribute: the text is what is submitted
    expect(fr).toContain('<option value="email">courriel</option>');
    expect(fr).toContain('<pre class="json">Approvals</pre><code>Save</code><textarea name="t">Today</textarea>');
    expect(fr).toContain("<td>Pat Alpha&#39;s lawn</td>");      // business data as written
    expect(fr).toContain("<button>Enregistrer</button>");
  });

  it("keeps values while translating the words around them", () => {
    expect(translateText("Unavailable: no invoices issued in this period")).toBe("Non disponible : aucune facture émise pendant cette période");
    expect(translateText("Approved: simulated.")).toBe("Approuvé : simulé.");
    expect(translateText("Enquiry L-0042 saved; the agents will pick it up in the next cycle.")).toBe("Demande L-0042 enregistrée; les agents la traiteront au prochain cycle.");
    expect(translateText("HST 15%")).toBe("TVH 15 %");
    expect(translateText("Mon 08:00–17:00; Sat 09:00–12:00")).toBe("lun. 08:00–17:00; sam. 09:00–12:00");
    expect(translateText("Reply to L-0001")).toBe("Reply to L-0001");   // agent-written text stays as recorded
  });

  it("formats dates and money for the page's language", () => {
    expect(runInLang("fr", () => money(125000))).toMatch(/^1[\s\u202f]250,00 \$$/u);
    expect(runInLang("en", () => money(125000))).toBe("$1,250.00");
    expect(runInLang("fr", () => money(null))).toBe("non disponible");
    expect(runInLang("fr", () => when("2026-11-18T14:00:00Z"))).toMatch(/nov\./);
  });

  it("has a French entry for every UI string and every agent, using the CONARO glossary", () => {
    for (const s of UI_STRINGS) {
      const fr = translateText(s);
      expect(fr, s).toBeTruthy();
      if (s.length > 12 && !/CONARO|^\d/.test(s)) expect(fr, s).not.toBe(s);
      expect(fr, s).not.toMatch(/\bdevis\b|\bbooking\b|\bquote\b/i);
    }
    for (const a of AGENTS) expect(translateText(a.name), a.id).not.toBe(a.name);
  });
});

describe("control centre in French", () => {
  let db: Db; let server: Server; let base: string;
  beforeEach(async () => {
    db = await freshDb();
    server = createPortalServer({ db, app: bai(new Date("2026-11-18T14:00:00Z")), linkSecret: SECRET });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

  async function signIn(email: string) {
    const r = await fetch(`${base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password: "correct horse battery staple" }) });
    return r.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
  }

  it("shows every section in French when chosen, remembers it, and switches back", async () => {
    const a = await seedBusiness(db, "alpha");
    await withTenant(db, a.tenantId, (t) => receiveEnquiry(t, { name: "Pat Alpha", email: "pat@example.test", description: "Standard clean in Moncton please", area: "Moncton", channel: "website" }, "test"));
    await processTenant(db, a.tenantId, bai(new Date("2026-11-18T14:00:00Z")).deps);
    const session = await signIn("owner@alpha.example.test");
    const first = await fetch(`${base}/approvals?lang=fr`, { headers: { cookie: session } });
    expect(first.headers.get("set-cookie")).toMatch(/bai_lang=fr/);
    const cookie = `${session}; bai_lang=fr`;
    const expected: Record<string, string> = {
      "/": "Sommaire quotidien de direction", "/chat": "Votre question", "/approvals": "Demandé par", "/growth": "Centre de commande de la croissance",
      "/finance": "Centre de commande financier", "/enquiries": "Enregistrer une demande", "/bookings": "Réservations et travaux", "/agents": "Brouillon seulement",
      "/activity": "Messages entre agents", "/recommendations": "Votre liste de tâches", "/reports": "Rapports", "/documents": "Ajouter un document texte",
      "/settings": "Règles d&#39;exploitation", "/integrations": "Dernière vérification", "/plan": "Utilisation ce mois-ci", "/audit": "Journal d&#39;audit",
    };
    for (const [p, text] of Object.entries(expected)) {
      const r = await fetch(`${base}${p}`, { headers: { cookie } });
      expect(r.status, p).toBe(200);
      const body = await r.text();
      expect(body, p).toContain('<html lang="fr-CA">');
      expect(body, p).toContain("SIMULATION : aucun message");
      expect(body, p).toContain(text);
      expect(body, p).toContain('hreflang="en-CA">English</a>');
      expect(body, p).not.toMatch(/>(Save|Approvals|Sign out|Today)</);
    }
    expect(await (await fetch(`${base}/enquiries`, { headers: { cookie } })).text()).toContain("Pat Alpha");
    const back = await fetch(`${base}/?lang=en`, { headers: { cookie } });
    expect(back.headers.get("set-cookie")).toMatch(/bai_lang=en/);
    expect(await back.text()).toContain('<html lang="en-CA">');
  });

  it("follows the browser's language on the sign-in page and in error messages", async () => {
    const login = await (await fetch(`${base}/login`, { headers: { "accept-language": "fr-CA,fr;q=0.9" } })).text();
    expect(login).toContain('<html lang="fr-CA">');
    expect(login).toContain("Mot de passe");
    expect(login).toContain('hreflang="en-CA">English</a>');
    const bad = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "accept-language": "fr" }, body: new URLSearchParams({ email: "x@example.test", password: "wrong password here" }) });
    expect(await bad.text()).toContain("Courriel ou mot de passe non reconnu.");
    expect(await (await fetch(`${base}/do/pause`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: "bai_lang=fr" }, body: "" })).text()).toBe("Reconnectez-vous.");
  });

  it("keeps the customer unsubscribe page in both languages, whatever the visitor's setting", async () => {
    const a = await seedBusiness(db, "alpha");
    const page = await (await fetch(`${base}/u/${unsubscribeToken(a.tenantId, "pat@example.test", SECRET)}`, { headers: { cookie: "bai_lang=fr" } })).text();
    expect(page).toContain("Unsubscribe / Se désabonner");
    expect(page).toContain("data-bilingual");
  });
});
