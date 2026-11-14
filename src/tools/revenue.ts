import { z } from "zod";
import { json, maybeOne, one } from "../shared/db.ts";
import { PermanentError } from "../shared/errors.ts";
import { UNTRUSTED_DATA_POLICY, injectionSignals, wrapUntrusted } from "../shared/untrusted.ts";
import type { TenantDb } from "../tenancy.ts";
import { nextRef } from "../tenancy.ts";
import { tenantAudit } from "../audit.ts";
import { recordCustomerConsent } from "../consent.ts";
import { applyRate, taxRateFor } from "../catalog/tax.ts";
import { emitEvent } from "../events.ts";
import { meter } from "../usage.ts";
import { money } from "../time.ts";
import type { AgentContext } from "../agent-context.ts";
import { tool } from "./registry.ts";

// ---------------------------------------------------------------- intake (entry point, not an agent tool)

export const EnquirySchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  serviceId: z.string().uuid().optional(),
  description: z.string().min(3).max(5000),
  area: z.string().max(80).optional(),
  desiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  desiredTime: z.string().regex(/^\d\d:\d\d$/).optional(),
  quantity: z.number().positive().max(100000).optional(),
  channel: z.enum(["conaro-marketplace", "website", "phone", "email", "social", "walk-in", "referral"]),
  campaignCode: z.string().max(40).optional(),
  language: z.enum(["en-CA", "fr-CA"]).default("en-CA"),
  expressMarketingConsent: z.boolean().default(false),
}).refine((e) => e.email || e.phone || e.channel === "conaro-marketplace", "an email or phone number is required");
// Marketplace enquiries may arrive without contact details: the marketplace keeps the customer's identity until a booking exists.

/** A customer submits a service request: record it and trigger the enquiry workflow. */
export async function receiveEnquiry(tdb: TenantDb, input: z.input<typeof EnquirySchema>, actor: string): Promise<{ leadId: string; ref: string; customerId: string }> {
  const e = EnquirySchema.parse(input);
  const email = e.email?.toLowerCase();
  const existing = email ? await maybeOne<{ id: string }>(tdb, "select id from bai_customers where email = $1", [email]) : null;
  const customerId = existing?.id ?? (await one<{ id: string }>(tdb,
    "insert into bai_customers (name, email, phone, area, language) values ($1, $2, $3, $4, $5) returning id",
    [e.name, email ?? null, e.phone ?? null, e.area ?? null, e.language])).id;
  await tdb.query("update bai_customers set last_activity_at = now() where id = $1", [customerId]);
  if (email) {
    // CASL s. 10(10): an inquiry gives implied consent for six months.
    await recordCustomerConsent(tdb, { email, customerId, basis: "implied_inquiry", source: `enquiry:${e.channel}` }, actor);
    if (e.expressMarketingConsent) {
      await recordCustomerConsent(tdb, { email, customerId, basis: "express", source: `enquiry:${e.channel}`, evidence: { method: "enquiry form checkbox" } }, actor);
    }
  }
  const campaign = e.campaignCode ? await maybeOne<{ id: string }>(tdb, "select id from bai_campaigns where tracking_code = $1", [e.campaignCode]) : null;
  const ref = await nextRef(tdb, "lead", "L");
  const lead = await one<{ id: string }>(tdb,
    `insert into bai_leads (ref, customer_id, service_id, channel, description, area, desired_date, quantity, campaign_id, qualification)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text::jsonb) returning id`,
    [ref, customerId, e.serviceId ?? null, e.channel, e.description, e.area ?? null, e.desiredDate ?? null, e.quantity ?? null, campaign?.id ?? null,
      json(e.desiredTime ? { desiredTime: e.desiredTime } : {})]);
  await tdb.query("insert into bai_messages (customer_id, lead_id, direction, channel, body) values ($1, $2, 'inbound', $3, $4)", [customerId, lead.id, e.channel, e.description]);
  await tenantAudit(tdb, { actor, action: "lead.received", subjectType: "lead", subjectId: lead.id, detail: { channel: e.channel } });
  await emitEvent(tdb, "lead.received", { leadId: lead.id }, `lead.received:${lead.id}`);
  return { leadId: lead.id, ref, customerId };
}

