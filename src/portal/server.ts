import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import type { Db } from "../shared/db.ts";
import { json } from "../shared/db.ts";
import { AccessDeniedError, PermanentError } from "../shared/errors.ts";
import { withTenant, type TenantDb } from "../tenancy.ts";
import { tenantAudit } from "../audit.ts";
import type { BusinessAi } from "../index.ts";
import { decideApproval } from "../gateway.ts";
import { acceptQuote } from "../effects.ts";
import { receiveEnquiry } from "../tools/revenue.ts";
import { runTool } from "../tools/index.ts";
import { confirmCategory } from "../tools/finance.ts";
import { addEmployee, addMember, changePlan, configureAgent, setPaused, upsertService } from "../tenants.ts";
import { saveProfile } from "../profile.ts";
import { PolicySchema, updatePolicy } from "../settings.ts";
import { unsubscribeCustomer, verifyUnsubscribeToken } from "../consent.ts";
import { zonedTime } from "../time.ts";
import { verifyInbound } from "../interop/link-server.ts";
import { LINK_VERSION } from "../interop/protocol.ts";
import { buildSummary } from "../interop/bos.ts";
import { verifySsoToken } from "../interop/sso.ts";
import { can, createSession, csrfOk, portalLogin, portalLogout, portalSession, SESSION_HOURS, type Permission, type PortalSession } from "./auth.ts";
import * as P from "./pages.ts";
import { html, type Html } from "../shared/html.ts";
import { seedDemo, removeDemo } from "../demo.ts";
import { createTenant } from "../tenants.ts";
import { INDUSTRY_PACKS } from "../catalog/industries.ts";
import { PLANS } from "../catalog/plans.ts";

function setupPage(enabled: boolean, result?: Html): string {
  if (!enabled) return P.publicPage("Set-up is off", "This page only works while the BAI_SETUP_KEY setting is present. Add it in the host's environment variables (32+ random characters), redeploy, and come back. Remove it again when you are done.");
  const key = html`<label>Set-up key (the BAI_SETUP_KEY value) <input name="key" type="password" required autocomplete="off"></label>`;
  return P.publicPage("CONARO Business AI set-up", "Create demo accounts for testing, or the first real business. Remove BAI_SETUP_KEY from the host when you are done.", html`
${result ?? ""}
<h2>Demo accounts</h2><p class="muted">Three invented businesses (cleaning on Premium, snow and lawn on Professional, plumbing on Starter) with logins for owner, manager, staff, accountant and viewer, history, enquiries and agent activity. Running it again gives new passwords and never duplicates data.</p>
<form class="stack" method="post">${key}<button name="action" value="demo" type="submit">Create demo accounts (or new passwords)</button></form>
<form class="stack" method="post">${key}<button class="secondary" name="action" value="remove-demo" type="submit">Remove demo accounts</button></form>
<h2>First real business</h2>
<form class="stack" method="post">${key}
<label>Business name <input name="name" required maxlength="120"></label><label>Short name for addresses (lower-case letters, digits, dashes) <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,62}"></label>
<label>Industry <select name="industry">${INDUSTRY_PACKS.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
<label>Plan <select name="plan">${PLANS.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
<label>Owner's name <input name="owner" required maxlength="120"></label><label>Owner's email <input name="email" type="email" required></label>
<label>Owner's password (12+ characters) <input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
<button name="action" value="business" type="submit">Create business</button></form>`);
}

import { CSS, LANDING_CSS, LANDING_JS, MANROPE_WOFF2_BASE64 } from "../generated/assets.ts";
import { landingPage } from "../landing/page.ts";
import { captionsVtt, findExplainer } from "../landing/presenters.ts";
import { langCookie, resolveLang, type Lang } from "../i18n.ts";
import { currentLang, runInLang, translateHtml, translatePlain } from "./i18n.ts";
import { signUp } from "../landing/signup.ts";

