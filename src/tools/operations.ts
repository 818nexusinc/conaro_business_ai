import { createHash } from "node:crypto";
import { json, maybeOne, one } from "../shared/db.ts";
import { PermanentError } from "../shared/errors.ts";
import { injectionSignals } from "../shared/untrusted.ts";
import { nextRef } from "../tenancy.ts";
import type { AgentContext } from "../agent-context.ts";
import { addDays, isoDate, localParts, money, toMinutes, zonedTime } from "../time.ts";
import { tool } from "./registry.ts";
import { businessTax, priceJob, serviceRow, type PriceLine } from "./revenue.ts";

// ---------------------------------------------------------------- availability (booking agent)

interface Availability {
  available: boolean;
  startsAt: string;
  endsAt: string | null;
  eligibleEmployees: { id: string; name: string }[];
  reasons: string[];
  notes: string[];
}

export async function checkAvailability(ctx: AgentContext, serviceId: string, startsAt: Date, excludeBookingId?: string): Promise<Availability> {
  const tz = ctx.tenant.time_zone;
  const svc = await one<{ name: string; duration_minutes: number | null; required_skill: string | null; seasonal_months: number[]; active: boolean }>(ctx.tdb,
    "select name, duration_minutes, required_skill, seasonal_months, active from bai_services where id = $1", [serviceId]);
  const reasons: string[] = [];
  const notes: string[] = [];
  if (!svc.active) reasons.push("service is not active");
  if (!svc.duration_minutes) {
    return { available: false, startsAt: startsAt.toISOString(), endsAt: null, eligibleEmployees: [], reasons: ["service duration is not set, so the slot cannot be validated"], notes };
  }
  const endsAt = new Date(startsAt.getTime() + svc.duration_minutes * 60_000);
  const s = localParts(startsAt, tz);
  const e = localParts(endsAt, tz);
  if (s.date !== e.date) reasons.push("job would run past midnight");
  const month = Number(s.date.slice(5, 7));
  if (svc.seasonal_months.length && !svc.seasonal_months.includes(month)) reasons.push(`${svc.name} is out of season in that month`);
  const hours = ctx.profile.identity.hours?.[String(s.weekday) as "1"];
  if (!hours) reasons.push("the business is closed that day (or business hours are not set)");
  else if (s.minutes < toMinutes(hours[0]) || e.minutes > toMinutes(hours[1])) reasons.push(`outside business hours (${hours[0]}–${hours[1]})`);
  const lead = ctx.profile.operations.bookingLeadTimeHours ?? 0;
  if (startsAt.getTime() < ctx.now.getTime() + lead * 3_600_000) reasons.push(lead ? `less than the ${lead}-hour booking lead time` : "time is in the past");
  if (ctx.pack.workflows.weatherAware) notes.push("Weather-dependent service: no weather service is connected, so check the forecast before the day.");
  const buffer = ctx.pack.workflows.mobile ? ctx.policy.travel_buffer_minutes : 0;
  const employees = await ctx.tdb.query<{ id: string; name: string; skills: string[]; availability: Record<string, [string, string]> }>(
    "select id, name, skills, availability from bai_employees where active order by name");
  const eligible: { id: string; name: string }[] = [];
  for (const emp of employees) {
    if (svc.required_skill && !emp.skills.includes(svc.required_skill)) continue;
    const w = emp.availability[String(s.weekday)];
    if (!w || s.minutes < toMinutes(w[0]) || e.minutes > toMinutes(w[1])) continue;
    const clash = await maybeOne(ctx.tdb,
      `select 1 from bai_bookings where employee_id = $1 and status in ('requested','confirmed') and ($4::uuid is null or id <> $4::uuid)
         and starts_at < $3::timestamptz + make_interval(mins => $5) and ends_at > $2::timestamptz - make_interval(mins => $5)`,
      [emp.id, startsAt.toISOString(), endsAt.toISOString(), excludeBookingId ?? null, buffer]);
    if (!clash) eligible.push({ id: emp.id, name: emp.name });
  }
  if (employees.length === 0) reasons.push("no team members are set up");
  else if (eligible.length === 0) reasons.push(svc.required_skill ? `no one with the skill "${svc.required_skill}" is free then` : "no one is free then (including travel time)");
  return { available: reasons.length === 0, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), eligibleEmployees: reasons.length ? [] : eligible, reasons, notes };
}