// ---------------------------------------------------------------- pricing

export interface PriceLine { description: string; quantity: number; unitCents: number; amountCents: number }
export interface PriceResult { ok: true; lines: PriceLine[]; subtotalCents: number; taxBp: number; taxLabel: string; taxCents: number; totalCents: number; assumptions: string[] }

interface ServiceRow { id: string; name: string; pricing_unit: "fixed" | "hourly" | "per_unit"; unit_label: string | null; price_cents: number | null; min_charge_cents: number; travel_fee_cents: number; duration_minutes: number | null; taxable: boolean }

/** Prices a job from the business's approved rules only. Missing information means no price, never a guess. */
export function priceJob(svc: ServiceRow, quantity: number | null, tax: { bp: number; label: string }, discountPct = 0): PriceResult | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (svc.price_cents === null) missing.push(`price for "${svc.name}"`);
  let qty = 1;
  const assumptions: string[] = [];
  if (svc.pricing_unit === "hourly") {
    if (quantity) qty = quantity;
    else if (svc.duration_minutes) { qty = svc.duration_minutes / 60; assumptions.push(`Hours from the service's standard duration (${svc.duration_minutes} min); final time may differ.`); }
    else missing.push("number of hours (no standard duration set)");
  } else if (svc.pricing_unit === "per_unit") {
    if (quantity) qty = quantity; else missing.push(`quantity (${svc.unit_label ?? "units"})`);
  }
  if (missing.length) return { ok: false, missing };
  const unit = svc.price_cents as number;
  const lines: PriceLine[] = [{ description: svc.name, quantity: qty, unitCents: unit, amountCents: Math.round(unit * qty) }];
  const base = lines[0]!.amountCents;
  if (base < svc.min_charge_cents) lines.push({ description: "Minimum charge adjustment", quantity: 1, unitCents: svc.min_charge_cents - base, amountCents: svc.min_charge_cents - base });
  if (svc.travel_fee_cents > 0) lines.push({ description: "Travel fee", quantity: 1, unitCents: svc.travel_fee_cents, amountCents: svc.travel_fee_cents });
  let subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
  if (discountPct > 0) {
    const d = Math.round(subtotal * discountPct / 100);
    lines.push({ description: `Discount ${discountPct}%`, quantity: 1, unitCents: -d, amountCents: -d });
    subtotal -= d;
  }
  const bp = svc.taxable ? tax.bp : 0;
  const taxCents = applyRate(subtotal, bp);
  return { ok: true, lines, subtotalCents: subtotal, taxBp: bp, taxLabel: svc.taxable ? tax.label : "Not taxable", taxCents, totalCents: subtotal + taxCents, assumptions };
}

export async function serviceRow(ctx: AgentContext, id: string): Promise<ServiceRow | null> {
  return maybeOne<ServiceRow>(ctx.tdb, "select id, name, pricing_unit, unit_label, price_cents, min_charge_cents, travel_fee_cents, duration_minutes, taxable from bai_services where id = $1 and active", [id]);
}

export function businessTax(ctx: AgentContext) {
  return taxRateFor(ctx.profile.identity.province, ctx.profile.financial.gstHstRegistered === true);
}

// ---------------------------------------------------------------- sales agent

interface LeadRow { id: string; ref: string; customer_id: string; service_id: string | null; description: string; area: string | null; desired_date: string | null; quantity: string | null; status: string; channel: string; qualification: Record<string, unknown> }

