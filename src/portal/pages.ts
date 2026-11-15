import { html, raw, table, badge, statusBadge, jsonBlock, type Html } from "../shared/html.ts";
import { currentLang, money, when, PLANNED_AGENTS_FR } from "./i18n.ts";
import { AGENT_COPY } from "../landing/agents-copy.ts";
import { one } from "../shared/db.ts";
import type { TenantDb } from "../tenancy.ts";
import type { AgentDeps } from "../agent-context.ts";
import { AGENTS } from "../catalog/agents.ts";
import { PLANS, billableAgents, isEntitled, planFor } from "../catalog/plans.ts";
import { industryPack, INDUSTRY_PACKS } from "../catalog/industries.ts";
import { getPolicy } from "../settings.ts";
import { getIntelligence, getProfileData } from "../profile.ts";
import { usageThisMonth } from "../usage.ts";
import { verifyTenantAudit } from "../audit.ts";
import { runTool } from "../tools/index.ts";
import { financialCommandCentre, profitAndLoss, type Figure } from "../tools/finance.ts";
import { growthCommandCentre } from "../tools/growth.ts";
import { addDays, isoDate, localParts } from "../time.ts";
import { can, type PortalSession } from "./auth.ts";

export interface PortalCtx {
  session: PortalSession;
  tdb: TenantDb;
  deps: AgentDeps;
  path: string;
  query: URLSearchParams;
  flash?: string | undefined;
  error?: string | undefined;
  tenant: { name: string; industry: string; paused: boolean; paused_reason: string | null; time_zone: string; is_demo: boolean };
  /** Published plan names, prices and features (platform admin); absent = the built-in catalogue. */
  plans?: Record<string, { priceCents: number | null; name: { en: string; fr: string }; features: { en: string[]; fr: string[] }; stripePriceId?: string | null }> | undefined;
  /** Stripe billing for the plan page. */
  billing?: { problem: string | null; mode: "test" | "live" | null; account: { stripe_customer_id: string | null; stripe_status: string | null; plan: string | null } | null } | undefined;
}

const NAV: { href: string; label: string; perm?: Parameters<typeof can>[1] }[] = [
  { href: "/", label: "Today" },
  { href: "/chat", label: "AI Business Manager", perm: "chat" },
  { href: "/approvals", label: "Approvals" },
  { href: "/growth", label: "Growth" },
  { href: "/finance", label: "Finance", perm: "finance.view" },
  { href: "/enquiries", label: "Enquiries and quotes", perm: "customers.view" },
  { href: "/bookings", label: "Bookings and jobs", perm: "customers.view" },
  { href: "/agents", label: "AI workforce" },
  { href: "/activity", label: "Agent activity" },
  { href: "/recommendations", label: "Recommendations" },
  { href: "/reports", label: "Reports" },
  { href: "/documents", label: "Documents", perm: "documents" },
  { href: "/settings", label: "Business settings" },
  { href: "/integrations", label: "Connections" },
  { href: "/plan", label: "Plan and usage" },
  { href: "/audit", label: "Audit log" },
];

export const csrf = (ctx: PortalCtx) => html`<input type="hidden" name="_csrf" value="${ctx.session.csrf}">`;

type LooseFigure = { label: string; cents?: number; reason?: string; source?: string; note?: string };
export function fig(input: Figure | LooseFigure | undefined): Html {
  if (!input) return html`<span class="muted">—</span>`;
  const f = input as LooseFigure;
  if (f.label === "UNAVAILABLE") return html`<span class="muted">Unavailable: ${f.reason}</span>`;
  const tone = f.label === "ACTUAL" ? "ok" : f.label === "TARGET" ? "info" : "warn";
  return html`<strong>${money(f.cents ?? 0)}</strong> ${badge(f.label, tone)}${f.source ? html` <span class="muted">${f.source}</span>` : ""}${f.note ? html`<br><span class="muted">${f.note}</span>` : ""}`;
}

/** Link to the same page in the other language (the choice is remembered in a cookie). */
export function langSwitch(path: string, query?: URLSearchParams): Html {
  const other = currentLang() === "fr" ? "en" : "fr";
  const q = new URLSearchParams(query);
  q.delete("ok"); q.delete("err"); q.set("lang", other);
  return html`<a class="lang-switch" href="${path}?${q.toString()}" lang="${other === "fr" ? "fr-CA" : "en-CA"}" hreflang="${other === "fr" ? "fr-CA" : "en-CA"}">${other === "fr" ? "Français" : "English"}</a>`;
}

export function layout(ctx: PortalCtx, title: string, body: Html): string {
  const current = (href: string) => (href === "/" ? ctx.path === "/" : ctx.path.startsWith(href));
  return html`<!doctype html>
<html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${ctx.tenant.name} · CONARO Business AI</title><link rel="stylesheet" href="/static/app.css"><meta name="robots" content="noindex"></head>
<body><a class="skip" href="#main">Skip to content</a><div class="shell">
<nav class="side" aria-label="Sections"><div class="brand">CONARO</div><div class="tag">Business AI · ${ctx.tenant.name}</div><div class="links">
${NAV.filter((n) => !n.perm || can(ctx.session.role, n.perm)).map((n) => html`<a href="${n.href}"${current(n.href) ? html` aria-current="page"` : ""}>${n.label}</a>`)}
</div></nav>
<main id="main">
<header class="top"><div class="muted">${ctx.session.name} · ${ctx.session.role}</div>
<div class="top-actions">${langSwitch(ctx.path, ctx.query)}<form method="post" action="/logout">${csrf(ctx)}<button class="secondary" type="submit">Sign out</button></form></div></header>
${ctx.tenant.is_demo ? html`<div class="banner prod" role="status">DEMO WORKSPACE: every business, customer, booking, invoice and bank line here is invented for testing.</div>` : ""}
<div class="banner sim" role="status">SIMULATION: no message, post, payment or purchase leaves CONARO Business AI yet. External actions are recorded and labelled simulated.</div>
${ctx.tenant.paused ? html`<div class="error" role="alert">All agents are paused${ctx.tenant.paused_reason ? html`: ${ctx.tenant.paused_reason}` : ""}.
${can(ctx.session.role, "resume") ? html`<form method="post" action="/do/resume">${csrf(ctx)}<button type="submit">Resume agents</button></form>` : ""}</div>`
    : can(ctx.session.role, "pause") ? html`<form class="notice" method="post" action="/do/pause">${csrf(ctx)}<input type="hidden" name="reason" value="paused from the control centre"><button class="secondary" type="submit">Pause all agents now</button></form>` : ""}
${ctx.flash ? html`<div class="flash" role="status">${ctx.flash}</div>` : ""}
${ctx.error ? html`<div class="error" role="alert">${ctx.error}</div>` : ""}
<h1>${title}</h1>
${body}
</main></div></body></html>`.value;
}