async function alternatives(ctx: AgentContext, serviceId: string, from: Date, max = 3): Promise<string[]> {
  const out: string[] = [];
  const tz = ctx.tenant.time_zone;
  let date = localParts(from, tz).date;
  for (let d = 0; d < 14 && out.length < max; d++, date = addDays(date, 1)) {
    const wd = localParts(zonedTime(date, "12:00", tz), tz).weekday;
    const h = ctx.profile.identity.hours?.[String(wd) as "1"];
    if (!h) continue;
    for (let m = toMinutes(h[0]); m < toMinutes(h[1]) && out.length < max; m += 30) {
      const at = zonedTime(date, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, tz);
      if (at <= from) continue;
      if ((await checkAvailability(ctx, serviceId, at)).available) { out.push(at.toISOString()); m += 90; }
    }
  }
  return out;
}

tool({
  name: "booking.check_availability", agent: "booking", scopes: ["services", "employees", "bookings"],
  description: "Validate a requested time against duration, hours, lead time, season, skills, staff windows, conflicts and travel time; suggest alternatives.",
  async run(ctx, input: { serviceId: string; startsAt?: string | null; date?: string | null; time?: string | null }) {
    const at = input.startsAt ? new Date(input.startsAt) : input.date ? zonedTime(input.date, input.time ?? "09:00", ctx.tenant.time_zone) : null;
    if (!at) return { checked: false, reason: "no date requested" };
    const a = await checkAvailability(ctx, input.serviceId, at);
    return { checked: true, ...a, alternatives: a.available ? [] : await alternatives(ctx, input.serviceId, at) };
  },
});

tool({
  name: "booking.confirm", agent: "booking", scopes: ["services", "employees", "bookings", "customers.pii"],
  description: "Create a booking for an accepted quote and confirm it only after availability is validated (rule or owner approval).",
  async run(ctx, input: { quoteId?: string; leadId?: string; serviceId: string; customerId: string; startsAt: string; recurrence?: "weekly" | "biweekly" | "monthly" }) {
    const at = new Date(input.startsAt);
    const key = `${input.quoteId ?? input.leadId ?? input.customerId}:${at.toISOString()}`;
    let booking = await maybeOne<{ id: string; ref: string; status: string }>(ctx.tdb,
      "select id, ref, status from bai_bookings where customer_id = $1 and service_id = $2 and starts_at = $3 and status <> 'cancelled'", [input.customerId, input.serviceId, at.toISOString()]);
    const check = await checkAvailability(ctx, input.serviceId, at, booking?.id);
    if (!booking) {
      if (!check.endsAt) return { booked: false, reasons: check.reasons };
      const ref = await nextRef(ctx.tdb, "booking", "BK");
      booking = await one<{ id: string; ref: string; status: string }>(ctx.tdb,
        `insert into bai_bookings (ref, customer_id, service_id, quote_id, lead_id, starts_at, ends_at, recurrence, area)
         values ($1, $2, $3, $4, $5, $6, $7, $8, (select area from bai_customers where id = $2)) returning id, ref, status`,
        [ref, input.customerId, input.serviceId, input.quoteId ?? null, input.leadId ?? null, at.toISOString(), check.endsAt, input.recurrence ?? null]);
    }
    if (booking.status === "confirmed") return { booked: true, bookingId: booking.id, ref: booking.ref, status: "confirmed" };
    if (!check.available) {
      await ctx.recommend({ kind: "issue", title: `Booking ${booking.ref} cannot be confirmed as requested`, rationale: check.reasons.join("; "), dedupeKey: `unconfirmable:${booking.id}` });
      return { booked: true, bookingId: booking.id, ref: booking.ref, status: "requested", confirmed: false, reasons: check.reasons, alternatives: await alternatives(ctx, input.serviceId, at) };
    }
    const employee = check.eligibleEmployees[0]!;
    const out = await ctx.act({
      actionType: "booking.confirm", title: `Confirm booking ${booking.ref} (${at.toLocaleString("en-CA", { timeZone: ctx.tenant.time_zone })})`,
      idempotencyKey: `booking.confirm:${key}`,
      summary: `Availability validated; ${employee.name} is free.`,
      payload: { bookingId: booking.id, employeeId: employee.id, availabilityValidated: true, validatedAt: ctx.now.toISOString() },
    });
    return { booked: true, bookingId: booking.id, ref: booking.ref, confirmation: out.status, notes: check.notes };
  },
});