tool({
  name: "sales.qualify_lead", agent: "sales", scopes: ["leads", "services", "customers.pii", "profile"],
  description: "Score an enquiry on fit (service offered and in season, area served, contact, timing, detail) and estimate its value from approved prices.",
  async run(ctx, input: { leadId: string }) {
    const lead = await maybeOne<LeadRow>(ctx.tdb, "select * from bai_leads where id = $1", [input.leadId]);
    if (!lead) throw new PermanentError("lead not found");
    const services = await ctx.tdb.query<{ id: string; name: string; category: string; seasonal_months: number[]; price_cents: number | null }>(
      "select id, name, category, seasonal_months, price_cents from bai_services where active");
    let serviceId = lead.service_id;
    if (!serviceId) {
      // Match on words of the service name or category in the description (no model needed for the obvious case).
      const text = lead.description.toLowerCase();
      // Most words of the service name matched wins; the category breaks ties. No match, no guess.
      const words = (w: string) => [...new Set(w.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter((x) => x.length > 3))];
      const scored = services.map((s) => ({ s, n: words(s.name).filter((x) => text.includes(x)).length * 2 + words(s.category).filter((x) => text.includes(x)).length }))
        .filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
      serviceId = scored[0] && (scored.length === 1 || scored[0].n > scored[1]!.n) ? scored[0].s.id : null;
    }
    const svc = services.find((s) => s.id === serviceId);
    const month = ctx.now.getUTCMonth() + 1;
    const areas = (ctx.profile.identity.serviceAreas ?? []).map((a) => a.toLowerCase());
    const contact = await one<{ email: string | null; phone: string | null }>(ctx.tdb, "select email, phone from bai_customers where id = $1", [lead.customer_id]);
    const reasons: { criterion: string; points: number; max: number; note: string }[] = [
      { criterion: "Service offered", max: 35, points: svc ? 35 : 0, note: svc ? svc.name : "no matching active service" },
      { criterion: "In season", max: 10, points: !svc ? 0 : svc.seasonal_months.length === 0 || svc.seasonal_months.includes(month) ? 10 : 0, note: svc && svc.seasonal_months.length && !svc.seasonal_months.includes(month) ? "out of season" : "ok" },
      { criterion: "Area served", max: 20, points: !lead.area ? 10 : areas.length === 0 ? 10 : areas.includes(lead.area.toLowerCase()) ? 20 : 0, note: lead.area ? (areas.includes(lead.area.toLowerCase()) ? "inside service areas" : areas.length ? "outside listed service areas" : "service areas not set") : "area not given" },
      { criterion: "Contact details", max: 15, points: (contact.email ? 10 : 0) + (contact.phone ? 5 : 0), note: [contact.email && "email", contact.phone && "phone"].filter(Boolean).join(" + ") || "none" },
      { criterion: "Timing given", max: 10, points: lead.desired_date ? 10 : 0, note: lead.desired_date ?? "no date" },
      { criterion: "Enough detail", max: 10, points: lead.description.length >= 60 ? 10 : lead.description.length >= 20 ? 5 : 0, note: `${lead.description.length} characters` },
    ];
    const score = reasons.reduce((s, r) => s + r.points, 0);
    const qualified = Boolean(svc) && score >= 60 && reasons[2]!.points > 0;
    let estimate: number | null = null;
    if (svc) {
      const row = await serviceRow(ctx, svc.id);
      const p = row ? priceJob(row, lead.quantity ? Number(lead.quantity) : null, businessTax(ctx)) : null;
      estimate = p?.ok ? p.subtotalCents : null;
    }
    const injected = injectionSignals(lead.description);
    const out = await ctx.act({ actionType: "lead.qualify", title: `Qualify ${lead.ref}`, payload: { leadId: lead.id, score }, idempotencyKey: `lead.qualify:${lead.id}` });
    if (out.status === "done") {
      await ctx.tdb.query(
        `update bai_leads set service_id = $2, score = $3, status = $4, estimated_value_cents = $5,
           qualification = qualification || $6::text::jsonb, updated_at = now() where id = $1`,
        [lead.id, serviceId, score, qualified ? "qualified" : "unqualified", estimate, json({ reasons, injectionSignals: injected, method: "rule-based score v1" })]);
    }
    return { leadId: lead.id, ref: lead.ref, qualified, score, serviceId, estimatedValueCents: estimate, reasons, injectionSignals: injected };
  },
});