export function loginPage(error?: string): string {
  return html`<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · CONARO Business AI</title><link rel="stylesheet" href="/static/app.css"><meta name="robots" content="noindex"></head>
<body><main class="login" id="main"><p>${langSwitch("/login")}</p><h1>CONARO Business AI</h1><p class="muted">Your business. Your AI workforce.</p>
${error ? html`<div class="error" role="alert">${error}</div>` : ""}
<form class="stack" method="post" action="/login">
<label>Email <input name="email" type="email" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required minlength="12"></label>
<button type="submit">Sign in</button></form></main></body></html>`.value;
}

export function publicPage(title: string, message: string, form?: Html): string {
  return html`<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/static/app.css"><meta name="robots" content="noindex"></head>
<body><main class="login" id="main"><h1>${title}</h1><p>${message}</p>${form ?? ""}</main></body></html>`.value;
}

/** A public page for a business's own customers (e.g. unsubscribe): shown in both languages, never machine-switched. */
export function bilingualPage(title: string, message: string, form?: Html): string {
  return publicPage(title, message, form).replace('<html lang="en-CA">', '<html lang="en-CA" data-bilingual>');
}

const today = (ctx: PortalCtx) => localParts(new Date(), ctx.tenant.time_zone).date;
const list = (items: string[], empty = "Nothing.") => items.length ? html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>` : html`<p class="empty">${empty}</p>`;

// ---------------------------------------------------------------- Today

export async function todayPage(ctx: PortalCtx): Promise<string> {
  const latest = (await ctx.tdb.query<{ period: string; body: Record<string, any> }>("select period, body from bai_reports where kind = 'daily_summary' order by period desc limit 1"))[0];
  const pending = await one<{ n: number }>(ctx.tdb, "select count(*)::int n from bai_approvals where status = 'pending'");
  const bip = await getIntelligence(ctx.tdb);
  const s = latest?.body;
  return layout(ctx, "Today", html`
<div class="cards">
  <div class="card"><div class="muted">Approvals waiting</div><strong><a href="/approvals">${pending.n}</a></strong></div>
  <div class="card"><div class="muted">Profile gaps</div><strong><a href="/settings">${bip.gaps.length}</a></strong></div>
  <div class="card"><div class="muted">Industry</div><strong>${bip.industry.name}</strong></div>
  <div class="card"><div class="muted">Tax</div><strong>${bip.tax.label}</strong></div>
</div>
<section class="panel"><h2>Daily executive summary${latest ? html` · ${latest.period}` : ""}</h2>
${s ? html`
<h3>1. What happened</h3>${table(["Enquiries", "Quotes prepared", "Quotes accepted", "New bookings", "Jobs completed"], [[s.whatHappened.newEnquiries, s.whatHappened.quotesPrepared, s.whatHappened.quotesAccepted, s.whatHappened.newBookings, s.whatHappened.jobsCompleted].map((v) => html`${v}`)])}
<h3>2. Revenue</h3><p>Cash received: ${fig(s.revenue.cashReceived)}</p><p>Invoiced: ${fig(s.revenue.invoiced)}</p>
<h3>3. Opportunities identified</h3>${list(s.opportunities, "None identified.")}
<h3>4. Work completed by agents</h3>${table(["Agent", "Outcome", "Count"], s.agentWork.map((w: any) => [html`${AGENTS.find((a) => a.id === w.agent_id)?.name ?? w.agent_id}`, statusBadge(w.status), html`${w.n}`]), "No agent work recorded that day.")}
<h3>5. Needs your attention</h3>${list(s.needsAttention, "Nothing waiting.")}
<h3>6. Priorities today</h3>${list(s.prioritiesToday)}` : html`<p class="empty">The first summary is produced the morning after set-up.</p>`}
</section>
${bip.gaps.length ? html`<section class="panel"><h2>Finish setting up</h2>${list(bip.gaps)}</section>` : ""}`);
}

// ---------------------------------------------------------------- Chat

export async function chatPage(ctx: PortalCtx): Promise<string> {
  const mem = (await ctx.tdb.query<{ value: { role: string; text: string }[] }>("select value from bai_agent_memory where agent_id = 'business-manager' and key = 'chat'"))[0]?.value ?? [];
  return layout(ctx, "AI Business Manager", html`
<p class="muted">Answers come from your business's records. It recommends; it does not act on its own from this chat.</p>
<section class="panel">${mem.length ? mem.map((m) => html`<p><strong>${m.role === "owner" ? "You" : "Business Manager"}:</strong> ${m.text}</p>`) : html`<p class="empty">Ask about revenue, bookings, quotes or what to focus on.</p>`}</section>
<form class="stack" method="post" action="/do/chat">${csrf(ctx)}<label>Your question <textarea name="message" required maxlength="2000" rows="3"></textarea></label><button type="submit">Ask</button></form>`);
}

// ---------------------------------------------------------------- Approvals

export async function approvalsPage(ctx: PortalCtx): Promise<string> {
  const rows = await ctx.tdb.query<{ id: string; ref: string; level: number; action_type: string; title: string; summary: string; requested_by_agent: string; status: string; created_at: string; payload: { request: { payload: Record<string, unknown> } } }>(
    "select id, ref, level, action_type, title, summary, requested_by_agent, status, created_at, payload from bai_approvals order by (status = 'pending') desc, created_at desc limit 100");
  const decide = can(ctx.session.role, "approvals.decide");
  return layout(ctx, "Approvals", html`