tool({
  name: "booking.send_reminders", agent: "booking", scopes: ["bookings", "customers.pii"],
  description: "Send reminders for confirmed bookings starting within the configured window.",
  async run(ctx) {
    const due = await ctx.tdb.query<{ id: string; ref: string; customer_id: string; name: string; starts_at: string }>(
      `select b.id, b.ref, b.customer_id, c.name, b.starts_at from bai_bookings b join bai_customers c on c.id = b.customer_id
       where b.status = 'confirmed' and b.reminder_sent_at is null and b.starts_at > $1::timestamptz
         and b.starts_at <= $1::timestamptz + make_interval(hours => $2)`, [ctx.now.toISOString(), ctx.policy.reminder_hours_before]);
    const results = [];
    for (const b of due) {
      const when = new Date(b.starts_at).toLocaleString("en-CA", { timeZone: ctx.tenant.time_zone, dateStyle: "medium", timeStyle: "short" });
      const out = await ctx.act({ actionType: "reminder.send", title: `Reminder for ${b.ref}`, idempotencyKey: `reminder:${b.id}`,
        payload: { bookingId: b.id, message: { customerId: b.customer_id, channel: "email", body: `Reminder: your appointment with ${ctx.tenant.name} is on ${when} (booking ${b.ref}). Reply if you need to change it. — sent by our AI assistant` } } });
      results.push({ booking: b.ref, outcome: out.status });
    }
    return { due: due.length, results };
  },
});

tool({
  name: "booking.group_nearby", agent: "booking", scopes: ["bookings"],
  description: "Find days where jobs in the same area are spread across different days or people (route efficiency).",
  async run(ctx) {
    const rows = await ctx.tdb.query<{ area: string; days: number; people: number; n: number }>(
      `select area, count(distinct (starts_at at time zone $2)::date)::int days, count(distinct employee_id)::int people, count(*)::int n
       from bai_bookings where status in ('requested','confirmed') and area is not null and starts_at between $1::timestamptz and $1::timestamptz + interval '14 days'
       group by area having count(*) >= 3`, [ctx.now.toISOString(), ctx.tenant.time_zone]);
    for (const r of rows.filter((x) => x.days >= 3)) {
      await ctx.recommend({ kind: "opportunity", title: `${r.n} jobs in ${r.area} over ${r.days} days`, rationale: "Grouping nearby jobs on fewer days could reduce travel time. Rescheduling needs the customer's agreement.",
        dataBasis: r, dedupeKey: `group:${r.area}:${ctx.now.toISOString().slice(0, 10)}` });
    }
    return { areas: rows };
  },
});

// ---------------------------------------------------------------- workforce