tool({
  name: "sales.follow_up_quotes", agent: "sales", scopes: ["quotes", "customers.pii", "leads"],
  description: "Follow up sent quotes with no answer after 3 days, once, only where CASL consent is valid.",
  async run(ctx) {
    const due = await ctx.tdb.query<{ id: string; ref: string; customer_id: string; email: string | null; name: string; total_cents: number; lead_id: string | null }>(
      `select q.id, q.ref, q.customer_id, c.email, c.name, q.total_cents, q.lead_id from bai_quotes q join bai_customers c on c.id = q.customer_id
       where q.status = 'sent' and q.sent_at < $1::timestamptz - interval '3 days' and (q.valid_until is null or q.valid_until >= $1::date)`, [ctx.now.toISOString()]);
    const results = [];
    const id = ctx.identification();
    for (const q of due) {
      if (!q.email) { results.push({ quote: q.ref, outcome: "skipped", reason: "no email address" }); continue; }
      const unsubscribeUrl = ctx.unsubscribeUrl(q.email);
      const bodyText = `Hello ${q.name},\n\nThis is the AI assistant for ${id.senderName}. We sent you quote ${q.ref} (${money(q.total_cents)}). Do you have any questions, or would you like to book a time?\n\n${id.senderName}\n${id.mailingAddress ?? ""}\nUnsubscribe: ${unsubscribeUrl}`;
      const out = await ctx.act({
        actionType: "message.follow_up", title: `Follow up quote ${q.ref}`, idempotencyKey: `follow_up:${q.id}`,
        payload: { quoteId: q.id, leadId: q.lead_id, message: { ...id, mailingAddress: id.mailingAddress ?? "", unsubscribeUrl, subject: `Your quote ${q.ref}`, bodyText, language: "en-CA", channel: "email" } },
        recipients: [{ customerId: q.customer_id, email: q.email }],
      });
      results.push({ quote: q.ref, outcome: out.status, ...(out.status === "blocked" ? { reason: out.reason } : {}) });
    }
    return { considered: due.length, results };
  },
});

tool({
  name: "sales.lost_reasons", agent: "sales", scopes: ["leads", "quotes"],
  description: "Summarise why enquiries were lost or declined over the last 90 days.",
  async run(ctx) {
    const rows = await ctx.tdb.query<{ reason: string; n: number }>(
      `select coalesce(lost_reason, case status when 'unqualified' then 'not qualified' else 'no reason recorded' end) reason, count(*)::int n
       from bai_leads where status in ('lost','unqualified') and created_at > $1::timestamptz - interval '90 days' group by 1 order by 2 desc`, [ctx.now.toISOString()]);
    const declined = await one<{ n: number }>(ctx.tdb, "select count(*)::int n from bai_quotes where status in ('declined','expired') and created_at > $1::timestamptz - interval '90 days'", [ctx.now.toISOString()]);
    const top = rows[0];
    if (top && top.n >= 3) {
      await ctx.recommend({ kind: "issue", title: `Most common reason enquiries are lost: ${top.reason}`, rationale: `${top.n} of ${rows.reduce((s, r) => s + r.n, 0)} lost or unqualified enquiries in 90 days.`,
        dataBasis: { rows }, dedupeKey: `lost_reasons:${ctx.now.toISOString().slice(0, 7)}` });
    }
    return { reasons: rows, quotesDeclinedOrExpired: declined.n };
  },
});

// ---------------------------------------------------------------- quotation agent