<p class="muted">Level 2 actions wait here when their rule is off or the payload is outside your limits. Level 3 actions always wait for the owner. Approved external actions are SIMULATED in this version.</p>
${table(["Ref", "Level", "Requested by", "What", "Details", "Status", ""], rows.map((r) => [
    html`${r.ref}`, badge(`L${r.level}`, r.level === 3 ? "bad" : "warn"), html`${r.requested_by_agent}`,
    html`<strong>${r.title}</strong><br><span class="muted">${r.summary}</span>`,
    html`<details><summary>Payload</summary>${jsonBlock(r.payload.request.payload)}</details>`, statusBadge(r.status),
    r.status === "pending" && decide && (r.level < 3 || ctx.session.role === "owner") ? html`<form method="post" action="/do/approval">${csrf(ctx)}<input type="hidden" name="id" value="${r.id}">
      <label>Note <input name="note" maxlength="500"></label><button name="decision" value="approve" type="submit">Approve</button> <button class="secondary" name="decision" value="reject" type="submit">Reject</button></form>` : html``,
  ]), "No approvals yet.")}`);
}

// ---------------------------------------------------------------- Growth

export async function growthPage(ctx: PortalCtx): Promise<string> {
  const to = ctx.query.get("to") ?? today(ctx);
  const from = ctx.query.get("from") ?? `${to.slice(0, 7)}-01`;
  const r = await runTool(ctx.tdb, ctx.deps, "growth.command_centre", { from, to });
  if (!r.ran) return layout(ctx, "Growth", html`<p class="empty">The Growth Analyst is not active: ${r.skipped}</p>`);
  const g = r.output as Awaited<ReturnType<typeof growthCommandCentre>> & { utilisation: { availableMinutes: number; bookedMinutes: number; unusedMinutes: number; utilisation: number | null } };
  const c = g.counts;
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  return layout(ctx, "Growth command centre", html`
<form class="tabs" method="get"><label>From <input type="date" name="from" value="${from}"></label> <label>To <input type="date" name="to" value="${to}"></label> <button class="secondary" type="submit">Show</button></form>
<div class="cards">${[["New enquiries", c.leads], ["Qualified", c.qualified], ["Quotes prepared", c.quotes_prepared], ["Quotes accepted", c.quotes_accepted], ["New bookings", c.bookings], ["Jobs completed", c.jobs_completed], ["Repeat bookings", c.repeat_bookings], ["Open issues", c.open_issues]]
    .map(([l, v]) => html`<div class="card"><div class="muted">${l}</div><strong>${v}</strong></div>`)}</div>
${table(["Measure", "Value"], [
    [html`Quote acceptance`, html`${pct(g.conversion.quoteAcceptance)}`],
    [html`Enquiry to booking`, html`${pct(g.conversion.leadToBooking)}`],
    [html`Revenue attributed to campaigns`, fig(g.revenueAttributedToCampaigns)],
    [html`Employee utilisation`, html`${pct(g.utilisation.utilisation)} (${Math.round(g.utilisation.bookedMinutes / 60)} of ${Math.round(g.utilisation.availableMinutes / 60)} h)`],
    [html`Unused capacity`, html`${Math.round(g.utilisation.unusedMinutes / 60)} hours`],
    [html`Marketing reach`, fig(g.marketingReach)], [html`Social engagement`, fig(g.socialEngagement)],
    [html`Website visits`, fig(g.websiteVisits)], [html`Marketplace profile visits`, fig(g.marketplaceProfileVisits)],
  ])}`);
}

// ---------------------------------------------------------------- Finance

export async function financePage(ctx: PortalCtx): Promise<string> {
  const to = ctx.query.get("to") ?? today(ctx);
  const from = ctx.query.get("from") ?? `${to.slice(0, 7)}-01`;
  const p = await getProfileData(ctx.tdb);
  const f = await financialCommandCentre(ctx.tdb, p.identity.province, p.financial.gstHstRegistered === true, from, to);
  const pl = await profitAndLoss(ctx.tdb, from, to);
  const tx = await ctx.tdb.query<{ id: string; occurred_on: string; description: string; amount_cents: number; direction: string; category: string | null; suggested_category: string | null; suggestion_reason: string | null; status: string; flags: string[] }>(
    "select id, occurred_on, description, amount_cents, direction, category, suggested_category, suggestion_reason, status, flags from bai_transactions order by (status = 'unreviewed') desc, occurred_on desc limit 50");
  const invoices = await ctx.tdb.query<{ id: string; ref: string; status: string; total_cents: number; paid_cents: number; due_on: string | null }>(
    "select id, ref, status, total_cents, paid_cents, due_on from bai_invoices where status in ('issued','partially_paid') order by due_on limit 50");
  const edit = can(ctx.session.role, "finance.edit");
  return layout(ctx, "Financial command centre", html`
<p class="muted">ACTUAL = recorded in your books. ESTIMATE and FORECAST are calculations with stated assumptions. Unavailable means the data is not there yet; nothing is invented.</p>
<form class="tabs" method="get"><label>From <input type="date" name="from" value="${from}"></label> <label>To <input type="date" name="to" value="${to}"></label> <button class="secondary" type="submit">Show</button></form>
${table(["Measure", "Value"], ([
    ["Revenue invoiced", f.revenueInvoiced], ["Cash received", f.cashReceived], ["Operating expenses", f.operatingExpenses], ["Net operating result", f.netOperatingResult],
    ["Gross profit", f.grossProfit], ["Accounts receivable", f.accountsReceivable], ["Accounts payable", f.accountsPayable], ["Tax collected", f.taxCollected],
    ["Estimated tax liability", f.estimatedTaxLiability], ["Average booking value", f.averageBookingValue], ["Repeat-customer revenue", f.repeatCustomerRevenue],
    ["Marketing expenditure", f.marketingExpenditure], ["Customer acquisition cost", f.customerAcquisitionCost], ["Profitability by service", f.profitabilityByService],
  ] as [string, Figure][]).map(([l, v]) => [html`${l}`, fig(v)]))}
<h2>Revenue by service</h2>${table(["Service", "Revenue", "Jobs", "Revenue per booked hour"], f.revenueByService.map((r) => [html`${r.service}`, html`${money(r.cents)}`, html`${r.jobs}`, html`${money(r.revenuePerHourCents)}`]), "No invoiced jobs in this period.")}
<h2>Revenue by employee</h2>${table(["Employee", "Revenue"], f.revenueByEmployee.map((r) => [html`${r.employee}`, html`${money(r.cents)}`]), "No invoiced jobs in this period.")}
<h2>Profit and loss by category</h2>${table(["Direction", "Category", "Amount", "Items", "Unreviewed"], pl.byCategory.map((r) => [html`${r.direction}`, html`${r.category}`, html`${money(r.cents)}`, html`${r.n}`, html`${r.unreviewed}`]), "No transactions imported.")}
<h2>Open invoices</h2>${table(["Invoice", "Status", "Total", "Paid", "Due", ""], invoices.map((i) => [html`${i.ref}`, statusBadge(i.status), html`${money(i.total_cents)}`, html`${money(i.paid_cents)}`, html`${i.due_on ? isoDate(i.due_on) : "—"}`,
    can(ctx.session.role, "payment.record") ? html`<form method="post" action="/do/payment">${csrf(ctx)}<input type="hidden" name="invoiceId" value="${i.id}"><label>Amount $ <input name="amount" inputmode="decimal" required size="8"></label> <label>Method <input name="method" value="e-transfer" size="10"></label> <label>Date <input type="date" name="receivedOn" value="${today(ctx)}"></label> <button type="submit">Record payment</button></form>` : html``]), "No open invoices.")}