const MANROPE = Buffer.from(MANROPE_WOFF2_BASE64, "base64");
const COOKIE = "bai_session";
const MAX_BODY = 2_200_000;

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export interface PortalOptions {
  db: Db;
  app: BusinessAi;
  linkSecret: string;
  secure?: boolean;
  trustProxy?: boolean;
  /** Shared key with the marketplace (sign-in hand-over, handshake). */
  marketplaceLinkSecret?: string;
  /** Shared key with the CONARO operating system (summary, handshake). */
  bosLinkSecret?: string;
  /** Scheduled trigger (e.g. Vercel Cron): GET /api/cron/tick with "Authorization: Bearer <secret>" runs one cycle. */
  cron?: { secret: string; run: () => Promise<unknown> };
  /** One-time set-up page (/setup), open only while BAI_SETUP_KEY is set. */
  setupKey?: string;
  /** The public landing page at / (signed-out visitors) and self-serve pilot sign-up. */
  landing?: { signupOpen: boolean; videoBase?: string; audioBase?: string; frReviewedBy?: string };
}

function headers(res: ServerResponse, secure: boolean) {
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
}

/** Sends a response; for a French request, English control-centre pages and plain errors are translated (see portal/i18n.ts). */
const send = (res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8", translate = true) => {
  res.statusCode = status; res.setHeader("Content-Type", type);
  if (translate && currentLang() === "fr") {
    if (type.startsWith("text/html") && body.includes('<html lang="en-CA">')) { body = translateHtml(body); res.setHeader("Content-Language", "fr-CA"); }
    else if (type.startsWith("text/plain")) body = translatePlain(body);
  }
  res.end(body);
};
/** Adds a cookie without dropping one already set on this response (the language cookie). */
const addCookie = (res: ServerResponse, c: string) => { const prev = res.getHeader("Set-Cookie"); res.setHeader("Set-Cookie", prev === undefined ? [c] : [...(Array.isArray(prev) ? prev : [String(prev)]), c]); };
const redirect = (res: ServerResponse, to: string) => { res.statusCode = 303; res.setHeader("Location", to); res.end(); };
const cents = (v: string | null) => { if (!v?.trim()) return undefined; const n = Number(v.replaceAll(/[$,\s]/g, "")); if (!Number.isFinite(n) || n < 0) throw new PermanentError(`not an amount: ${v}`); return Math.round(n * 100); };
const list = (v: string | null, sep = /,/) => (v ?? "").split(sep).map((s) => s.trim()).filter(Boolean);

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) throw new HttpError(415, "Unsupported form encoding");
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new HttpError(413, "Form too large"); chunks.push(c as Buffer); }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name && v) return decodeURIComponent(v);
  }
  return undefined;
}

type Action = { perm?: Permission; back: string; run: (f: URLSearchParams, s: PortalSession, tdb: TenantDb) => Promise<string | void> };

const PAGES: Record<string, (ctx: P.PortalCtx) => Promise<string>> = {
  "/": P.todayPage, "/chat": P.chatPage, "/approvals": P.approvalsPage, "/growth": P.growthPage, "/finance": P.financePage,
  "/enquiries": P.enquiriesPage, "/bookings": P.bookingsPage, "/agents": P.agentsPage, "/activity": P.activityPage,
  "/recommendations": P.recommendationsPage, "/reports": P.reportsPage, "/documents": P.documentsPage, "/settings": P.settingsPage,
  "/integrations": P.integrationsPage, "/plan": P.planPage, "/audit": P.auditPage,
};
const PAGE_PERMS: Record<string, Permission> = { "/chat": "chat", "/finance": "finance.view", "/enquiries": "customers.view", "/bookings": "customers.view", "/documents": "documents" };

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

export function createPortalServer(opts: PortalOptions): Server {
  return createServer(createPortalHandler(opts));
}