tool({
  name: "workforce.assign", agent: "workforce", scopes: ["employees", "bookings"],
  description: "Assign an eligible employee (skill, window, no conflict) with the lightest week.",
  async run(ctx, input: { bookingId: string }) {
    const b = await one<{ ref: string; service_id: string; starts_at: string; employee_id: string | null }>(ctx.tdb, "select ref, service_id, starts_at, employee_id from bai_bookings where id = $1", [input.bookingId]);
    if (b.employee_id) return { assigned: true, employeeId: b.employee_id, already: true };
    const a = await checkAvailability(ctx, b.service_id, new Date(b.starts_at), input.bookingId);
    if (a.eligibleEmployees.length === 0) return { assigned: false, reasons: a.reasons };
    const loads = await ctx.tdb.query<{ employee_id: string; mins: number }>(
      `select employee_id, coalesce(sum(extract(epoch from ends_at - starts_at) / 60), 0)::int mins from bai_bookings
       where status in ('confirmed','requested') and starts_at between $1::timestamptz - interval '3 days' and $1::timestamptz + interval '4 days' group by employee_id`, [b.starts_at]);
    const load = new Map(loads.map((l) => [l.employee_id, l.mins]));
    const pick = [...a.eligibleEmployees].sort((x, y) => (load.get(x.id) ?? 0) - (load.get(y.id) ?? 0))[0]!;
    const out = await ctx.act({ actionType: "employee.assign", title: `Assign ${pick.name} to ${b.ref}`, payload: { bookingId: input.bookingId, employeeId: pick.id }, idempotencyKey: `assign:${input.bookingId}` });
    if (out.status === "done") await ctx.tdb.query("update bai_bookings set employee_id = $2 where id = $1 and employee_id is null", [input.bookingId, pick.id]);
    return { assigned: out.status === "done", employee: pick };
  },
});

export async function utilisation(ctx: AgentContext, fromDate: string, days: number) {
  const tz = ctx.tenant.time_zone;
  const employees = await ctx.tdb.query<{ id: string; name: string; availability: Record<string, [string, string]> }>("select id, name, availability from bai_employees where active");
  const start = zonedTime(fromDate, "00:00", tz);
  const end = zonedTime(addDays(fromDate, days), "00:00", tz);
  const booked = await ctx.tdb.query<{ employee_id: string | null; mins: number }>(
    `select employee_id, coalesce(sum(extract(epoch from ends_at - starts_at) / 60), 0)::int mins from bai_bookings
     where status in ('confirmed','completed') and starts_at >= $1 and starts_at < $2 group by employee_id`, [start.toISOString(), end.toISOString()]);
  const bookedBy = new Map(booked.map((b) => [b.employee_id, Number(b.mins)]));
  const people = employees.map((e) => {
    let available = 0;
    for (let d = 0; d < days; d++) {
      const wd = localParts(zonedTime(addDays(fromDate, d), "12:00", tz), tz).weekday;
      const w = e.availability[String(wd)];
      if (w) available += Math.max(0, toMinutes(w[1]) - toMinutes(w[0]));
    }
    const b = bookedBy.get(e.id) ?? 0;
    return { employeeId: e.id, name: e.name, availableMinutes: available, bookedMinutes: b, utilisation: available ? b / available : null };
  });
  const available = people.reduce((s, p) => s + p.availableMinutes, 0);
  const bookedTotal = people.reduce((s, p) => s + p.bookedMinutes, 0) + (bookedBy.get(null) ?? 0);
  return { from: fromDate, days, people, availableMinutes: available, bookedMinutes: bookedTotal, unusedMinutes: Math.max(0, available - bookedTotal), utilisation: available ? bookedTotal / available : null };
}

tool({
  name: "workforce.utilisation", agent: "workforce", scopes: ["employees", "bookings"],
  description: "Booked versus available minutes per person, last 7 days and next 14 days.",
  async run(ctx) {
    const today = localParts(ctx.now, ctx.tenant.time_zone).date;
    return { last7: await utilisation(ctx, addDays(today, -7), 7), next14: await utilisation(ctx, today, 14) };
  },
});

// ---------------------------------------------------------------- jobs