tool({
  name: "quote.prepare", agent: "quotation", scopes: ["leads", "services", "quotes"],
  description: "Prepare a quote from approved pricing rules and configured tax; send it within the owner's limits (otherwise ask).",
  async run(ctx, input: { leadId: string; discountPct?: number }) {
    const lead = await maybeOne<LeadRow>(ctx.tdb, "select * from bai_leads where id = $1", [input.leadId]);
    if (!lead) throw new PermanentError("lead not found");
    if (!lead.service_id) return { prepared: false, missing: ["which service the customer needs"] };
    const existing = await maybeOne<{ id: string; ref: string; status: string }>(ctx.tdb, "select id, ref, status from bai_quotes where lead_id = $1 order by created_at desc limit 1", [lead.id]);
    if (existing) return { prepared: false, alreadyQuoted: existing };
    const svc = await serviceRow(ctx, lead.service_id);
    if (!svc) return { prepared: false, missing: ["active service"] };
    const tax = businessTax(ctx);
    if (tax.note && tax.bp === 0 && ctx.profile.financial.gstHstRegistered) return { prepared: false, missing: ["business province (tax jurisdiction)"] };
    const discount = Math.min(input.discountPct ?? 0, ctx.policy.max_discount_pct);
    const price = priceJob(svc, lead.quantity ? Number(lead.quantity) : null, tax, discount);
    if (!price.ok) {
      await ctx.recommend({ kind: "issue", title: `Quote for ${lead.ref} needs information`, rationale: `Missing: ${price.missing.join(", ")}.`, dedupeKey: `quote_missing:${lead.id}` });
      return { prepared: false, missing: price.missing };
    }
    const out = await ctx.act({ actionType: "quote.prepare", title: `Prepare quote for ${lead.ref}`, payload: { leadId: lead.id, totalCents: price.totalCents }, idempotencyKey: `quote.prepare:${lead.id}` });
    if (out.status !== "done") return { prepared: false, outcome: out };
    const ref = await nextRef(ctx.tdb, "quote", "Q");
    const validUntil = new Date(ctx.now.getTime() + ctx.policy.quote_valid_days * 86_400_000).toISOString().slice(0, 10);
    const assumptions = [...price.assumptions, ...(tax.note ? [tax.note] : [])];
    const q = await one<{ id: string }>(ctx.tdb,
      `insert into bai_quotes (ref, lead_id, customer_id, lines, subtotal_cents, discount_cents, tax_cents, tax_rate_bp, total_cents, valid_until, assumptions)
       values ($1, $2, $3, $4::text::jsonb, $5, $6, $7, $8, $9, $10, $11::text::jsonb) returning id`,
      [ref, lead.id, lead.customer_id, json(price.lines), price.subtotalCents, -price.lines.filter((l) => l.amountCents < 0).reduce((s, l) => s + l.amountCents, 0),
        price.taxCents, price.taxBp, price.totalCents, validUntil, json(assumptions)]);
    const customer = await one<{ name: string; email: string | null }>(ctx.tdb, "select name, email from bai_customers where id = $1", [lead.customer_id]);
    const lines = price.lines.map((l) => `- ${l.description}: ${money(l.amountCents)}`).join("\n");
    const fromMarketplace = (await one<{ channel: string }>(ctx.tdb, "select channel from bai_leads where id = $1", [lead.id])).channel === "conaro-marketplace";
    if (fromMarketplace) {
      // The marketplace owns quotes on its requests: this price is for the provider to enter there.
      await ctx.adminTask(`Enter quote ${ref} (${money(price.totalCents)}) for enquiry ${lead.ref} in your CONARO provider dashboard`, "task", `mk_quote:${q.id}`);
      return { prepared: true, quoteId: q.id, ref, totalCents: price.totalCents, send: "enter_on_marketplace", assumptions };
    }
    const send = await ctx.act({
      actionType: "quote.send", title: `Send quote ${ref} (${money(price.totalCents)})`, idempotencyKey: `quote.send:${q.id}`,
      summary: `${svc.name} for ${customer.name}`,
      payload: { quoteId: q.id, leadId: lead.id, totalCents: price.totalCents, discountPct: discount,
        message: { customerId: lead.customer_id, channel: "email", body: `Hello ${customer.name},\n\nHere is your quote ${ref} from ${ctx.tenant.name} (prepared by our AI assistant, valid until ${validUntil}):\n${lines}\nTax (${price.taxLabel}): ${money(price.taxCents)}\nTotal: ${money(price.totalCents)}\n\nReply to accept or ask a question.` } },
    });
    if (send.status === "approval_pending") await ctx.tdb.query("update bai_quotes set status = 'pending_approval' where id = $1", [q.id]);
    return { prepared: true, quoteId: q.id, ref, totalCents: price.totalCents, send: send.status, assumptions };
  },
});