<h2>Transactions</h2>
${table(["Date", "Description", "Amount", "Category", "Suggestion", "Flags", ""], tx.map((t) => [html`${isoDate(t.occurred_on)}`, html`${t.description}`, html`${t.direction === "expense" ? "−" : ""}${money(t.amount_cents)}`,
    html`${t.category ?? "—"} ${statusBadge(t.status === "confirmed" ? "succeeded" : "pending")}`, html`${t.suggested_category ?? ""}${t.suggestion_reason ? html`<br><span class="muted">${t.suggestion_reason}</span>` : ""}`,
    html`${t.flags.join(", ")}`,
    edit && t.status !== "confirmed" ? html`<form method="post" action="/do/category">${csrf(ctx)}<input type="hidden" name="id" value="${t.id}"><input name="category" value="${t.suggested_category ?? t.category ?? ""}" required size="14" aria-label="Category"> <button type="submit">Confirm</button></form>` : html``]), "No transactions yet.")}
${edit ? html`<h2>Import transactions (CSV)</h2><form class="stack" method="post" action="/do/import">${csrf(ctx)}<label>Columns: date (YYYY-MM-DD), description, amount (negative for expenses), optional category, tax <textarea name="csv" rows="6" required></textarea></label><label>Source <input name="source" value="bank" required maxlength="60"></label><button type="submit">Import</button></form>
<h2>Bank balance (for the cash-flow forecast)</h2><form method="post" action="/do/balance">${csrf(ctx)}<label>Balance $ <input name="amount" inputmode="decimal" required></label> <button type="submit">Save</button></form>` : ""}`);
}

// ---------------------------------------------------------------- Enquiries, bookings

export async function enquiriesPage(ctx: PortalCtx): Promise<string> {
  const leads = await ctx.tdb.query<{ ref: string; name: string; channel: string; status: string; score: number | null; service: string | null; created_at: string; estimated_value_cents: number | null }>(
    `select l.ref, c.name, l.channel, l.status, l.score, s.name service, l.created_at, l.estimated_value_cents from bai_leads l join bai_customers c on c.id = l.customer_id
     left join bai_services s on s.id = l.service_id order by l.created_at desc limit 100`);
  const quotes = await ctx.tdb.query<{ id: string; ref: string; name: string; status: string; total_cents: number; valid_until: string | null }>(
    "select q.id, q.ref, c.name, q.status, q.total_cents, q.valid_until from bai_quotes q join bai_customers c on c.id = q.customer_id order by q.created_at desc limit 100");
  const services = await ctx.tdb.query<{ id: string; name: string }>("select id, name from bai_services where active order by name");
  return layout(ctx, "Enquiries and quotes", html`
${table(["Ref", "Customer", "Channel", "Service", "Score", "Est. value", "Status", "Received"], leads.map((l) => [html`${l.ref}`, html`${l.name}`, html`${l.channel}`, html`${l.service ?? "—"}`, html`${l.score ?? "—"}`, html`${money(l.estimated_value_cents)}`, statusBadge(l.status), html`${when(l.created_at)}`]), "No enquiries yet.")}
<h2>Quotes</h2>
${table(["Ref", "Customer", "Total", "Valid until", "Status", ""], quotes.map((q) => [html`${q.ref}`, html`${q.name}`, html`${money(q.total_cents)}`, html`${q.valid_until ? isoDate(q.valid_until) : "—"}`, statusBadge(q.status),
    q.status === "sent" && can(ctx.session.role, "quote.accept") ? html`<form method="post" action="/do/accept-quote">${csrf(ctx)}<input type="hidden" name="id" value="${q.id}"><label>Customer accepted for <input type="datetime-local" name="startsAt" required></label> <button type="submit">Record acceptance</button></form>` : html``]), "No quotes yet.")}
${can(ctx.session.role, "enquiry.add") ? html`<h2>Record an enquiry</h2><p class="muted">Phone calls, walk-ins or messages from elsewhere. Marketplace enquiries arrive automatically once the marketplace is connected.</p>
<form class="stack" method="post" action="/do/enquiry">${csrf(ctx)}
<label>Customer name <input name="name" required maxlength="120"></label><label>Email <input name="email" type="email"></label><label>Phone <input name="phone" maxlength="40"></label>
<label>Service <select name="serviceId"><option value="">Not sure</option>${services.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></label>
<label>What they need <textarea name="description" required rows="3" maxlength="5000"></textarea></label><label>Area <input name="area" maxlength="80"></label>
<label>Preferred date <input type="date" name="desiredDate"></label><label>Preferred time <input type="time" name="desiredTime"></label>
<label>Channel <select name="channel">${["phone", "email", "website", "walk-in", "referral", "social"].map((c) => html`<option value="${c}">${c}</option>`)}</select></label>
<label><input type="checkbox" name="consent" value="yes"> The customer explicitly agreed to receive marketing messages</label>
<button type="submit">Save enquiry</button></form>` : ""}`);
}

export async function bookingsPage(ctx: PortalCtx): Promise<string> {
  const rows = await ctx.tdb.query<{ ref: string; name: string; service: string; employee: string | null; starts_at: string; status: string; job_id: string | null; job_ref: string | null; job_status: string | null }>(
    `select b.ref, c.name, s.name service, e.name employee, b.starts_at, b.status, j.id job_id, j.ref job_ref, j.status job_status from bai_bookings b
     join bai_customers c on c.id = b.customer_id join bai_services s on s.id = b.service_id left join bai_employees e on e.id = b.employee_id
     left join bai_jobs j on j.booking_id = b.id order by b.starts_at desc limit 100`);
  return layout(ctx, "Bookings and jobs", table(["Booking", "Customer", "Service", "When", "Who", "Status", "Job", ""], rows.map((r) => [
    html`${r.ref}`, html`${r.name}`, html`${r.service}`, html`${when(r.starts_at)}`, html`${r.employee ?? "—"}`, statusBadge(r.status), html`${r.job_ref ?? "—"} ${r.job_status ? statusBadge(r.job_status) : ""}`,
    r.job_id && r.job_status !== "completed" && can(ctx.session.role, "job.complete") ? html`<form method="post" action="/do/complete-job">${csrf(ctx)}<input type="hidden" name="id" value="${r.job_id}"><label>Outcome <input name="outcome" maxlength="500"></label> <button type="submit">Mark completed</button></form>` : html``,
  ]), "No bookings yet."));
}

// ---------------------------------------------------------------- Agents, activity, recommendations, reports

export async function agentsPage(ctx: PortalCtx): Promise<string> {
  const rows = await ctx.tdb.query<{ agent_id: string; enabled: boolean; autonomy: string }>("select agent_id, enabled, autonomy from bai_agents");
  const sub = await one<{ plan: string; addons: string[] }>(ctx.tdb, "select plan, addons from bai_subscriptions");
  const counts = await ctx.tdb.query<{ agent_id: string; n: number }>("select agent_id, count(*)::int n from bai_actions where created_at > now() - interval '30 days' group by 1");
  const pack = industryPack(ctx.tenant.industry);
  const cfg = can(ctx.session.role, "agents.configure");
  const fr = currentLang() === "fr";
  const role = (a: (typeof AGENTS)[number]) => {
    if (!fr) return html`${a.role}<br><span class="muted">${a.rules.join(" ")}</span>`;
    const c = AGENT_COPY.find((x) => x.id === a.id);
    return c ? html`${c.summary.fr}<br><span class="muted">${c.how.fr.join(" ")}</span>` : html`${PLANNED_AGENTS_FR[a.id]?.role ?? a.role}`;
  };
  return layout(ctx, "AI workforce", html`