tool({
  name: "jobs.create_from_booking", agent: "operations", scopes: ["bookings", "jobs", "services"],
  description: "Create the job and its checklist (industry pack plus service limitations) for a confirmed booking.",
  async run(ctx, input: { bookingId: string }) {
    const b = await one<{ ref: string; status: string; service: string; limitations: string }>(ctx.tdb,
      "select b.ref, b.status, s.name service, s.limitations from bai_bookings b join bai_services s on s.id = b.service_id where b.id = $1", [input.bookingId]);
    if (b.status !== "confirmed") return { created: false, reason: `booking is ${b.status}` };
    const existing = await maybeOne<{ id: string; ref: string }>(ctx.tdb, "select id, ref from bai_jobs where booking_id = $1", [input.bookingId]);
    if (existing) return { created: false, jobId: existing.id, ref: existing.ref, already: true };
    const out = await ctx.act({ actionType: "job.create", title: `Create job for ${b.ref}`, payload: { bookingId: input.bookingId }, idempotencyKey: `job.create:${input.bookingId}` });
    if (out.status !== "done") return { created: false, outcome: out };
    const checklist = [...ctx.pack.checklist, ...(b.limitations ? [`Service limitations: ${b.limitations}`] : []), ...ctx.pack.safety.map((s) => `Safety: ${s}`), "Customer confirms completion"]
      .map((item) => ({ item, done: false }));
    const ref = await nextRef(ctx.tdb, "job", "J");
    const job = await one<{ id: string }>(ctx.tdb, "insert into bai_jobs (ref, booking_id, checklist) values ($1, $2, $3::text::jsonb) returning id", [ref, input.bookingId, json(checklist)]);
    return { created: true, jobId: job.id, ref, checklistItems: checklist.length };
  },
});

tool({
  name: "jobs.complete", agent: "operations", scopes: ["jobs", "bookings"],
  description: "Record a job's completion (reported by the business) and start the completion workflow.",
  async run(ctx, input: { jobId: string; outcome?: string; reportedBy: string }) {
    const j = await one<{ ref: string; status: string; booking_id: string }>(ctx.tdb, "select ref, status, booking_id from bai_jobs where id = $1", [input.jobId]);
    if (j.status === "completed") return { completed: true, already: true };
    const out = await ctx.act({ actionType: "job.complete", title: `Complete job ${j.ref}`, payload: { jobId: input.jobId, reportedBy: input.reportedBy }, idempotencyKey: `job.complete:${input.jobId}` });
    if (out.status !== "done") return { completed: false, outcome: out };
    await ctx.tdb.query("update bai_jobs set status = 'completed', completed_at = $2, outcome = $3 where id = $1", [input.jobId, ctx.now.toISOString(), input.outcome ?? null]);
    await ctx.tdb.query("update bai_bookings set status = 'completed' where id = $1", [j.booking_id]);
    const { emitEvent } = await import("../events.ts");
    await emitEvent(ctx.tdb, "job.completed", { jobId: input.jobId }, `job.completed:${input.jobId}`);
    return { completed: true, ref: j.ref };
  },
});

tool({
  name: "jobs.find_delays", agent: "operations", scopes: ["jobs", "bookings"],
  description: "Jobs whose booked end passed more than 2 hours ago without completion.",
  async run(ctx) {
    const rows = await ctx.tdb.query<{ id: string; ref: string; booking_ref: string }>(
      `select j.id, j.ref, b.ref booking_ref from bai_jobs j join bai_bookings b on b.id = j.booking_id
       where j.status in ('scheduled','in_progress') and b.ends_at < $1::timestamptz - interval '2 hours'`, [ctx.now.toISOString()]);
    for (const r of rows) await ctx.adminTask(`Record the outcome of job ${r.ref} (booking ${r.booking_ref}) or reschedule it`, "task", `delay:${r.id}`);
    return { delayed: rows.map((r) => r.ref) };
  },
});

// ---------------------------------------------------------------- invoicing