/** The control centre as a plain request listener (used by a Node server and by a Vercel Function). */
export function createPortalHandler(opts: PortalOptions): RequestListener {
  const { db, app } = opts;
  const secure = opts.secure ?? false;
  const ip = (req: IncomingMessage) => (opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "unknown";
  const deps = app.deps;

  /** The landing page, with its own content security policy (the video host is allowed for media and posters only). */
  const mediaOrigins = [opts.landing?.videoBase, opts.landing?.audioBase].filter((u): u is string => Boolean(u)).map((u) => new URL(u).origin);
  const media = [...new Set(mediaOrigins)].map((o) => ` ${o}`).join("");
  const LANDING_CSP = `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'${media}; media-src 'self'${media}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
  const sendLanding = (res: ServerResponse, lang: Lang, status: number, values: Record<string, string>, error?: string, plan?: string) => {
    res.setHeader("Content-Security-Policy", LANDING_CSP);
    res.setHeader("Content-Language", lang === "fr" ? "fr-CA" : "en-CA");
    res.setHeader("Vary", "Cookie, Accept-Language");
    return send(res, status, landingPage({ lang, signupOpen: Boolean(opts.landing?.signupOpen), videoBase: opts.landing?.videoBase, audioBase: opts.landing?.audioBase,
      frReviewedBy: opts.landing?.frReviewedBy, values, error, plan }), "text/html; charset=utf-8", false);
  };

  const ACTIONS: Record<string, Action> = {
    "/do/pause": { perm: "pause", back: "/", run: async (f, s, t) => { await setPaused(t, true, f.get("reason")?.slice(0, 200) || "paused", `user:${s.userId}`); return "All agents are paused."; } },
    "/do/resume": { perm: "resume", back: "/", run: async (_f, s, t) => { await setPaused(t, false, "resumed", `user:${s.userId}`); return "Agents resumed."; } },
    "/do/chat": { perm: "chat", back: "/chat", run: async (f, s, t) => {
      const r = await runTool(t, deps, "manager.chat", { message: (f.get("message") ?? "").slice(0, 2000), userId: s.userId });
      if (!r.ran) throw new PermanentError(r.skipped);
    } },
    "/do/approval": { perm: "approvals.decide", back: "/approvals", run: async (f, s, t) => {
      const out = await decideApproval(t, app.gateway, { approvalId: f.get("id") ?? "", userId: s.userId, role: s.role, decision: f.get("decision") === "approve" ? "approve" : "reject", note: f.get("note")?.slice(0, 500) || undefined });
      return out.status === "rejected" ? "Rejected." : `Approved: ${out.status.replaceAll("_", " ")}.`;
    } },
    "/do/payment": { perm: "payment.record", back: "/finance", run: async (f, s, t) => {
      const r = await runTool(t, deps, "invoice.record_payment", { invoiceId: f.get("invoiceId") ?? "", amountCents: cents(f.get("amount")) ?? 0, method: (f.get("method") ?? "other").slice(0, 40), receivedOn: f.get("receivedOn") ?? "", recordedBy: `user:${s.userId}` });
      if (!r.ran) throw new PermanentError(r.skipped);
      return "Payment recorded.";
    } },
    "/do/category": { perm: "finance.edit", back: "/finance", run: async (f, s, t) => { await confirmCategory(t, f.get("id") ?? "", f.get("category") ?? "", `user:${s.userId}`); return "Category confirmed."; } },
    "/do/import": { perm: "finance.edit", back: "/finance", run: async (f, _s, t) => {
      const r = await runTool(t, deps, "accounting.import_csv", { csv: f.get("csv") ?? "", source: (f.get("source") ?? "import").slice(0, 60) });
      if (!r.ran) throw new PermanentError(r.skipped);
      const o = r.output as { imported: number; skipped: number; errors: string[] };
      return `Imported ${o.imported}, skipped ${o.skipped} already imported, ${o.errors.length} unreadable rows.`;
    } },
    "/do/balance": { perm: "finance.edit", back: "/finance", run: async (f, s, t) => {
      await t.query(`insert into bai_agent_memory (agent_id, key, value) values ('financial-analyst', 'opening_balance', $1::text::jsonb)
        on conflict (tenant_id, agent_id, key) do update set value = excluded.value, updated_at = now()`, [json({ cents: cents(f.get("amount")) ?? 0, asOf: new Date().toISOString().slice(0, 10) })]);
      await tenantAudit(t, { actor: `user:${s.userId}`, action: "finance.balance_entered", subjectType: "finance" });
      return "Balance saved.";
    } },
    "/do/accept-quote": { perm: "quote.accept", back: "/enquiries", run: async (f, s, t) => {
      const local = f.get("startsAt") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new PermanentError("choose a date and time");
      const tz = (await t.query<{ time_zone: string }>("select time_zone from bai_tenants"))[0]!.time_zone;
      await acceptQuote(t, f.get("id") ?? "", zonedTime(local.slice(0, 10), local.slice(11), tz).toISOString(), `user:${s.userId}`);
      return "Acceptance recorded. The booking agent will validate the time and book it.";
    } },
    "/do/enquiry": { perm: "enquiry.add", back: "/enquiries", run: async (f, s, t) => {
      const r = await receiveEnquiry(t, {
        name: f.get("name") ?? "", ...(f.get("email") ? { email: f.get("email")! } : {}), ...(f.get("phone") ? { phone: f.get("phone")! } : {}),
        ...(f.get("serviceId") ? { serviceId: f.get("serviceId")! } : {}), description: f.get("description") ?? "", ...(f.get("area") ? { area: f.get("area")! } : {}),
        ...(f.get("desiredDate") ? { desiredDate: f.get("desiredDate")! } : {}), ...(f.get("desiredTime") ? { desiredTime: f.get("desiredTime")! } : {}),
        channel: (f.get("channel") ?? "phone") as "phone", expressMarketingConsent: f.get("consent") === "yes",
      }, `user:${s.userId}`);
      return `Enquiry ${r.ref} saved; the agents will pick it up in the next cycle.`;
    } },
    "/do/complete-job": { perm: "job.complete", back: "/bookings", run: async (f, s, t) => {
      const r = await runTool(t, deps, "jobs.complete", { jobId: f.get("id") ?? "", outcome: f.get("outcome")?.slice(0, 500) || undefined, reportedBy: `user:${s.userId}` });
      if (!r.ran) throw new PermanentError(r.skipped);
      return "Job completed. Invoicing and follow-up start in the next cycle.";
    } },
    "/do/agent": { perm: "agents.configure", back: "/agents", run: async (f, s, t) => {
      const autonomy = f.get("autonomy");
      if (!["draft_only", "approval", "rules", "autonomous"].includes(autonomy ?? "")) throw new PermanentError("unknown autonomy");
      await configureAgent(t, f.get("id") ?? "", { enabled: f.get("enabled") === "true", autonomy: autonomy as "approval" }, `user:${s.userId}`);
      return "Agent updated.";
    } },
    "/do/recommendation": { perm: "recommendations.decide", back: "/recommendations", run: async (f, s, t) => {
      const status = f.get("status") === "accepted" ? "accepted" : "dismissed";
      await t.query("update bai_recommendations set status = $2 where id = $1 and status = 'open'", [f.get("id"), status]);
      await tenantAudit(t, { actor: `user:${s.userId}`, action: `recommendation.${status}`, subjectType: "recommendation", subjectId: f.get("id") });
    } },
    "/do/document": { perm: "documents", back: "/documents", run: async (f, s, t) => {
      const r = await runTool(t, deps, "admin.store_document", { name: f.get("name") ?? "", kind: f.get("kind") ?? "document", text: f.get("text") ?? "", uploadedBy: `user:${s.userId}` });
      if (!r.ran) throw new PermanentError(r.skipped);
      const sig = (r.output as { injectionSignals: string[] }).injectionSignals;
      return sig.length ? "Saved. Note: the document contains text that looks like instructions to an AI; agents will treat it as data only." : "Document saved.";
    } },
    "/do/profile": { perm: "profile.edit", back: "/settings", run: async (f, s, t) => {
      const hours: Record<string, [string, string]> = {};
      for (const d of ["1", "2", "3", "4", "5", "6", "7"]) { const o = f.get(`open${d}`); const c = f.get(`close${d}`); if (o && c) hours[d] = [o, c]; }
      const r = await saveProfile(t, {
        identity: { description: f.get("description") || undefined, province: f.get("province") || undefined, serviceAreas: list(f.get("serviceAreas")),
          email: f.get("email") || undefined, phone: f.get("phone") || undefined, mailingAddress: f.get("mailingAddress") || undefined, hours },
        objectives: { monthlyRevenueTargetCents: cents(f.get("monthlyTarget")), growthPriorities: list(f.get("growthPriorities"), /\n/) },
        operations: { cancellationPolicy: f.get("cancellationPolicy") || undefined, paymentMethods: list(f.get("paymentMethods")), bookingLeadTimeHours: f.get("leadTime") ? Number(f.get("leadTime")) : undefined },
        financial: { gstHstRegistered: f.get("registered") === "yes" ? true : f.get("registered") === "no" ? false : undefined },
      }, `user:${s.userId}`);
      return `Profile saved (${r.completeness}% complete).`;
    } },
    "/do/service": { perm: "profile.edit", back: "/settings", run: async (f, s, t) => {
      await upsertService(t, { name: f.get("name") ?? "", category: f.get("category") ?? "", description: f.get("description") ?? "", pricingUnit: (f.get("pricingUnit") ?? "fixed") as "fixed",
        ...(f.get("unitLabel") ? { unitLabel: f.get("unitLabel")! } : {}), priceCents: cents(f.get("price")) ?? null, minChargeCents: cents(f.get("minCharge")) ?? 0, travelFeeCents: cents(f.get("travelFee")) ?? 0,
        durationMinutes: f.get("duration") ? Number(f.get("duration")) : null, ...(f.get("requiredSkill") ? { requiredSkill: f.get("requiredSkill")! } : {}),
        seasonalMonths: list(f.get("season")).map(Number), limitations: f.get("limitations") ?? "" }, `user:${s.userId}`);
      return "Service saved.";
    } },
    "/do/employee": { perm: "profile.edit", back: "/settings", run: async (f, s, t) => {
      const w: [string, string] = [f.get("from") || "08:00", f.get("to") || "17:00"];
      await addEmployee(t, { name: f.get("name") ?? "", skills: list(f.get("skills")), availability: { "1": w, "2": w, "3": w, "4": w, "5": w, ...(f.get("saturday") === "yes" ? { "6": w } : {}) } }, `user:${s.userId}`);
      return "Team member added.";
    } },
    "/do/policy": { perm: "policy.edit", back: "/settings", run: async (f, s, t) => {
      const shape = PolicySchema.shape;
      const patch: Record<string, unknown> = {};
      for (const [k, def] of Object.entries(shape)) {
        if (k === "minutes_saved" || k === "campaign_mode") continue;
        const inner = (def as { def?: { innerType?: { type?: string } } }).def?.innerType?.type;
        if (inner === "boolean") patch[k] = f.get(k) === "true";
        else if (f.has(k)) patch[k] = k.endsWith("_cents") ? cents(f.get(k)) ?? 0 : Number(f.get(k));
      }
      await updatePolicy(t, patch, `user:${s.userId}`);
      return "Operating rules saved.";
    } },
    "/do/plan": { perm: "plan.change", back: "/plan", run: async (f, s, t) => {
      const r = await changePlan(t, f.get("plan") ?? "", `user:${s.userId}`);
      return r.disabled.length ? `Plan changed. Switched off: ${r.disabled.join(", ")}.` : "Plan changed. Billing is not connected, so nothing was charged.";
    } },
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    headers(res, secure);
    const url = new URL(req.url ?? "/", "http://portal.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    if (path === "/static/landing.css" && method === "GET") { res.setHeader("Cache-Control", "public, max-age=3600"); return send(res, 200, LANDING_CSS, "text/css; charset=utf-8"); }
    if (path === "/static/manrope.woff2" && method === "GET") { res.setHeader("Cache-Control", "public, max-age=604800, immutable"); res.statusCode = 200; res.setHeader("Content-Type", "font/woff2"); return res.end(MANROPE); }
    if (path === "/static/landing.js" && method === "GET") { res.setHeader("Cache-Control", "public, max-age=3600"); return send(res, 200, LANDING_JS, "text/javascript; charset=utf-8"); }
    const caption = path.match(/^\/captions\/(en|fr)\/([a-z-]{2,40})\.vtt$/);
    if (caption && method === "GET") {
      const e = findExplainer(caption[1] as Lang, caption[2]!);
      if (!e) return send(res, 404, "Not found", "text/plain");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return send(res, 200, captionsVtt(caption[1] as Lang, e.lines), "text/vtt; charset=utf-8");
    }
    if (path.startsWith("/captions/")) return send(res, 404, "Not found", "text/plain");
    // Landing photos and videos. On Vercel the CDN serves public/media itself; a long-running host reads them here.
    const mediaFile = path.match(/^\/media\/([a-z0-9-]{1,80}\.(jpg|webm|mp4))$/);
    if (mediaFile && (method === "GET" || method === "HEAD")) {
      try {
        const body = await readFile(join(process.cwd(), "public", "media", mediaFile[1]!));
        res.setHeader("Cache-Control", "public, max-age=604800");
        res.statusCode = 200; res.setHeader("Content-Type", { jpg: "image/jpeg", webm: "video/webm", mp4: "video/mp4" }[mediaFile[2] as "jpg"]);
        return res.end(method === "HEAD" ? undefined : body);
      } catch { return send(res, 404, "Not found", "text/plain"); }
    }
    if (path === "/static/app.css" && method === "GET") { res.setHeader("Cache-Control", "public, max-age=3600"); return send(res, 200, CSS, "text/css; charset=utf-8"); }
    if (path === "/healthz") return send(res, 200, JSON.stringify({ ok: true }), "application/json");

    // Public one-click unsubscribe for a business's customer (signed link; no session).
    const unsub = path.match(/^\/u\/([A-Za-z0-9_.-]{20,800})$/);
    if (unsub) {
      const v = verifyUnsubscribeToken(unsub[1]!, opts.linkSecret);
      if (!v) return send(res, 400, P.bilingualPage("Link not recognised", "This unsubscribe link is not valid. Please contact the business directly."));
      const name = await withTenant(db, v.tenantId, async (t) => (await t.query<{ name: string }>("select name from bai_tenants"))[0]?.name).catch(() => undefined);
      if (!name) return send(res, 404, P.bilingualPage("Link not recognised", "This business is no longer on CONARO."));
      if (method === "POST") {
        await withTenant(db, v.tenantId, (t) => unsubscribeCustomer(t, v.email, "unsubscribe-link"));
        return send(res, 200, P.bilingualPage("You're unsubscribed", `${v.email} will not receive marketing messages from ${name} again. / Vous ne recevrez plus de messages de marketing de ${name}.`));
      }
      return send(res, 200, P.bilingualPage("Unsubscribe", `Stop marketing messages from ${name} to ${v.email}?`, P.raw(`<form method="post"><button type="submit">Unsubscribe / Se désabonner</button></form>`)));
    }

    // Scheduled agents' cycle. Vercel Cron sends "Authorization: Bearer $CRON_SECRET" with a GET.
    if (path === "/api/cron/tick") {
      if (method !== "GET") return send(res, 405, JSON.stringify({ error: "GET only" }), "application/json");
      if (!opts.cron) return send(res, 503, JSON.stringify({ error: "the scheduled cycle is not set up (CRON_SECRET)" }), "application/json");
      const expected = Buffer.from(`Bearer ${opts.cron.secret}`);
      const given = Buffer.from(String(req.headers.authorization ?? ""));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(res, 401, JSON.stringify({ error: "unauthorised" }), "application/json");
      const result = await opts.cron.run();
      return send(res, 200, JSON.stringify(result), "application/json");
    }

    // Signed, read-only endpoints for the other CONARO applications (no session: the signature is the credential).
    if (path.startsWith("/api/link/v1/")) {
      if (method !== "GET") return send(res, 405, JSON.stringify({ error: "GET only" }), "application/json");
      const h: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") h[k] = v;
      const pathAndQuery = url.pathname + url.search;
      if (path === "/api/link/v1/summary") {
        const v = await verifyInbound(db, opts.bosLinkSecret, "bos", { method, pathAndQuery, headers: h });
        if (!v.ok) return send(res, v.status, JSON.stringify({ error: v.reason }), "application/json");
        return send(res, 200, JSON.stringify(await buildSummary(db)), "application/json");
      }
      if (path === "/api/link/v1/handshake") {
        const peer = url.searchParams.get("peer") === "bos" ? "bos" : "marketplace";
        const v = await verifyInbound(db, peer === "bos" ? opts.bosLinkSecret : opts.marketplaceLinkSecret, peer, { method, pathAndQuery, headers: h });
        if (!v.ok) return send(res, v.status, JSON.stringify({ error: v.reason }), "application/json");
        return send(res, 200, JSON.stringify({ ok: true, app: "conaro-business-ai", version: LINK_VERSION, peer, at: new Date().toISOString() }), "application/json");
      }
      return send(res, 404, JSON.stringify({ error: "not found" }), "application/json");
    }

    // Sign-in handed over from the marketplace (single-use, 2-minute token; members only).
    if (path === "/sso" && method === "GET") {
      const r = await verifySsoToken(db, opts.marketplaceLinkSecret, url.searchParams.get("t") ?? "");
      if (!r.ok) return send(res, 401, P.publicPage("Could not sign you in", r.reason));
      const token = await createSession(db, r.userId, r.tenantId, { ip: ip(req), via: "marketplace" });
      addCookie(res, `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`);
      return redirect(res, "/");
    }

    if (method === "POST") {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (origin && host && new URL(origin).host !== host) return send(res, 403, "Cross-origin form posts are refused.", "text/plain");
      if (origin === "null") return send(res, 403, "Opaque-origin form posts are refused.", "text/plain");
    }

    if (path === "/setup") {
      if (method === "GET") return send(res, 200, setupPage(Boolean(opts.setupKey)));
      if (method !== "POST") return send(res, 405, "Method not allowed", "text/plain");
      const f = await readForm(req);
      if (!opts.setupKey) return send(res, 403, setupPage(false));
      const recent = await db.query<{ n: number }>("select count(*)::int n from bai_login_attempts where email = '[setup]' and not success and attempted_at > now() - interval '15 minutes'");
      if ((recent[0]?.n ?? 0) >= 5) return send(res, 429, setupPage(true, html`<div class="error" role="alert">Too many wrong keys. Try again in 15 minutes.</div>`));
      const given = Buffer.from(f.get("key") ?? ""); const expected = Buffer.from(opts.setupKey);
      const ok = given.length === expected.length && timingSafeEqual(given, expected);
      await db.query("insert into bai_login_attempts (email, ip, success) values ('[setup]', $1, $2)", [ip(req), ok]);
      if (!ok) return send(res, 401, setupPage(true, html`<div class="error" role="alert">That set-up key is not right.</div>`));
      try {
        const action = f.get("action");
        if (action === "demo") {
          const r = await seedDemo(db, deps);
          return send(res, 200, setupPage(true, html`<div class="flash" role="status">${r.created.length ? `Created ${r.created.length} demo businesses.` : ""} ${r.reset.length ? `New passwords for ${r.reset.length} existing demo businesses (the old ones no longer work).` : ""} Copy these now: they are shown only once.</div>
${P.credentialsTable(r.credentials)}`));
        }
        if (action === "remove-demo") {
          const n = await removeDemo(db);
          return send(res, 200, setupPage(true, html`<div class="flash" role="status">${n ? `Closed ${n} demo businesses and disabled their logins. Their records are kept.` : "No open demo businesses."}</div>`));
        }
        if (action === "business") {
          const r = await createTenant(db, { name: f.get("name") ?? "", slug: f.get("slug") ?? "", industry: f.get("industry") ?? "", plan: f.get("plan") ?? "",
            owner: { email: f.get("email") ?? "", name: f.get("owner") ?? "", password: f.get("password") ?? "" } }, "system:setup");
          return send(res, 200, setupPage(true, html`<div class="flash" role="status">Created ${f.get("name") ?? ""}. Sign in at <a href="/login">/login</a> with the owner's email and the password you chose (workspace ${r.tenantId.slice(0, 8)}…).</div>`));
        }
        return send(res, 400, setupPage(true, html`<div class="error" role="alert">Unknown action.</div>`));
      } catch (err) {
        if (err instanceof PermanentError || err instanceof ZodError) return send(res, 400, setupPage(true, html`<div class="error" role="alert">${message(err)}</div>`));
        throw err;
      }
    }

    if (path === "/signup" && method === "POST") {
      const f = await readForm(req);
      const lang: Lang = f.get("lang") === "fr" ? "fr" : url.searchParams.get("lang") === "fr" ? "fr" : "en";
      if (!opts.landing?.signupOpen) return sendLanding(res, lang, 403, {}, "Sign-ups are paused at the moment.");
      const form = Object.fromEntries([...f.entries()].filter(([k]) => k !== "password")) as Record<string, string>;
      try {
        const r = await signUp(db, Object.fromEntries(f.entries()), ip(req));
        const token = await createSession(db, r.userId, r.tenantId, { ip: ip(req), via: "password" });
        addCookie(res, `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`);
        return redirect(res, `/settings?ok=${encodeURIComponent("Welcome! Your pilot workspace is ready. Start with your services, prices and hours below.")}#main`);
      } catch (err) {
        if (err instanceof ZodError) return sendLanding(res, lang, 400, form, [...new Set(err.issues.map((i) => i.message))].join(" | "));
        if (err instanceof PermanentError) return sendLanding(res, lang, 400, form, err.message);
        throw err;
      }
    }

    if (path === "/login") {
      if (method === "GET") return send(res, 200, P.loginPage());
      if (method === "POST") {
        const f = await readForm(req);
        const r = await portalLogin(db, f.get("email") ?? "", f.get("password") ?? "", ip(req));
        if (!r.ok) return send(res, r.reason === "rate_limited" ? 429 : 401, P.loginPage(r.reason === "rate_limited" ? "Too many attempts. Try again in 15 minutes." : "Email or password not recognised."));
        addCookie(res, `${COOKIE}=${encodeURIComponent(r.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`);
        return redirect(res, "/");
      }
    }

    const token = cookie(req, COOKIE);
    const session = await portalSession(db, token);
    // Signed-out visitors to the home page see the landing page; signed-in owners get their control centre.
    if (!session && path === "/" && (method === "GET" || method === "HEAD") && opts.landing) return sendLanding(res, currentLang(), 200, {}, undefined, url.searchParams.get("plan") ?? undefined);
    if (!session) return method === "GET" ? redirect(res, "/login") : send(res, 401, "Sign in again.", "text/plain");

    if (method === "POST") {
      const f = await readForm(req);
      if (!csrfOk(session, f.get("_csrf"))) return send(res, 403, "Form expired. Go back, reload and try again.", "text/plain");
      if (path === "/logout") {
        await portalLogout(db, token);
        addCookie(res, `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
        return redirect(res, "/login");
      }
      if (path === "/do/member") {
        if (!can(session.role, "members.add")) return send(res, 403, "Not allowed for your role.", "text/plain");
        try {
          await addMember(db, session.tenantId, { email: f.get("email") ?? "", name: f.get("name") ?? "", password: f.get("password") ?? "", role: (f.get("role") ?? "viewer") as "viewer" }, `user:${session.userId}`);
          return redirect(res, `/settings?ok=${encodeURIComponent("Person added.")}`);
        } catch (err) { return redirect(res, `/settings?err=${encodeURIComponent(message(err))}`); }
      }
      const action = ACTIONS[path];
      if (!action) return send(res, 404, "Not found", "text/plain");
      if (action.perm && !can(session.role, action.perm)) return send(res, 403, "Not allowed for your role.", "text/plain");
      try {
        const msg = await withTenant(db, session.tenantId, (t) => action.run(f, session, t));
        return redirect(res, `${action.back}?ok=${encodeURIComponent(msg || "Saved.")}`);
      } catch (err) {
        if (err instanceof PermanentError || err instanceof ZodError) return redirect(res, `${action.back}?err=${encodeURIComponent(message(err))}`);
        throw err;
      }
    }

    if (method !== "GET") return send(res, 405, "Method not allowed", "text/plain");
    const page = PAGES[path];
    if (!page) return send(res, 404, "Not found", "text/plain");
    const perm = PAGE_PERMS[path];
    if (perm && !can(session.role, perm)) return send(res, 403, "Not allowed for your role.", "text/plain");
    const body = await withTenant(db, session.tenantId, async (tdb) => {
      const tenant = (await tdb.query<P.PortalCtx["tenant"]>("select name, industry, paused, paused_reason, time_zone, is_demo from bai_tenants"))[0]!;
      return page({ session, tdb, deps, path, query: url.searchParams, flash: url.searchParams.get("ok")?.slice(0, 300), error: url.searchParams.get("err")?.slice(0, 300), tenant });
    });
    return send(res, 200, body);
  }

  return (req, res) => {
    // The page language: ?lang= (remembered), then the remembered choice, then the browser's preference.
    const q = /[?&]lang=(en|fr)(?:&|$)/.exec(req.url ?? "")?.[1] ?? null;
    const l = resolveLang(q, cookie(req, "bai_lang"), req.headers["accept-language"]);
    if (l.remember) res.setHeader("Set-Cookie", langCookie(l.lang, secure));
    res.setHeader("Vary", "Cookie, Accept-Language");
    runInLang(l.lang, () => handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : err instanceof AccessDeniedError ? 403 : 500;
      if (status === 500) console.error("[business-ai portal]", err);
      if (!res.headersSent) send(res, status, status === 500 ? "Something went wrong. It has been logged." : (err as Error).message, "text/plain");
      else res.end();
    }));
  };
}

function message(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300);
  return (err as Error).message.slice(0, 300);
}
