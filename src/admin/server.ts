/**
 * /admin: the platform admin. Mounted by the portal handler before any business-owner routing.
 * Security: own cookie (Path=/admin... and the editor's API under /admin), SameSite=Strict, CSRF token on every
 * change, role checks per action, rate-limited sign-in, everything recorded in bai_admin_audit.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "../shared/db.ts";
import { PermanentError } from "../shared/errors.ts";
import { html } from "../shared/html.ts";
import { ADMIN_COOKIE, ADMIN_SESSION_HOURS, adminAudit, adminCan, adminCsrfOk, adminLogin, adminLogout, adminSession, createAdmin, ownerExists,
  type AdminPermission, type AdminRole, type AdminSession } from "./auth.ts";
import { contentHistory, discardDrafts, draftContent, getImage, pendingChanges, publish, restoreVersion, saveDraft, saveImage, type ContentLang } from "./content.ts";
import * as A from "./pages.ts";
import { ADMIN_CSS, EDITOR_CSS, EDITOR_JS } from "../generated/assets.ts";

export interface AdminHttp {
  send: (res: ServerResponse, status: number, body: string | Buffer, type?: string) => void;
  redirect: (res: ServerResponse, to: string) => void;
  readForm: (req: IncomingMessage) => Promise<URLSearchParams>;
  readRaw: (req: IncomingMessage, max: number) => Promise<Buffer>;
  cookie: (req: IncomingMessage, name: string) => string | undefined;
  addCookie: (res: ServerResponse, c: string) => void;
  ip: (req: IncomingMessage) => string;
  secure: boolean;
  setupKey?: string | undefined;
  /** The landing page in the editor: draft content, editing marks. */
  editorPage: (lang: "en" | "fr", content: Record<string, string>, editing: { csrf: string; pending: number; canPublish: boolean }) => Promise<string>;
  /** Extra admin sections (plans, billing, agents...) registered by later modules. */
  extra?: ((ctx: { req: IncomingMessage; res: ServerResponse; path: string; method: string; url: URL; session: AdminSession; form?: URLSearchParams }) => Promise<boolean>)[];
}

