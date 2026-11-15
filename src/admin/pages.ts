/** Pages of the platform admin (/admin). Server-rendered, no inline scripts or styles (CSP). */
import { html, raw, table, badge, type Html } from "../shared/html.ts";
import { adminCan, type AdminSession } from "./auth.ts";

export interface AdminCtx { session: AdminSession; path: string; flash?: string | undefined; error?: string | undefined }

const NAV: { href: string; label: string; perm?: Parameters<typeof adminCan>[1] }[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/site", label: "Website" },
  { href: "/admin/plans", label: "Plans and pricing" },
  { href: "/admin/billing", label: "Billing (Stripe)" },
  { href: "/admin/businesses", label: "Businesses" },
  { href: "/admin/agents", label: "Admin agents" },
  { href: "/admin/admins", label: "Admins", perm: "admins.manage" },
  { href: "/admin/audit", label: "Audit log" },
];

export const csrfField = (s: AdminSession) => html`<input type="hidden" name="_csrf" value="${s.csrf}">`;

export function adminLayout(ctx: AdminCtx, title: string, body: Html): string {
  const current = (href: string) => (href === "/admin" ? ctx.path === "/admin" : ctx.path.startsWith(href));
  return html`<!doctype html>
<html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Admin · CONARO Business AI</title><link rel="stylesheet" href="/static/app.css"><link rel="stylesheet" href="/admin/static/admin.css"><meta name="robots" content="noindex"></head>
<body class="admin"><a class="skip" href="#main">Skip to content</a><div class="shell">
<nav class="side" aria-label="Admin sections"><div class="brand">CONARO</div><div class="tag">Business AI · Platform admin</div><div class="links">
${NAV.filter((n) => !n.perm || adminCan(ctx.session.role, n.perm)).map((n) => html`<a href="${n.href}"${current(n.href) ? html` aria-current="page"` : ""}>${n.label}</a>`)}
<a href="/" class="out">View the website ↗</a>
</div></nav>
<main id="main">
<header class="top"><div class="muted">${ctx.session.name} · ${ctx.session.role}</div>
<form method="post" action="/admin/logout">${csrfField(ctx.session)}<button class="secondary" type="submit">Sign out</button></form></header>
<div class="banner sim" role="status">Changes to the website go live only when you publish. Nothing here sends messages, posts or payments to real people.</div>
${ctx.flash ? html`<div class="flash" role="status">${ctx.flash}</div>` : ""}
${ctx.error ? html`<div class="error" role="alert">${ctx.error}</div>` : ""}
<h1>${title}</h1>
${body}
</main></div></body></html>`.value;
}

export function adminLoginPage(opts: { error?: string; firstOwner: boolean; setupKeyConfigured: boolean }): string {
  return html`<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin sign in · CONARO Business AI</title><link rel="stylesheet" href="/static/app.css"><meta name="robots" content="noindex"></head>
<body><main class="login" id="main"><h1>Platform admin</h1><p class="muted">CONARO Business AI: website, plans, billing and the platform's agents.</p>
${opts.error ? html`<div class="error" role="alert">${opts.error}</div>` : ""}
${opts.firstOwner
    ? opts.setupKeyConfigured
      ? html`<p>No platform owner exists yet. Create the first one with the set-up key (the <code>BAI_SETUP_KEY</code> setting).</p>
<form class="stack" method="post" action="/admin/first-owner">
<label>Set-up key <input name="key" type="password" required autocomplete="off"></label>
<label>Your name <input name="name" required maxlength="120"></label>
<label>Email <input name="email" type="email" required autocomplete="username"></label>
<label>Password (12+ characters) <input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
<button type="submit">Create owner and sign in</button></form>`
      : html`<p>No platform owner exists yet. Add <code>BAI_SETUP_KEY</code> (32+ random characters) to the host's settings, redeploy, then come back here.</p>`
    : html`<form class="stack" method="post" action="/admin/login">
<label>Email <input name="email" type="email" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required minlength="12"></label>
<button type="submit">Sign in</button></form>`}
</main></body></html>`.value;
}

export function overviewPage(ctx: AdminCtx, d: { tenants: number; demo: number; byPlan: { plan: string; n: number }[]; signups7: number; signups30: number; pending: number; proposals: number; billing: { status: string; n: number }[] }): string {
  const card = (label: string, value: Html | string | number, href?: string) => html`<div class="card"><div class="muted">${label}</div><strong>${href ? html`<a href="${href}">${value}</a>` : value}</strong></div>`;
  return adminLayout(ctx, "Overview", html`