tool({
  name: "quote.acceptance_review", agent: "quotation", scopes: ["quotes", "services", "leads"],
  description: "Quote acceptance by service over 90 days; flags services with at least 5 decided quotes and acceptance under 30%.",
  async run(ctx) {
    const rows = await ctx.tdb.query<{ service: string; decided: number; accepted: number; avg_total: number }>(
      `select s.name service, count(*) filter (where q.status in ('accepted','declined','expired'))::int decided,
         count(*) filter (where q.status = 'accepted')::int accepted, coalesce(avg(q.total_cents), 0)::int avg_total
       from bai_quotes q join bai_leads l on l.id = q.lead_id join bai_services s on s.id = l.service_id
       where q.created_at > $1::timestamptz - interval '90 days' group by s.name`, [ctx.now.toISOString()]);
    for (const r of rows) {
      if (r.decided >= 5 && r.accepted / r.decided < 0.3) {
        await ctx.recommend({ kind: "recommendation", title: `Review pricing or scope for ${r.service}`, rationale: `${r.accepted} of ${r.decided} decided quotes accepted in 90 days.`,
          assumptions: ["Thresholds (at least 5 decided quotes, under 30% accepted) are review triggers, not market benchmarks.", "No competitor prices were used."],
          dataBasis: r, dedupeKey: `acceptance:${r.service}:${ctx.now.toISOString().slice(0, 7)}` });
      }
    }
    return { byService: rows.map((r) => ({ ...r, acceptanceRate: r.decided ? r.accepted / r.decided : null })) };
  },
});

// ---------------------------------------------------------------- CRM agent

tool({
  name: "crm.record_opportunity", agent: "crm", scopes: ["customers.pii"],
  description: "Record the opportunity on the customer's relationship record.",
  async run(ctx, input: { leadId: string; serviceId?: string | null; estimatedValueCents?: number | null }) {
    const lead = await one<{ customer_id: string; ref: string }>(ctx.tdb, "select customer_id, ref from bai_leads where id = $1", [input.leadId]);
    const out = await ctx.act({ actionType: "customer.update", title: `Record opportunity ${lead.ref}`, payload: { customerId: lead.customer_id }, idempotencyKey: `crm.opportunity:${input.leadId}` });
    if (out.status === "done") {
      await ctx.tdb.query(
        `update bai_customers set last_activity_at = now(), preferences = jsonb_set(preferences, '{openOpportunities}', to_jsonb(coalesce((preferences->>'openOpportunities')::int, 0) + 1)) where id = $1`,
        [lead.customer_id]);
    }
    return { customerId: lead.customer_id, recorded: out.status === "done" };
  },
});

tool({
  name: "crm.inactive_customers", agent: "crm", scopes: ["customers.pii", "bookings"],
  description: "Find past customers with no booking in 180 days and draft a reactivation opportunity (counts only; sending needs consent and approval).",
  async run(ctx) {
    const rows = await ctx.tdb.query<{ id: string; email: string | null }>(
      `select c.id, c.email from bai_customers c where exists (select 1 from bai_bookings b where b.customer_id = c.id and b.status = 'completed')
         and not exists (select 1 from bai_bookings b where b.customer_id = c.id and b.starts_at > $1::timestamptz - interval '180 days')`, [ctx.now.toISOString()]);
    if (rows.length > 0) {
      await ctx.recommend({ kind: "opportunity", title: `${rows.length} past customers have not booked in 6 months`, rationale: "A reactivation campaign can be drafted; only customers with valid consent would receive it.",
        dataBasis: { inactive: rows.length, withEmail: rows.filter((r) => r.email).length }, dedupeKey: `inactive:${ctx.now.toISOString().slice(0, 7)}` });
    }
    return { inactiveCustomers: rows.length };
  },
});