const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const EDITOR_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob:; media-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const sameKey = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function adminRoutes(db: Db, h: AdminHttp) {
  const cookieLine = (token: string, maxAge: number) => `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${h.secure ? "; Secure" : ""}`;
  const page = (res: ServerResponse, status: number, body: string, csp = ADMIN_CSP) => { res.setHeader("Content-Security-Policy", csp); h.send(res, status, body); };
  const jsonOut = (res: ServerResponse, status: number, body: unknown) => h.send(res, status, JSON.stringify(body), "application/json");
  const deny = (res: ServerResponse) => h.send(res, 403, "Not allowed for your admin role.", "text/plain");

  return async function route(req: IncomingMessage, res: ServerResponse, path: string, method: string, url: URL): Promise<boolean> {
    // Public: images uploaded in the editor (published pages reference them).
    const media = path.match(/^\/media\/u\/([0-9a-f-]{36})$/);
    if (media && (method === "GET" || method === "HEAD")) {
      const img = await getImage(db, media[1]!);
      if (!img) { h.send(res, 404, "Not found", "text/plain"); return true; }
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      h.send(res, 200, method === "HEAD" ? "" : img.bytes, img.mime); return true;
    }
    if (path !== "/admin" && !path.startsWith("/admin/")) return false;
    if (method === "POST") {
      const origin = req.headers.origin; const host = req.headers.host;
      if (origin === "null" || (origin && host && new URL(origin).host !== host)) { h.send(res, 403, "Cross-origin requests are refused.", "text/plain"); return true; }
    }

    if (path === "/admin/static/admin.css") { res.setHeader("Cache-Control", "public, max-age=3600"); h.send(res, 200, ADMIN_CSS, "text/css; charset=utf-8"); return true; }
    if (path === "/admin/static/editor.css") { res.setHeader("Cache-Control", "public, max-age=3600"); h.send(res, 200, EDITOR_CSS, "text/css; charset=utf-8"); return true; }
    if (path === "/admin/static/editor.js") { res.setHeader("Cache-Control", "public, max-age=3600"); h.send(res, 200, EDITOR_JS, "text/javascript; charset=utf-8"); return true; }
    res.setHeader("X-Robots-Tag", "noindex");

    // ---------------------------------------------------------------- sign-in and first owner
    if (path === "/admin/login") {
      const firstOwner = !(await ownerExists(db));
      if (method === "GET") { page(res, 200, A.adminLoginPage({ firstOwner, setupKeyConfigured: Boolean(h.setupKey) })); return true; }
      if (method === "POST") {
        const f = await h.readForm(req);
        const r = await adminLogin(db, f.get("email") ?? "", f.get("password") ?? "", h.ip(req));
        if (!r.ok) { page(res, r.reason === "rate_limited" ? 429 : 401, A.adminLoginPage({ firstOwner, setupKeyConfigured: Boolean(h.setupKey), error: r.reason === "rate_limited" ? "Too many attempts. Try again in 15 minutes." : "Email or password not recognised." })); return true; }
        h.addCookie(res, cookieLine(r.token, ADMIN_SESSION_HOURS * 3600)); h.redirect(res, "/admin"); return true;
      }
    }
    if (path === "/admin/first-owner" && method === "POST") {
      const f = await h.readForm(req);
      if (await ownerExists(db)) { h.redirect(res, "/admin/login"); return true; }
      const key = f.get("key") ?? "";
      if (!h.setupKey || !sameKey(key, h.setupKey)) {
        await db.query("insert into bai_login_attempts (email, ip, success) values ('[admin-setup]', $1, false)", [h.ip(req)]);
        page(res, 401, A.adminLoginPage({ firstOwner: true, setupKeyConfigured: Boolean(h.setupKey), error: "That set-up key is not right." })); return true;
      }
      try {
        await createAdmin(db, { email: f.get("email") ?? "", name: f.get("name") ?? "", password: f.get("password") ?? "", role: "owner" }, "system:first-owner");
      } catch (err) {
        if (err instanceof PermanentError) { page(res, 400, A.adminLoginPage({ firstOwner: true, setupKeyConfigured: true, error: err.message })); return true; }
        throw err;
      }
      const r = await adminLogin(db, f.get("email") ?? "", f.get("password") ?? "", h.ip(req));
      if (r.ok) h.addCookie(res, cookieLine(r.token, ADMIN_SESSION_HOURS * 3600));
      h.redirect(res, "/admin"); return true;
    }

    const token = h.cookie(req, ADMIN_COOKIE);
    const session = await adminSession(db, token);
    if (!session) {
      if (method === "GET") h.redirect(res, "/admin/login"); else h.send(res, 401, "Sign in again.", "text/plain");
      return true;
    }
    const need = (p: AdminPermission) => adminCan(session.role, p);
    const ctx = (flash?: string | null, error?: string | null): A.AdminCtx => ({ session, path, flash: flash ?? undefined, error: error ?? undefined });

    // ---------------------------------------------------------------- editor JSON API (CSRF in a header)
    if (path.startsWith("/admin/api/")) {
      if (method !== "POST") { h.send(res, 405, "POST only", "text/plain"); return true; }
      if (!adminCsrfOk(session, String(req.headers["x-csrf"] ?? ""))) { jsonOut(res, 403, { error: "Session expired: reload the page." }); return true; }
      try {
        if (path === "/admin/api/content") {
          if (!need("site.edit")) return deny(res), true;
          const body = JSON.parse((await h.readRaw(req, 64_000)).toString("utf8")) as { key?: unknown; lang?: unknown; value?: unknown };
          const value = body.value === null ? null : String(body.value ?? "");
          await saveDraft(db, session, String(body.key ?? ""), String(body.lang ?? "") as ContentLang, value);
          jsonOut(res, 200, { ok: true, pending: (await pendingChanges(db)).length }); return true;
        }
        if (path === "/admin/api/image") {
          if (!need("site.edit")) return deny(res), true;
          const id = await saveImage(db, session, String(req.headers["x-filename"] ?? "image"), await h.readRaw(req, 3_200_000));
          jsonOut(res, 200, { ok: true, id, url: `/media/u/${id}` }); return true;
        }
        if (path === "/admin/api/publish") {
          if (!need("site.publish")) return deny(res), true;
          jsonOut(res, 200, { ok: true, published: await publish(db, session) }); return true;
        }
      } catch (err) {
        if (err instanceof PermanentError || err instanceof SyntaxError) { jsonOut(res, 400, { error: err.message }); return true; }
        throw err;
      }
      jsonOut(res, 404, { error: "not found" }); return true;
    }

    // ---------------------------------------------------------------- the click-to-edit editor
    if (path === "/admin/editor" && method === "GET") {
      if (!need("site.edit")) return deny(res), true;
      const lang = url.searchParams.get("lang") === "fr" ? "fr" : "en";
      const body = await h.editorPage(lang, await draftContent(db, lang), { csrf: session.csrf, pending: (await pendingChanges(db)).length, canPublish: need("site.publish") });
      page(res, 200, body, EDITOR_CSP); return true;
    }

    // ---------------------------------------------------------------- form actions
    if (method === "POST") {
      const f = await h.readForm(req);
      if (!adminCsrfOk(session, f.get("_csrf"))) { h.send(res, 403, "Form expired. Go back, reload and try again.", "text/plain"); return true; }
      if (path === "/admin/logout") {
        await adminLogout(db, token);
        h.addCookie(res, cookieLine("", 0)); h.redirect(res, "/admin/login"); return true;
      }
      const back = (to: string, msg: string, isErr = false) => h.redirect(res, `${to}?${isErr ? "err" : "ok"}=${encodeURIComponent(msg)}`);
      try {
        if (path === "/admin/do/publish") { if (!need("site.publish")) return deny(res), true; const n = await publish(db, session); back("/admin/site", `Published ${n} change${n === 1 ? "" : "s"}.`); return true; }
        if (path === "/admin/do/discard") { if (!need("site.edit")) return deny(res), true; const n = await discardDrafts(db, session); back("/admin/site", `Discarded ${n} draft${n === 1 ? "" : "s"}.`); return true; }
        if (path === "/admin/do/restore") {
          if (!need("site.edit")) return deny(res), true;
          const r = await restoreVersion(db, session, Number(f.get("id")));
          back("/admin/site", `Restored ${r.key} (${r.lang}) as a draft. Publish to make it live.`); return true;
        }
        if (path === "/admin/do/admin") {
          if (!need("admins.manage")) return deny(res), true;
          const role = (["owner", "editor", "viewer"].includes(f.get("role") ?? "") ? f.get("role") : "viewer") as AdminRole;
          await createAdmin(db, { email: f.get("email") ?? "", name: f.get("name") ?? "", password: f.get("password") ?? "", role }, `admin:${session.adminId}`);
          back("/admin/admins", "Admin added."); return true;
        }
        for (const x of h.extra ?? []) if (await x({ req, res, path, method, url, session, form: f })) return true;
      } catch (err) {
        if (err instanceof PermanentError) { back(path.startsWith("/admin/do/admin") ? "/admin/admins" : (f.get("_back") ?? "/admin"), err.message, true); return true; }
        throw err;
      }
      h.send(res, 404, "Not found", "text/plain"); return true;
    }

    // ---------------------------------------------------------------- pages
    const flash = url.searchParams.get("ok")?.slice(0, 300); const error = url.searchParams.get("err")?.slice(0, 300);
    if (path === "/admin") {
      const one = async (q: string) => Number((await db.query<{ n: number }>(q))[0]?.n ?? 0);
      page(res, 200, A.overviewPage(ctx(flash, error), {
        tenants: await one("select count(*)::int n from bai_tenants where status <> 'cancelled'"),
        demo: await one("select count(*)::int n from bai_tenants where status <> 'cancelled' and is_demo"),
        byPlan: await db.query("select s.plan, count(*)::int n from bai_subscriptions s join bai_tenants t on t.id = s.tenant_id where not t.is_demo and t.status <> 'cancelled' group by 1 order by 1"),
        signups7: await one("select count(*)::int n from bai_signups where created_at > now() - interval '7 days'"),
        signups30: await one("select count(*)::int n from bai_signups where created_at > now() - interval '30 days'"),
        pending: (await pendingChanges(db)).length,
        proposals: await one("select count(*)::int n from information_schema.tables where table_name = 'bai_platform_proposals'") ? await one("select count(*)::int n from bai_platform_proposals where status = 'pending'") : 0,
        billing: await db.query("select s.billing_status status, count(*)::int n from bai_subscriptions s join bai_tenants t on t.id = s.tenant_id where not t.is_demo group by 1 order by 1"),
      }));
      return true;
    }
    if (path === "/admin/site") { page(res, 200, A.sitePage(ctx(flash, error), { pending: await pendingChanges(db), history: await contentHistory(db) })); return true; }
    if (path === "/admin/admins") {
      if (!need("admins.manage")) return deny(res), true;
      page(res, 200, A.adminsPage(ctx(flash, error), await db.query("select email, display_name, role, status, created_at from bai_platform_admins order by created_at"))); return true;
    }
    if (path === "/admin/audit") { page(res, 200, A.auditPage(ctx(flash, error), await db.query("select occurred_at, actor, action, subject, detail from bai_admin_audit order by id desc limit 300"))); return true; }
    for (const x of h.extra ?? []) if (await x({ req, res, path, method, url, session })) return true;
    if (["/admin/plans", "/admin/billing", "/admin/businesses", "/admin/agents"].includes(path)) {
      page(res, 200, A.placeholderPage(ctx(flash, error), path.slice(7).replace(/^\w/, (c) => c.toUpperCase()), "This section is being built."));
      return true;
    }
    h.send(res, 404, "Not found", "text/plain"); return true;
  };
}

export { adminAudit, html };