tool({
  name: "invoice.prepare", agent: "invoicing", scopes: ["jobs", "invoices", "services", "customers.pii"],
  description: "Prepare the invoice for a completed job from its accepted quote (or the approved service price), then issue it within the owner's rule.",
  async run(ctx, input: { jobId: string }) {
    const j = await one<{ ref: string; status: string; customer_id: string; service_id: string; quote_id: string | null; starts_at: string; ends_at: string; source: string }>(ctx.tdb,
      `select j.ref, j.status, b.customer_id, b.service_id, b.quote_id, b.starts_at, b.ends_at, b.source from bai_jobs j join bai_bookings b on b.id = j.booking_id where j.id = $1`, [input.jobId]);
    if (j.status !== "completed") return { prepared: false, reason: "job not completed" };
    if (j.source === "conaro-marketplace") return { prepared: false, reason: "paid through the CONARO marketplace; no separate invoice" };
    const existing = await maybeOne<{ id: string; ref: string }>(ctx.tdb, "select id, ref from bai_invoices where job_id = $1", [input.jobId]);
    if (existing) return { prepared: false, already: existing };
    let lines: PriceLine[]; let subtotal: number; let taxCents: number; let bp: number; let source: string;
    const quote = j.quote_id ? await maybeOne<{ lines: PriceLine[]; subtotal_cents: number; tax_cents: number; tax_rate_bp: number; status: string }>(ctx.tdb,
      "select lines, subtotal_cents, tax_cents, tax_rate_bp, status from bai_quotes where id = $1", [j.quote_id]) : null;
    if (quote && quote.status === "accepted") {
      ({ lines } = quote); subtotal = quote.subtotal_cents; taxCents = quote.tax_cents; bp = quote.tax_rate_bp; source = "accepted quote";
    } else {
      const svc = await serviceRow(ctx, j.service_id);
      const hours = (new Date(j.ends_at).getTime() - new Date(j.starts_at).getTime()) / 3_600_000;
      const p = svc ? priceJob(svc, svc.pricing_unit === "hourly" ? hours : null, businessTax(ctx)) : null;
      if (!p?.ok) {
        await ctx.adminTask(`Set the amount for job ${j.ref}: no accepted quote and the price cannot be calculated`, "task", `invoice_missing:${input.jobId}`);
        return { prepared: false, missing: p && !p.ok ? p.missing : ["service"] };
      }
      ({ lines } = p); subtotal = p.subtotalCents; taxCents = p.taxCents; bp = p.taxBp; source = "service price rules";
    }
    const out = await ctx.act({ actionType: "invoice.prepare", title: `Prepare invoice for job ${j.ref}`, payload: { jobId: input.jobId }, idempotencyKey: `invoice.prepare:${input.jobId}` });
    if (out.status !== "done") return { prepared: false, outcome: out };
    const ref = await nextRef(ctx.tdb, "invoice", "INV");
    const inv = await one<{ id: string }>(ctx.tdb,
      `insert into bai_invoices (ref, job_id, customer_id, lines, subtotal_cents, tax_cents, tax_rate_bp, total_cents) values ($1, $2, $3, $4::text::jsonb, $5, $6, $7, $8) returning id`,
      [ref, input.jobId, j.customer_id, json(lines), subtotal, taxCents, bp, subtotal + taxCents]);
    const customer = await one<{ name: string }>(ctx.tdb, "select name from bai_customers where id = $1", [j.customer_id]);
    const issue = await ctx.act({ actionType: "invoice.issue", title: `Issue invoice ${ref} (${money(subtotal + taxCents)})`, idempotencyKey: `invoice.issue:${inv.id}`,
      payload: { invoiceId: inv.id, totalCents: subtotal + taxCents, message: { customerId: j.customer_id, channel: "email", body: `Hello ${customer.name}, here is invoice ${ref} from ${ctx.tenant.name} for ${money(subtotal + taxCents)} (tax included). — sent by our AI assistant` } } });
    return { prepared: true, invoiceId: inv.id, ref, totalCents: subtotal + taxCents, source, issue: issue.status };
  },
});

/** Owner or staff records a payment received (an ACTUAL from the business). */
export async function recordPayment(ctx: AgentContext, input: { invoiceId: string; amountCents: number; method: string; receivedOn: string; recordedBy: string }) {
  const inv = await one<{ ref: string; total_cents: number; paid_cents: number; status: string }>(ctx.tdb, "select ref, total_cents, paid_cents, status from bai_invoices where id = $1", [input.invoiceId]);
  if (inv.status === "void" || inv.status === "draft") throw new PermanentError(`invoice is ${inv.status}`);
  if (input.amountCents <= 0) throw new PermanentError("amount must be positive");
  await ctx.tdb.query("insert into bai_payments (invoice_id, amount_cents, method, received_on, source, recorded_by) values ($1, $2, $3, $4, 'manual', $5)",
    [input.invoiceId, input.amountCents, input.method, input.receivedOn, input.recordedBy]);
  const paid = inv.paid_cents + input.amountCents;
  await ctx.tdb.query("update bai_invoices set paid_cents = $2, status = $3 where id = $1", [input.invoiceId, paid, paid >= inv.total_cents ? "paid" : "partially_paid"]);
  const { emitEvent } = await import("../events.ts");
  await emitEvent(ctx.tdb, "payment.received", { invoiceId: input.invoiceId, amountCents: input.amountCents }, `payment:${input.invoiceId}:${paid}`);
  return { ref: inv.ref, paidCents: paid, balanceCents: Math.max(0, inv.total_cents - paid), overpaidCents: Math.max(0, paid - inv.total_cents) };
}

