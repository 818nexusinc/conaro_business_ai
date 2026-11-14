import { timingSafeEqual } from "node:crypto";
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

import { CSS } from "../generated/assets.ts";
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

const send = (res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8") => { res.statusCode = status; res.setHeader("Content-Type", type); res.end(body); };
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

export function createPortalServer(opts: PortalOptions): Server {
  const { db, app } = opts;
  const secure = opts.secure ?? false;
  const ip = (req: IncomingMessage) => (opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "unknown";
  const deps = app.deps;

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
    if (path === "/static/app.css" && method === "GET") { res.setHeader("Cache-Control", "public, max-age=3600"); return send(res, 200, CSS, "text/css; charset=utf-8"); }
    if (path === "/healthz") return send(res, 200, JSON.stringify({ ok: true }), "application/json");

    // Public one-click unsubscribe for a business's customer (signed link; no session).
    const unsub = path.match(/^\/u\/([A-Za-z0-9_.-]{20,800})$/);
    if (unsub) {
      const v = verifyUnsubscribeToken(unsub[1]!, opts.linkSecret);
      if (!v) return send(res, 400, P.publicPage("Link not recognised", "This unsubscribe link is not valid. Please contact the business directly."));
      const name = await withTenant(db, v.tenantId, async (t) => (await t.query<{ name: string }>("select name from bai_tenants"))[0]?.name).catch(() => undefined);
      if (!name) return send(res, 404, P.publicPage("Link not recognised", "This business is no longer on CONARO."));
      if (method === "POST") {
        await withTenant(db, v.tenantId, (t) => unsubscribeCustomer(t, v.email, "unsubscribe-link"));
        return send(res, 200, P.publicPage("You're unsubscribed", `${v.email} will not receive marketing messages from ${name} again. / Vous ne recevrez plus de messages de marketing de ${name}.`));
      }
      return send(res, 200, P.publicPage("Unsubscribe", `Stop marketing messages from ${name} to ${v.email}?`, P.raw(`<form method="post"><button type="submit">Unsubscribe / Se désabonner</button></form>`)));
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
      res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`);
      return redirect(res, "/");
    }

    if (method === "POST") {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (origin && host && new URL(origin).host !== host) return send(res, 403, "Cross-origin form posts are refused.", "text/plain");
      if (origin === "null") return send(res, 403, "Opaque-origin form posts are refused.", "text/plain");
    }

    if (path === "/login") {
      if (method === "GET") return send(res, 200, P.loginPage());
      if (method === "POST") {
        const f = await readForm(req);
        const r = await portalLogin(db, f.get("email") ?? "", f.get("password") ?? "", ip(req));
        if (!r.ok) return send(res, r.reason === "rate_limited" ? 429 : 401, P.loginPage(r.reason === "rate_limited" ? "Too many attempts. Try again in 15 minutes." : "Email or password not recognised."));
        res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(r.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`);
        return redirect(res, "/");
      }
    }

    const token = cookie(req, COOKIE);
    const session = await portalSession(db, token);
    if (!session) return method === "GET" ? redirect(res, "/login") : send(res, 401, "Sign in again.", "text/plain");

    if (method === "POST") {
      const f = await readForm(req);
      if (!csrfOk(session, f.get("_csrf"))) return send(res, 403, "Form expired. Go back, reload and try again.", "text/plain");
      if (path === "/logout") {
        await portalLogout(db, token);
        res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
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
      const tenant = (await tdb.query<P.PortalCtx["tenant"]>("select name, industry, paused, paused_reason, time_zone from bai_tenants"))[0]!;
      return page({ session, tdb, deps, path, query: url.searchParams, flash: url.searchParams.get("ok")?.slice(0, 300), error: url.searchParams.get("err")?.slice(0, 300), tenant });
    });
    return send(res, 200, body);
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : err instanceof AccessDeniedError ? 403 : 500;
      if (status === 500) console.error("[business-ai portal]", err);
      if (!res.headersSent) send(res, status, status === 500 ? "Something went wrong. It has been logged." : (err as Error).message, "text/plain");
      else res.end();
    });
  });
}

function message(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300);
  return (err as Error).message.slice(0, 300);
}