tool({
  name: "crm.post_job_follow_up", agent: "crm", scopes: ["customers.pii", "jobs", "bookings"],
  description: "Thank the customer after a completed job (transactional) and record a repeat-booking opportunity for recurring services.",
  async run(ctx, input: { jobId: string }) {
    const j = await one<{ customer_id: string; name: string; service: string; recurrence: string | null; ref: string; source: string }>(ctx.tdb,
      `select b.customer_id, c.name, s.name service, b.recurrence, j.ref, b.source from bai_jobs j join bai_bookings b on b.id = j.booking_id
       join bai_customers c on c.id = b.customer_id join bai_services s on s.id = b.service_id where j.id = $1`, [input.jobId]);
    // Marketplace bookings: the marketplace messages its own customers.
    const out = j.source === "conaro-marketplace" ? { status: "left to the CONARO marketplace" } : await ctx.act({ actionType: "message.transactional", title: `Thank-you for job ${j.ref}`, idempotencyKey: `thanks:${input.jobId}`,
      payload: { jobId: input.jobId, message: { customerId: j.customer_id, channel: "email", body: `Hello ${j.name}, thank you for choosing ${ctx.tenant.name} for your ${j.service}. If anything isn't right, reply to this message. — ${ctx.tenant.name} (sent by our AI assistant)` } } });
    if (ctx.pack.workflows.recurring && !j.recurrence) {
      await ctx.recommend({ kind: "opportunity", title: `Offer a recurring ${j.service} schedule to this customer`, rationale: "Recurring service is common in this industry and the job is complete.", dedupeKey: `recurring_offer:${input.jobId}` });
    }
    return { thankYou: out.status };
  },
});

// ---------------------------------------------------------------- customer service agent

const ReplySchema = z.object({ reply: z.string(), escalate: z.boolean() });