<div class="cards">${card("Businesses (not demo)", d.tenants - d.demo, "/admin/businesses")}${card("Sign-ups, last 7 days", d.signups7)}${card("Sign-ups, last 30 days", d.signups30)}
${card("Unpublished website changes", d.pending, "/admin/site")}${card("Agent proposals waiting", d.proposals, "/admin/agents")}</div>
<section class="panel"><h2>Businesses by plan</h2>${table(["Plan", "Businesses"], d.byPlan.map((r) => [html`${r.plan}`, html`${r.n}`]), "No businesses yet.")}</section>
<section class="panel"><h2>Billing status</h2>${table(["Status", "Businesses"], d.billing.map((r) => [html`${r.status.replaceAll("_", " ")}`, html`${r.n}`]), "No subscriptions yet.")}
<p class="muted">Counts come from the database; demo workspaces are excluded where marked.</p></section>`);
}

export function sitePage(ctx: AdminCtx, d: { pending: { key: string; lang: string; updated_at: string }[]; history: { id: number; key: string; lang: string; value: string | null; action: string; occurred_at: string; who: string | null }[] }): string {
  const edit = adminCan(ctx.session.role, "site.edit");
  const when = (v: string) => new Date(v).toLocaleString("en-CA", { timeZone: "America/Moncton", dateStyle: "medium", timeStyle: "short" });
  return adminLayout(ctx, "Website", html`
<section class="panel"><h2>Edit the website</h2>
<p>Open the real page in edit mode: click any text to change it, hover a photo to replace it, move or hide sections. Changes are saved as drafts; visitors see them only after you publish.</p>
${edit ? html`<p class="row"><a class="button" href="/admin/editor?lang=en">Edit in English</a> <a class="button" href="/admin/editor?lang=fr">Edit in French</a></p>` : html`<p class="muted">Your role can view but not edit.</p>`}</section>
<section class="panel"><h2>Waiting to be published (${d.pending.length})</h2>
${table(["Item", "Language", "Changed"], d.pending.map((p) => [html`<code>${p.key}</code>`, html`${p.lang}`, html`${when(p.updated_at)}`]), "Nothing waiting: the website shows the latest version.")}
${edit && d.pending.length ? html`<div class="row"><form method="post" action="/admin/do/publish">${csrfField(ctx.session)}<button type="submit">Publish all changes</button></form>
<form method="post" action="/admin/do/discard">${csrfField(ctx.session)}<button class="secondary" type="submit">Discard all drafts</button></form></div>` : ""}</section>
<section class="panel"><h2>History</h2><p class="muted">Every save, publish and discard. "Restore" puts that version back as a draft.</p>
${table(["When", "Who", "What", "Item", "Text", ""], d.history.map((h) => [html`${when(h.occurred_at)}`, html`${h.who ?? "—"}`, badge(h.action, h.action === "publish" ? "ok" : "info"),
    html`<code>${h.key}</code> <span class="muted">${h.lang}</span>`, html`<span class="clip">${h.value === null ? "(default)" : h.value.slice(0, 140)}</span>`,
    edit && h.action !== "discard" ? html`<form method="post" action="/admin/do/restore">${csrfField(ctx.session)}<input type="hidden" name="id" value="${h.id}"><button class="secondary small" type="submit">Restore</button></form>` : html``]), "No changes yet.")}</section>`);
}

export function adminsPage(ctx: AdminCtx, rows: { email: string; display_name: string; role: string; status: string; created_at: string }[]): string {
  return adminLayout(ctx, "Admins", html`
${table(["Name", "Email", "Role", "Status"], rows.map((r) => [html`${r.display_name}`, html`${r.email}`, html`${r.role}`, badge(r.status, r.status === "active" ? "ok" : "muted")]))}
<h2>Add an admin</h2><p class="muted">Owner: everything. Editor: website content and the admin agents. Viewer: read only.</p>
<form class="stack" method="post" action="/admin/do/admin">${csrfField(ctx.session)}
<label>Name <input name="name" required maxlength="120"></label><label>Email <input name="email" type="email" required></label>
<label>Temporary password (12+ characters) <input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
<label>Role <select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="owner">Owner</option></select></label>
<button type="submit">Add admin</button></form>`);
}

export function auditPage(ctx: AdminCtx, rows: { occurred_at: string; actor: string; action: string; subject: string | null; detail: unknown }[]): string {
  return adminLayout(ctx, "Audit log", table(["When", "Who", "Action", "Subject", "Detail"], rows.map((r) => [
    html`${new Date(r.occurred_at).toLocaleString("en-CA", { timeZone: "America/Moncton", dateStyle: "medium", timeStyle: "short" })}`, html`${r.actor}`, html`${r.action}`, html`${r.subject ?? ""}`,
    html`<details><summary>Show</summary><pre class="json" tabindex="0">${JSON.stringify(r.detail, null, 2)}</pre></details>`]), "Nothing recorded yet."));
}

export function placeholderPage(ctx: AdminCtx, title: string, text: string): string {
  return adminLayout(ctx, title, html`<section class="panel"><p>${text}</p></section>`);
}

export { raw };