${fr ? html`<p class="muted">Autonomie : <strong>brouillon seulement</strong> (rien n'est envoyé), <strong>demander d'abord</strong> (chaque action externe attend une approbation), <strong>selon mes règles</strong> (les actions de niveau 2 s'exécutent lorsque vos règles le permettent), <strong>autonome</strong> (mêmes règles; pour usage futur). Les actions de niveau 3 attendent toujours le propriétaire.</p>` : html`<p class="muted">Autonomy: <strong>draft only</strong> (nothing is sent), <strong>ask first</strong> (every external action waits for approval), <strong>within my rules</strong> (level-2 actions run when your rules allow), <strong>autonomous</strong> (same rules; for future use). Level-3 actions always wait for the owner.</p>`}
${table(["#", "Agent", "Role", "Status", "In plan", "Relevant to your industry", "Actions (30 days)", "Settings"], AGENTS.map((a) => {
    const r = rows.find((x) => x.agent_id === a.id);
    const entitled = isEntitled(sub.plan, sub.addons, a.id);
    return [html`${a.number}`, html`<strong>${a.name}</strong>`, role(a),
      a.status === "operational" ? statusBadge(r?.enabled ? "active" : "cancelled") : badge(`planned (phase ${a.phase})`, "muted"),
      entitled ? badge("yes", "ok") : badge("upgrade", "muted"), pack.agents.includes(a.id) ? html`yes` : html`<span class="muted">optional</span>`,
      html`${counts.find((c) => c.agent_id === a.id)?.n ?? 0}`,
      cfg && a.status === "operational" && entitled ? html`<form method="post" action="/do/agent">${csrf(ctx)}<input type="hidden" name="id" value="${a.id}">
        <select name="enabled" aria-label="On or off"><option value="true"${r?.enabled ? html` selected` : ""}>On</option><option value="false"${r?.enabled ? "" : html` selected`}>Off</option></select>
        <select name="autonomy" aria-label="Autonomy">${[["draft_only", "Draft only"], ["approval", "Ask first"], ["rules", "Within my rules"], ["autonomous", "Autonomous"]].map(([v, l]) => html`<option value="${v}"${r?.autonomy === v ? html` selected` : ""}>${l}</option>`)}</select>
        <button class="secondary" type="submit">Save</button></form>` : html``];
  }))}`);
}

export async function activityPage(ctx: PortalCtx): Promise<string> {
  const actions = await ctx.tdb.query<{ created_at: string; agent_id: string; level: number; action_type: string; title: string; status: string; reason: string | null }>(
    "select created_at, agent_id, level, action_type, title, status, reason from bai_actions order by created_at desc limit 100");
  const runs = await ctx.tdb.query<{ id: string; workflow: string; status: string; created_at: string; error: string | null; steps: number }>(
    "select r.id, r.workflow, r.status, r.created_at, r.error, (select count(*) from bai_workflow_steps s where s.run_id = r.id)::int steps from bai_workflow_runs r order by r.created_at desc limit 50");
  const messages = await ctx.tdb.query<{ created_at: string; from_agent: string; to_agent: string; kind: string; body: unknown }>(
    "select created_at, from_agent, to_agent, kind, body from bai_agent_messages order by id desc limit 30");
  return layout(ctx, "Agent activity", html`
<h2>Actions</h2>${table(["When", "Agent", "Level", "Action", "Outcome", "Why"], actions.map((a) => [html`${when(a.created_at)}`, html`${a.agent_id}`, html`L${a.level}`, html`${a.title}<br><span class="muted">${a.action_type}</span>`, statusBadge(a.status), html`${a.reason ?? ""}`]), "No agent actions yet.")}
<h2>Workflows</h2>${table(["Started", "Workflow", "Steps", "Status", "Error"], runs.map((r) => [html`${when(r.created_at)}`, html`${r.workflow}`, html`${r.steps}`, statusBadge(r.status), html`${r.error ?? ""}`]), "No workflows yet.")}
<h2>Agent-to-agent messages</h2>${table(["When", "From", "To", "Kind", "Content"], messages.map((m) => [html`${when(m.created_at)}`, html`${m.from_agent}`, html`${m.to_agent}`, html`${m.kind}`, html`<details><summary>Show</summary>${jsonBlock(m.body)}</details>`]), "None yet.")}`);
}

export async function recommendationsPage(ctx: PortalCtx): Promise<string> {
  const rows = await ctx.tdb.query<{ id: string; agent_id: string; kind: string; title: string; rationale: string; assumptions: string[]; status: string; created_at: string }>(
    "select id, agent_id, kind, title, rationale, assumptions, status, created_at from bai_recommendations order by (status = 'open') desc, created_at desc limit 100");
  const tasks = await ctx.tdb.query<{ title: string; kind: string; due_on: string | null; source_agent: string; status: string }>("select title, kind, due_on, source_agent, status from bai_admin_tasks where status = 'open' order by due_on nulls last limit 50");
  const decide = can(ctx.session.role, "recommendations.decide");
  return layout(ctx, "Recommendations and tasks", html`