tool({
  name: "invoice.record_payment", agent: "invoicing", scopes: ["invoices"],
  description: "Match a payment the business received to its invoice.",
  async run(ctx, input: { invoiceId: string; amountCents: number; method: string; receivedOn: string; recordedBy: string }) {
    return recordPayment(ctx, input);
  },
});

tool({
  name: "invoice.overdue_reminders", agent: "invoicing", scopes: ["invoices", "customers.pii"],
  description: "Remind customers about overdue invoices, at most once per configured interval.",
  async run(ctx) {
    const rows = await ctx.tdb.query<{ id: string; ref: string; customer_id: string; name: string; balance: number; due_on: string }>(
      `select i.id, i.ref, i.customer_id, c.name, (i.total_cents - i.paid_cents) balance, i.due_on from bai_invoices i join bai_customers c on c.id = i.customer_id
       where i.status in ('issued','partially_paid') and i.due_on < $1::date
         and (i.last_reminder_at is null or i.last_reminder_at < $1::timestamptz - make_interval(days => $2))`, [ctx.now.toISOString(), ctx.policy.payment_reminder_days]);
    const results = [];
    for (const r of rows) {
      const out = await ctx.act({ actionType: "payment.reminder", title: `Payment reminder for ${r.ref} (${money(r.balance)})`, idempotencyKey: `pay_reminder:${r.id}:${ctx.now.toISOString().slice(0, 10)}`,
        payload: { invoiceId: r.id, message: { customerId: r.customer_id, channel: "email", body: `Hello ${r.name}, invoice ${r.ref} from ${ctx.tenant.name} has a balance of ${money(r.balance)} that was due on ${isoDate(r.due_on)}. If you've already paid, thank you and please disregard. — sent by our AI assistant` } } });
      results.push({ invoice: r.ref, outcome: out.status });
    }
    return { overdue: rows.length, results };
  },
});

// ---------------------------------------------------------------- reputation

tool({
  name: "reputation.request_feedback", agent: "reputation", scopes: ["jobs", "customers.pii", "feedback"],
  description: "Ask for genuine feedback after a completed job (no incentive, no filtering by expected rating).",
  async run(ctx, input: { jobId: string }) {
    const j = await one<{ ref: string; status: string; customer_id: string; name: string; source: string }>(ctx.tdb,
      "select j.ref, j.status, b.customer_id, c.name, b.source from bai_jobs j join bai_bookings b on b.id = j.booking_id join bai_customers c on c.id = b.customer_id where j.id = $1", [input.jobId]);
    if (j.status !== "completed") return { requested: false, reason: "job not completed" };
    if (j.source === "conaro-marketplace") return { requested: false, reason: "the CONARO marketplace asks for reviews of its own bookings" };
    const out = await ctx.act({ actionType: "feedback.request", title: `Ask for feedback on ${j.ref}`, idempotencyKey: `feedback:${input.jobId}`,
      payload: { jobId: input.jobId, message: { customerId: j.customer_id, channel: "email", body: `Hello ${j.name}, how did we do on your recent job with ${ctx.tenant.name}? Your honest feedback, good or bad, helps us improve. — sent by our AI assistant` } } });
    return { requested: true, outcome: out.status };
  },
});