tool({
  name: "service.draft_reply", agent: "customer-service", scopes: ["profile", "services", "customers.pii", "leads"],
  description: "Answer an enquiry from approved business information only; escalate anything it cannot answer.",
  async run(ctx, input: { leadId: string; quoteRef?: string | null; available?: boolean | null }) {
    const lead = await one<{ ref: string; description: string; customer_id: string; service_id: string | null; status: string; channel: string }>(ctx.tdb,
      "select ref, description, customer_id, service_id, status, channel from bai_leads where id = $1", [input.leadId]);
    const customer = await one<{ name: string; language: string }>(ctx.tdb, "select name, language from bai_customers where id = $1", [lead.customer_id]);
    const svc = lead.service_id ? await one<{ name: string; description: string; limitations: string }>(ctx.tdb, "select name, description, limitations from bai_services where id = $1", [lead.service_id]) : null;
    const signals = injectionSignals(lead.description);
    // Deterministic answer from approved facts. Used as-is when no model is configured or the plan's AI limit is reached.
    const facts = [
      svc ? `We offer ${svc.name}.${svc.description ? ` ${svc.description}` : ""}${svc.limitations ? ` Please note: ${svc.limitations}` : ""}` : "We'll check whether this is a service we provide and get back to you.",
      input.quoteRef ? `We've prepared quote ${input.quoteRef}; you'll receive it separately once it is sent.` : null,
      input.available === true ? "We appear to have availability around the time you asked for; we'll confirm once the booking is validated." : input.available === false ? "We may not be available at the time you asked for; we'll suggest other times." : null,
      ctx.profile.operations.cancellationPolicy ? `Our cancellation policy: ${ctx.profile.operations.cancellationPolicy}` : null,
    ].filter(Boolean).join(" ");
    let reply = `Hello ${customer.name}, this is the AI assistant for ${ctx.tenant.name}. Thank you for your request (${lead.ref}). ${facts} A member of our team will follow up if needed.`;
    let escalate = !svc || signals.length > 0;
    let usedModel = false;
    if (await meter(ctx.tdb, "ai_calls")) {
      const wrapped = wrapUntrusted("customer enquiry", lead.description);
      const started = Date.now();
      const res = await ctx.deps.reasoning.analyse({
        agentId: `business-ai:${ctx.agent.id}`, taskId: `reply:${lead.ref}`,
        system: `You are the customer service assistant for ${ctx.tenant.name}. Say you are an AI assistant. Use ONLY these approved facts: ${facts}. Never confirm bookings, prices, payments, guarantees or policies that are not in the facts. If unsure, say a person will follow up. ${UNTRUSTED_DATA_POLICY} Put the reply text in "summary".`,
        prompt: `Write a short reply to this enquiry.\n${wrapped.text}`,
      });
      await ctx.tdb.query("insert into bai_ai_usage (agent_id, purpose, provider, model, outcome, input_tokens, output_tokens, latency_ms) values ($1, 'draft_reply', $2, $3, $4, $5, $6, $7)",
        [ctx.agent.id, res.usage.provider, res.usage.model, res.usage.outcome, res.usage.inputTokens, res.usage.outputTokens, Date.now() - started]);
      if (!res.simulated && res.analysis.summary.trim()) {
        reply = res.analysis.summary.trim();
        usedModel = true;
        if (res.analysis.injectionAttemptsObserved.length) escalate = true;
      }
    }
    ReplySchema.parse({ reply, escalate });
    if (escalate) {
      await ctx.recommend({ kind: "issue", title: `Enquiry ${lead.ref} needs a person`, rationale: signals.length ? "The message contains instructions aimed at the assistant; treated as data and escalated." : "No matching service; the assistant did not guess.", dedupeKey: `escalate:${input.leadId}` });
    }
    const out = await ctx.act({ actionType: "message.reply", title: `Reply to ${lead.ref}`, idempotencyKey: `reply:${input.leadId}`,
      payload: { leadId: input.leadId, escalated: escalate, message: { customerId: lead.customer_id, channel: lead.channel === "conaro-marketplace" ? "conaro-marketplace" : "email", body: reply } } });
    return { reply, escalate, usedModel, outcome: out.status };
  },
});

tool({
  name: "service.booking_confirmation", agent: "customer-service", scopes: ["bookings", "customers.pii"],
  description: "Tell the customer their booking is confirmed, only after it actually is.",
  async run(ctx, input: { bookingId: string }) {
    const b = await one<{ ref: string; status: string; customer_id: string; name: string; starts_at: string; service: string }>(ctx.tdb,
      `select b.ref, b.status, b.customer_id, c.name, b.starts_at, s.name service from bai_bookings b join bai_customers c on c.id = b.customer_id
       join bai_services s on s.id = b.service_id where b.id = $1`, [input.bookingId]);
    if (b.status !== "confirmed") return { sent: false, reason: `booking is ${b.status}, not confirmed` };
    const when = new Date(b.starts_at).toLocaleString("en-CA", { timeZone: ctx.tenant.time_zone, dateStyle: "full", timeStyle: "short" });
    const out = await ctx.act({ actionType: "message.transactional", title: `Confirm booking ${b.ref} to customer`, idempotencyKey: `booking_confirmation:${input.bookingId}`,
      payload: { bookingId: input.bookingId, message: { customerId: b.customer_id, channel: "email", body: `Hello ${b.name}, your ${b.service} with ${ctx.tenant.name} is confirmed for ${when} (booking ${b.ref}). — sent by our AI assistant` } } });
    return { sent: true, outcome: out.status };
  },
});