${table(["Kind", "From", "Recommendation", "Assumptions", "Status", ""], rows.map((r) => [badge(r.kind, r.kind === "issue" ? "warn" : "info"), html`${r.agent_id}`, html`<strong>${r.title}</strong><br><span class="muted">${r.rationale}</span>`,
    html`${r.assumptions.length ? list(r.assumptions) : ""}`, statusBadge(r.status === "open" ? "pending" : r.status),
    r.status === "open" && decide ? html`<form method="post" action="/do/recommendation">${csrf(ctx)}<input type="hidden" name="id" value="${r.id}"><button name="status" value="accepted" type="submit">Accept</button> <button class="secondary" name="status" value="dismissed" type="submit">Dismiss</button></form>` : html``]), "No recommendations yet.")}
<h2>Your task list</h2>${table(["Task", "Type", "Due", "From"], tasks.map((t) => [html`${t.title}`, html`${t.kind}`, html`${t.due_on ? isoDate(t.due_on) : "—"}`, html`${t.source_agent}`]), "No open tasks.")}`);
}

export async function reportsPage(ctx: PortalCtx): Promise<string> {
  const id = ctx.query.get("id");
  if (id && /^[0-9a-f-]{36}$/.test(id)) {
    const r = (await ctx.tdb.query<{ kind: string; period: string; body: unknown }>("select kind, period, body from bai_reports where id = $1", [id]))[0];
    if (r) return layout(ctx, `${r.kind.replaceAll("_", " ")} · ${r.period}`, html`<p><a href="/reports">All reports</a></p>${jsonBlock(r.body)}`);
  }
  const rows = await ctx.tdb.query<{ id: string; kind: string; period: string; created_at: string }>("select id, kind, period, created_at from bai_reports order by created_at desc limit 100");
  return layout(ctx, "Reports", table(["Report", "Period", "Produced", ""], rows.map((r) => [html`${r.kind.replaceAll("_", " ")}`, html`${r.period}`, html`${when(r.created_at)}`, html`<a href="/reports?id=${r.id}">Open</a>`]), "Reports appear after the first daily cycle."));
}

// ---------------------------------------------------------------- Documents

export async function documentsPage(ctx: PortalCtx): Promise<string> {
  const q = ctx.query.get("q")?.slice(0, 100) ?? "";
  const results = q ? await runTool(ctx.tdb, ctx.deps, "admin.search_documents", { query: q }) : null;
  const docs = await ctx.tdb.query<{ name: string; kind: string; size_bytes: number; created_at: string }>("select name, kind, size_bytes, created_at from bai_documents order by created_at desc limit 50");
  const found = results?.ran ? (results.output as { results: { name: string; excerpt: string }[] }).results : [];
  return layout(ctx, "Documents", html`
<form method="get" class="tabs"><label>Search <input name="q" value="${q}"></label> <button class="secondary" type="submit">Search</button></form>
${q ? table(["Document", "Excerpt"], found.map((r) => [html`${r.name}`, html`${r.excerpt}`]), "No matches.") : ""}
${table(["Name", "Type", "Size", "Added"], docs.map((d) => [html`${d.name}`, html`${d.kind}`, html`${Math.ceil(d.size_bytes / 1024)} KB`, html`${when(d.created_at)}`]), "No documents yet.")}
<h2>Add a text document</h2><p class="muted">Policies, price lists, procedures. Text only, up to 1 MB. Content is treated as untrusted data by the agents.</p>
<form class="stack" method="post" action="/do/document">${csrf(ctx)}<label>Name <input name="name" required maxlength="120"></label><label>Type <input name="kind" value="policy" maxlength="40"></label><label>Text <textarea name="text" rows="8" required></textarea></label><button type="submit">Save</button></form>`);
}

// ---------------------------------------------------------------- Settings

export async function settingsPage(ctx: PortalCtx): Promise<string> {
  const p = await getProfileData(ctx.tdb);
  const pol = await getPolicy(ctx.tdb);
  const bip = await getIntelligence(ctx.tdb);
  const services = await ctx.tdb.query<{ name: string; pricing_unit: string; price_cents: number | null; duration_minutes: number | null; required_skill: string | null; seasonal_months: number[] }>(
    "select name, pricing_unit, price_cents, duration_minutes, required_skill, seasonal_months from bai_services where active order by name");
  const team = await ctx.tdb.query<{ name: string; skills: string[]; availability: Record<string, string[]> }>("select name, skills, availability from bai_employees where active order by name");
  const members = await ctx.tdb.query<{ display_name: string; email: string; role: string }>("select u.display_name, u.email, m.role from bai_memberships m join bai_users u on u.id = m.user_id order by m.created_at");
  const editProfile = can(ctx.session.role, "profile.edit");
  const editPolicy = can(ctx.session.role, "policy.edit");
  const cb = (name: keyof typeof pol, label: string) => html`<label><input type="checkbox" name="${name}" value="true"${pol[name] ? html` checked` : ""}${editPolicy ? "" : html` disabled`}> ${label}</label>`;
  const num = (name: keyof typeof pol, label: string, cents = false) => html`<label>${label} <input name="${name}" inputmode="decimal" value="${cents ? (Number(pol[name]) / 100).toFixed(2) : String(pol[name])}"${editPolicy ? "" : html` disabled`}></label>`;
  const hours = p.identity.hours ?? {};
  const day = (d: string) => (hours as Record<string, [string, string]>)[d];
  return layout(ctx, "Business settings", html`