tool({
  name: "reputation.analyse_feedback", agent: "reputation", scopes: ["feedback"],
  description: "Average rating, negative feedback needing a reply, and recurring words in low ratings; drafts private replies (never published automatically).",
  async run(ctx) {
    const rows = await ctx.tdb.query<{ id: string; rating: number; comment: string; response_draft: string | null }>(
      "select id, rating, comment, response_draft from bai_feedback where created_at > $1::timestamptz - interval '90 days'", [ctx.now.toISOString()]);
    const avg = rows.length ? rows.reduce((s, r) => s + r.rating, 0) / rows.length : null;
    const negative = rows.filter((r) => r.rating <= 2);
    for (const n of negative.filter((r) => !r.response_draft)) {
      const draft = `Thank you for telling us. We're sorry the job did not meet your expectations. ${ctx.tenant.name} would like to make this right; please reply or call us so we can discuss it.`;
      await ctx.tdb.query("update bai_feedback set response_draft = $2 where id = $1", [n.id, draft]);
      await ctx.recommend({ kind: "issue", title: `Low rating (${n.rating}/5) needs a personal reply`, rationale: injectionSignals(n.comment).length ? "Comment contains text aimed at the assistant; treated as data." : "A draft reply is ready for review.", dedupeKey: `neg:${n.id}` });
    }
    const words = new Map<string, number>();
    for (const n of negative) for (const w of n.comment.toLowerCase().match(/[a-zà-ÿ]{5,}/g) ?? []) words.set(w, (words.get(w) ?? 0) + 1);
    const recurring = [...words].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { responses: rows.length, averageRating: avg, negative: negative.length, recurringWords: recurring };
  },
});

// ---------------------------------------------------------------- administrative assistant

tool({
  name: "admin.store_document", agent: "admin-assistant", scopes: ["documents"],
  description: "Store a text document (up to 1 MB) in the business's knowledge base; flags embedded instructions.",
  async run(ctx, input: { name: string; kind: string; text: string; uploadedBy: string }) {
    const size = Buffer.byteLength(input.text, "utf8");
    if (size > 1_048_576) throw new PermanentError("document is larger than 1 MB");
    if (!/^[\p{L}\p{N} ._()-]{1,120}$/u.test(input.name)) throw new PermanentError("document name has unsupported characters");
    const sha = createHash("sha256").update(input.text).digest("hex");
    const row = await one<{ id: string }>(ctx.tdb, "insert into bai_documents (name, kind, content_text, size_bytes, sha256, uploaded_by) values ($1, $2, $3, $4, $5, $6) returning id",
      [input.name, input.kind.slice(0, 40), input.text, size, sha, input.uploadedBy]);
    return { documentId: row.id, sizeBytes: size, injectionSignals: injectionSignals(input.text) };
  },
});

tool({
  name: "admin.search_documents", agent: "admin-assistant", scopes: ["documents"],
  description: "Search the business's documents by words.",
  async run(ctx, input: { query: string }) {
    const words = input.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
    if (!words.length) return { results: [] };
    const rows = await ctx.tdb.query<{ id: string; name: string; content_text: string }>(
      `select id, name, content_text from bai_documents where ${words.map((_, i) => `lower(content_text) like $${i + 1}`).join(" and ")} order by created_at desc limit 10`,
      words.map((w) => `%${w.replaceAll(/[%_\\]/g, "")}%`));
    return { results: rows.map((r) => { const i = r.content_text.toLowerCase().indexOf(words[0]!); return { id: r.id, name: r.name, excerpt: r.content_text.slice(Math.max(0, i - 80), i + 160) }; }) };
  },
});

tool({
  name: "admin.deadline_reminders", agent: "admin-assistant", scopes: ["operations.aggregate"],
  description: "Owner deadlines due within 7 days, and the open task count.",
  async run(ctx) {
    const due = await ctx.tdb.query<{ id: string; title: string; due_on: string }>(
      "select id, title, due_on from bai_admin_tasks where status = 'open' and due_on is not null and due_on <= $1::date + 7 order by due_on", [ctx.now.toISOString()]);
    for (const d of due) {
      await ctx.recommend({ kind: "issue", title: `Due ${isoDate(d.due_on)}: ${d.title}`, rationale: "Deadline within 7 days.", dedupeKey: `deadline:${d.id}` });
    }
    const open = await one<{ n: number }>(ctx.tdb, "select count(*)::int n from bai_admin_tasks where status = 'open'");
    return { dueSoon: due.length, openTasks: open.n };
  },
});