<section class="panel"><h2>Business Intelligence Profile</h2><p>${bip.summary}</p><p class="muted">Industry pack: ${bip.industry.name} · Tax: ${bip.tax.label}${bip.tax.note ? html` · ${bip.tax.note}` : ""}</p>
${bip.gaps.length ? html`<h3>Missing</h3>${list(bip.gaps)}` : html`<p>${badge("complete", "ok")}</p>`}
<details><summary>Industry operating rules</summary>${jsonBlock(bip.operatingRules)}</details></section>
${editProfile ? html`<h2>Profile</h2><form class="stack" method="post" action="/do/profile">${csrf(ctx)}
<label>Description <textarea name="description" rows="3" maxlength="2000">${p.identity.description ?? ""}</textarea></label>
<label>Province (tax jurisdiction) <select name="province"><option value="">Choose</option>${["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"].map((x) => html`<option${p.identity.province === x ? html` selected` : ""}>${x}</option>`)}</select></label>
<label>Service areas (comma-separated) <input name="serviceAreas" value="${(p.identity.serviceAreas ?? []).join(", ")}"></label>
<label>Contact email <input name="email" type="email" value="${p.identity.email ?? ""}"></label><label>Phone <input name="phone" value="${p.identity.phone ?? ""}"></label>
<label>Mailing address (required on marketing messages) <input name="mailingAddress" value="${p.identity.mailingAddress ?? ""}"></label>
<fieldset><legend>Business hours (leave blank when closed)</legend>${["1", "2", "3", "4", "5", "6", "7"].map((d, i) => html`<label>${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]} <input type="time" name="open${d}" value="${day(d)?.[0] ?? ""}"> – <input type="time" name="close${d}" value="${day(d)?.[1] ?? ""}"></label>`)}</fieldset>
<label>Monthly revenue target $ <input name="monthlyTarget" inputmode="decimal" value="${p.objectives.monthlyRevenueTargetCents ? (p.objectives.monthlyRevenueTargetCents / 100).toFixed(0) : ""}"></label>
<label>Growth priorities (one per line) <textarea name="growthPriorities" rows="2">${(p.objectives.growthPriorities ?? []).join("\n")}</textarea></label>
<label>Cancellation policy <textarea name="cancellationPolicy" rows="2">${p.operations.cancellationPolicy ?? ""}</textarea></label>
<label>Payment methods (comma-separated) <input name="paymentMethods" value="${(p.operations.paymentMethods ?? []).join(", ")}"></label>
<label>Booking lead time (hours) <input name="leadTime" inputmode="numeric" value="${p.operations.bookingLeadTimeHours ?? ""}"></label>
<label>GST/HST registered <select name="registered"><option value="">Not set</option><option value="yes"${p.financial.gstHstRegistered === true ? html` selected` : ""}>Yes</option><option value="no"${p.financial.gstHstRegistered === false ? html` selected` : ""}>No</option></select></label>
<button type="submit">Save profile</button></form>` : ""}
<h2>Services and pricing</h2>${table(["Service", "Pricing", "Price", "Duration", "Skill", "Season"], services.map((s) => [html`${s.name}`, html`${s.pricing_unit}`, html`${money(s.price_cents)}`, html`${s.duration_minutes ?? "not set"} min`, html`${s.required_skill ?? "—"}`, html`${s.seasonal_months.length ? s.seasonal_months.join(", ") : "all year"}`]), "No services yet.")}
${editProfile ? html`<form class="stack" method="post" action="/do/service">${csrf(ctx)}<label>Name <input name="name" required maxlength="120"></label><label>Category <input name="category" required maxlength="80"></label>
<label>Description <textarea name="description" rows="2" maxlength="2000"></textarea></label><label>Pricing <select name="pricingUnit"><option value="fixed">Fixed price</option><option value="hourly">Per hour</option><option value="per_unit">Per unit</option></select></label>
<label>Unit label (per unit) <input name="unitLabel" maxlength="40"></label><label>Price $ <input name="price" inputmode="decimal"></label><label>Minimum charge $ <input name="minCharge" inputmode="decimal"></label><label>Travel fee $ <input name="travelFee" inputmode="decimal"></label>
<label>Standard duration (minutes) <input name="duration" inputmode="numeric"></label><label>Required skill <input name="requiredSkill" maxlength="60"></label><label>Season months (e.g. 5,6,7) <input name="season"></label>
<label>Limitations <input name="limitations" maxlength="1000"></label><button type="submit">Save service</button></form>` : ""}
<h2>Team</h2>${table(["Name", "Skills", "Working days"], team.map((t) => [html`${t.name}`, html`${t.skills.join(", ")}`, html`${Object.entries(t.availability).map(([d, w]) => `${["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][Number(d)]} ${w.join("–")}`).join("; ")}`]), "No team members yet.")}
${editProfile ? html`<form class="stack" method="post" action="/do/employee">${csrf(ctx)}<label>Name <input name="name" required maxlength="120"></label><label>Skills (comma-separated) <input name="skills"></label>
<label>Works Monday–Friday from <input type="time" name="from" value="08:00"> to <input type="time" name="to" value="17:00"></label><label><input type="checkbox" name="saturday" value="yes"> Also Saturdays</label><button type="submit">Add team member</button></form>` : ""}
<h2>Operating rules</h2><p class="muted">Level-2 actions run automatically only when you turn their rule on and the agent is set to "within my rules". Money limits start at $0.</p>
<form class="stack" method="post" action="/do/policy">${csrf(ctx)}
${cb("auto_confirm_bookings", "Confirm bookings automatically once availability is validated")}
${cb("auto_send_quotes", "Send quotes automatically")} ${num("max_auto_quote_cents", "…up to a total of $", true)} ${num("max_discount_pct", "Maximum discount %")}
${cb("auto_follow_up", "Follow up open quotes (consented customers only)")} ${cb("auto_feedback_requests", "Ask for feedback after completed jobs")}
${cb("auto_issue_invoices", "Issue invoices automatically")} ${cb("auto_payment_reminders", "Send overdue payment reminders")} ${num("payment_reminder_days", "Days between reminders")}
${cb("send_appointment_reminders", "Send appointment reminders")} ${num("reminder_hours_before", "Hours before the appointment")}
${cb("marketing_autosend", "Send marketing messages automatically (consented customers, within budget)")} ${num("monthly_marketing_budget_cents", "Monthly marketing budget $", true)}
${cb("social_autopublish", "Publish social posts without asking")}
${num("supplies_limit_cents", "Supplies spending limit $", true)} ${num("refund_limit_cents", "Refund limit $", true)} ${num("travel_buffer_minutes", "Travel time between jobs (minutes)")}
${num("quote_valid_days", "Quotes valid for (days)")} ${num("invoice_due_days", "Invoices due after (days)")}
${editPolicy ? html`<button type="submit">Save rules</button>` : html`<p class="muted">Only the owner can change operating rules.</p>`}</form>
<h2>People with access</h2>${table(["Name", "Email", "Role"], members.map((m) => [html`${m.display_name}`, html`${m.email}`, html`${m.role}`]))}
${can(ctx.session.role, "members.add") ? html`<form class="stack" method="post" action="/do/member">${csrf(ctx)}<label>Name <input name="name" required></label><label>Email <input name="email" type="email" required></label>
<label>Temporary password (12+ characters) <input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
<label>Role <select name="role"><option value="manager">Manager</option><option value="staff">Staff</option><option value="accountant">Accountant</option><option value="viewer">Viewer</option></select></label><button type="submit">Add person</button></form>` : ""}`);
}

// ---------------------------------------------------------------- Integrations, plan, audit

export async function integrationsPage(ctx: PortalCtx): Promise<string> {
  const rows = await ctx.tdb.query<{ provider: string; status: string; detail: string; checked_at: string | null }>("select provider, status, detail, checked_at from bai_integrations order by provider");
  return layout(ctx, "Connections", html`
<p class="muted">A connection is shown as operational only after sign-in, permissions, data sync, error handling and an end-to-end test have all passed. No connection is available yet in this version: agents work from what you enter here, and every external action is simulated.</p>
${table(["Service", "Status", "Detail", "Last checked"], rows.map((r) => [html`${r.provider}`, statusBadge(r.status === "operational" ? "active" : r.status === "not_connected" ? "cancelled" : r.status), html`${r.detail || "Not connected"}`, html`${when(r.checked_at)}`]))}`);
}

function billingPanel(ctx: PortalCtx, plan: string): Html {
  const b = ctx.billing;
  if (!b || b.problem) return html`<section class="panel"><h2>Billing</h2><p class="muted">Card billing is not switched on yet, so nothing is charged.</p></section>`;
  const owner = can(ctx.session.role, "plan.change");
  const linked = Boolean(ctx.plans?.[plan]?.stripePriceId);
  return html`<section class="panel"><h2>Billing</h2>
${b.mode === "test" ? html`<p>${badge("Stripe test mode", "warn")} No real money moves: use Stripe's test card 4242 4242 4242 4242 with any future date and any CVC.</p>` : html`<p>${badge("Stripe live", "ok")}</p>`}
${b.account?.stripe_customer_id ? html`<p>Stripe subscription: <strong>${b.account.stripe_status ?? "pending"}</strong></p>
${owner ? html`<form method="post" action="/do/billing-portal">${csrf(ctx)}<button class="secondary" type="submit">Manage billing in Stripe</button></form>` : ""}`
    : owner ? linked ? html`<form method="post" action="/do/checkout">${csrf(ctx)}<input type="hidden" name="plan" value="${plan}"><button type="submit">Subscribe with a card</button></form>`
      : html`<p class="muted">Your plan is not available for card payment yet.</p>` : html`<p class="muted">Only the owner can set up billing.</p>`}
</section>`;
}

export async function planPage(ctx: PortalCtx): Promise<string> {
  const sub = await one<{ plan: string; status: string; addons: string[]; billing_status: string }>(ctx.tdb, "select plan, status, addons, billing_status from bai_subscriptions");
  const usage = await usageThisMonth(ctx.tdb);
  const plan = planFor(sub.plan);
  const fr = currentLang() === "fr";
  const nameOf = (id: string, fallback: string) => ctx.plans?.[id]?.name[fr ? "fr" : "en"] ?? fallback;
  const priceOf = (id: string, fallback: number | null) => (ctx.plans ? ctx.plans[id]?.priceCents ?? null : fallback);
  const featuresOf = (id: string, fallback: readonly string[]) => ctx.plans?.[id]?.features[fr ? "fr" : "en"] ?? fallback;
  return layout(ctx, "Plan and usage", html`
<div class="cards"><div class="card"><div class="muted">Plan</div><strong>${nameOf(plan.id, plan.name)}</strong></div><div class="card"><div class="muted">Status</div><strong>${sub.status}</strong></div>
<div class="card"><div class="muted">Billing</div><strong>${sub.billing_status === "not_connected" ? "not connected" : sub.billing_status}</strong></div><div class="card"><div class="muted">Agents you pay for</div><strong>${billableAgents(sub.plan, sub.addons).length}</strong></div></div>
${billingPanel(ctx, sub.plan)}
<p class="muted">Agents marked "planned" are not available yet and are never charged. Subscription charges are separate from advertising spend, payment processing fees and third-party charges.</p>
<h2>This month's usage</h2>${table(["Measure", "Used", "Plan limit"], [
    [html`AI calls`, html`${usage.ai_calls ?? 0}`, html`${plan.limits.aiCallsPerMonth}`],
    [html`External actions`, html`${usage.external_actions ?? 0}`, html`${plan.limits.externalActionsPerMonth}`],
    [html`Workflow runs`, html`${usage.workflow_runs ?? 0}`, html`—`]])}
<h2>Plans</h2>${table(["Plan", "Price", "Working agents", "Includes", ""], PLANS.map((p) => [html`<strong>${nameOf(p.id, p.name)}</strong>`, html`${priceOf(p.id, p.priceCents) === null ? "price not set" : `${money(priceOf(p.id, p.priceCents))} / month`}`,
    html`${billableAgents(p.id).length}`, html`${featuresOf(p.id, p.features).join("; ")}`,
    p.id !== sub.plan && can(ctx.session.role, "plan.change") ? html`<form method="post" action="/do/plan">${csrf(ctx)}<input type="hidden" name="plan" value="${p.id}"><button class="secondary" type="submit">Switch</button></form>` : p.id === sub.plan ? badge("current", "ok") : html``]))}`);
}

export async function auditPage(ctx: PortalCtx): Promise<string> {
  const v = await verifyTenantAudit(ctx.tdb);
  const rows = await ctx.tdb.query<{ occurred_at: string; actor: string; action: string; subject_type: string; detail: unknown }>("select occurred_at, actor, action, subject_type, detail from bai_audit order by id desc limit 200");
  return layout(ctx, "Audit log", html`<p>${v.ok ? badge(`chain intact · ${v.checked} events`, "ok") : badge(`chain broken at ${v.brokenAt}`, "bad")}</p>
${table(["When", "Who", "What", "Subject", "Detail"], rows.map((r) => [html`${when(r.occurred_at)}`, html`${r.actor}`, html`${r.action}`, html`${r.subject_type}`, html`<details><summary>Show</summary>${jsonBlock(r.detail)}</details>`]))}`);
}

/** Demo logins, shown once on the set-up page. */
export function credentialsTable(rows: { business: string; role: string; email: string; password: string }[]): Html {
  // A stacked list (not a table) so emails and passwords are never cut off on a narrow page.
  return html`<ul class="credentials">${rows.map((c) => html`<li><strong>${c.business}</strong> · ${c.role}<br>Email: <code class="email">${c.email}</code><br>Password: <code class="password">${c.password}</code></li>`)}</ul>`;
}

export const ALL_INDUSTRIES = INDUSTRY_PACKS.map((p) => ({ id: p.id, name: p.name }));
export { addDays, raw };
