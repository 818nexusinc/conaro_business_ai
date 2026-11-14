import { createHash } from "node:crypto";
import { json, one } from "../shared/db.ts";
import { PermanentError } from "../shared/errors.ts";
import type { TenantDb } from "../tenancy.ts";
import { tenantAudit } from "../audit.ts";
import type { AgentContext } from "../agent-context.ts";
import { SMALL_SUPPLIER_THRESHOLD_CENTS, TAX_SOURCE, taxRateFor } from "../catalog/tax.ts";
import { plural } from "../time.ts";
import { tool } from "./registry.ts";

/** Every figure shown to an owner carries its nature and source, or says why it is unavailable. */
export type Figure =
  | { label: "ACTUAL" | "ESTIMATE" | "FORECAST"; cents: number; source: string; note?: string }
  | { label: "UNAVAILABLE"; reason: string };
const actual = (cents: number, source: string, note?: string): Figure => ({ label: "ACTUAL", cents, source, ...(note ? { note } : {}) });
const unavailable = (reason: string): Figure => ({ label: "UNAVAILABLE", reason });

// ---------------------------------------------------------------- CSV import

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const toCents = (s: string) => {
  const v = Number(s.replaceAll(/[$\s,]/g, ""));
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
};

tool({
  name: "accounting.import_csv", agent: "accounting", scopes: ["finance"],
  description: "Import bank or card transactions from CSV (date, description, amount; negative = expense; optional category, tax). Skips exact re-imports; flags possible duplicates and unusual amounts.",
  async run(ctx, input: { csv: string; source: string }) {
    if (input.csv.length > 2_000_000) throw new PermanentError("file larger than 2 MB");
    const rows = parseCsv(input.csv);
    const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const col = (n: string) => header.indexOf(n);
    const [iDate, iDesc, iAmt, iCat, iTax] = [col("date"), col("description"), col("amount"), col("category"), col("tax")];
    if (iDate < 0 || iDesc < 0 || iAmt < 0) throw new PermanentError("CSV needs the columns date, description and amount");
    let imported = 0; let skipped = 0; const errors: string[] = [];
    for (const [n, r] of rows.entries()) {
      const date = r[iDate]?.trim() ?? ""; const desc = (r[iDesc] ?? "").trim().slice(0, 300); const amt = toCents(r[iAmt] ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !desc || !Number.isFinite(amt) || amt === 0) { errors.push(`row ${n + 2}: unreadable`); continue; }
      const hash = createHash("sha256").update(`${input.source}|${date}|${desc}|${amt}|${n}`).digest("hex");
      const tax = iTax >= 0 && r[iTax]?.trim() ? toCents(r[iTax]!) : null;
      const cat = iCat >= 0 ? r[iCat]?.trim() || null : null;
      const res = await ctx.tdb.query(
        `insert into bai_transactions (occurred_on, description, amount_cents, direction, category, category_source, tax_cents, source, import_hash, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unreviewed') on conflict (tenant_id, import_hash) do nothing returning id`,
        [date, desc, Math.abs(amt), amt < 0 ? "expense" : "income", cat, cat ? "import" : null, tax !== null && Number.isFinite(tax) ? Math.abs(tax) : null, input.source.slice(0, 60), hash]);
      if (res.length) imported++; else skipped++;
    }
    // Possible duplicates: same date, amount and direction from different imports or rows.
    await ctx.tdb.query(
      `update bai_transactions t set flags = array_append(t.flags, 'possible_duplicate') where not ('possible_duplicate' = any(t.flags))
         and exists (select 1 from bai_transactions o where o.id <> t.id and o.occurred_on = t.occurred_on and o.amount_cents = t.amount_cents and o.direction = t.direction)`);
    // Unusual: more than 3 times the median of the same direction (at least 5 earlier items).
    await ctx.tdb.query(
      `with m as (select direction, percentile_cont(0.5) within group (order by amount_cents) med, count(*) n from bai_transactions group by direction)
       update bai_transactions t set flags = array_append(t.flags, 'unusual_amount') from m
       where m.direction = t.direction and m.n >= 5 and t.amount_cents > 3 * m.med and not ('unusual_amount' = any(t.flags))`);
    await tenantAudit(ctx.tdb, { actor: `agent:${ctx.agent.id}`, action: "transactions.imported", subjectType: "transactions", detail: { imported, skipped, errors: errors.length, source: input.source } });
    return { imported, skipped, errors };
  },
});

const KEYWORDS: [RegExp, string][] = [
  [/\b(petro|esso|shell|irving|ultramar|gas station|fuel)\b/i, "Vehicle fuel"],
  [/\binsur/i, "Insurance"],
  [/\b(home depot|kent|rona|lowe'?s|canadian tire|supplies?)\b/i, "Supplies and materials"],
  [/\b(google ads|meta|facebook ads|advertis)/i, "Advertising"],
  [/\b(bell|rogers|telus|eastlink|mobile|phone)\b/i, "Phone and internet"],
  [/\b(software|subscription|microsoft|adobe|quickbooks|xero)\b/i, "Software"],
  [/\b(bank fee|service charge|monthly fee|interest)\b/i, "Bank charges"],
  [/\b(rent|lease)\b/i, "Rent"],
  [/\b(stripe|square|e-?transfer|deposit|payment from)\b/i, "Service revenue"],
];

tool({
  name: "accounting.suggest_categories", agent: "accounting", scopes: ["finance"],
  description: "Suggest categories for uncategorised transactions from the owner's own past confirmations, then keyword rules. Suggestions only; the owner confirms.",
  async run(ctx) {
    const pending = await ctx.tdb.query<{ id: string; description: string; direction: string }>(
      "select id, description, direction from bai_transactions where category is null and suggested_category is null limit 500");
    const learned = await ctx.tdb.query<{ prefix: string; category: string }>(
      `select lower(left(description, 12)) prefix, mode() within group (order by category) category from bai_transactions
       where status = 'confirmed' and category is not null group by 1`);
    const memo = new Map(learned.map((l) => [l.prefix, l.category]));
    let suggested = 0;
    for (const t of pending) {
      const fromHistory = memo.get(t.description.toLowerCase().slice(0, 12));
      const rule = KEYWORDS.find(([re]) => re.test(t.description));
      const cat = fromHistory ?? rule?.[1] ?? null;
      if (!cat) continue;
      const out = await ctx.act({ actionType: "bookkeeping.suggest_category", title: `Suggest ${cat}`, payload: { transactionId: t.id, category: cat }, idempotencyKey: `suggest:${t.id}` });
      if (out.status !== "done") continue;
      await ctx.tdb.query("update bai_transactions set suggested_category = $2, suggestion_reason = $3 where id = $1 and category is null",
        [t.id, cat, fromHistory ? "same description as earlier transactions you categorised" : `matched the keyword rule for ${cat}`]);
      await ctx.tdb.query("insert into bai_transaction_events (transaction_id, actor, change) values ($1, $2, $3::text::jsonb)", [t.id, `agent:${ctx.agent.id}`, json({ suggested: cat })]);
      suggested++;
    }
    return { considered: pending.length, suggested, left: pending.length - suggested };
  },
});

/** The owner (or accountant) confirms or changes a category. Every change is kept. */
export async function confirmCategory(tdb: TenantDb, transactionId: string, category: string, actor: string): Promise<void> {
  const prev = await one<{ category: string | null; suggested_category: string | null }>(tdb, "select category, suggested_category from bai_transactions where id = $1", [transactionId]);
  const cat = category.trim().slice(0, 60);
  if (!cat) throw new PermanentError("category required");
  await tdb.query("update bai_transactions set category = $2, category_source = 'owner', status = 'confirmed' where id = $1", [transactionId, cat]);
  await tdb.query("insert into bai_transaction_events (transaction_id, actor, change) values ($1, $2, $3::text::jsonb)", [transactionId, actor, json({ from: prev.category, to: cat, suggestion: prev.suggested_category })]);
}

export async function profitAndLoss(tdb: TenantDb, from: string, to: string) {
  const rows = await tdb.query<{ direction: string; category: string; cents: number; n: number; unreviewed: number }>(
    `select direction, coalesce(category, 'Uncategorised') category, sum(amount_cents)::bigint cents, count(*)::int n, count(*) filter (where status = 'unreviewed')::int unreviewed
     from bai_transactions where occurred_on between $1 and $2 group by 1, 2 order by 1, 3 desc`, [from, to]);
  const sum = (d: string) => rows.filter((r) => r.direction === d).reduce((s, r) => s + Number(r.cents), 0);
  const unreviewed = rows.reduce((s, r) => s + r.unreviewed, 0);
  const note = unreviewed ? `${unreviewed} transactions not yet reviewed by the owner` : undefined;
  return {
    from, to,
    income: rows.length ? actual(sum("income"), "imported transactions", note) : unavailable("no transactions imported for this period"),
    expenses: rows.length ? actual(sum("expense"), "imported transactions", note) : unavailable("no transactions imported for this period"),
    net: rows.length ? actual(sum("income") - sum("expense"), "imported transactions", note) : unavailable("no transactions imported for this period"),
    byCategory: rows.map((r) => ({ ...r, cents: Number(r.cents) })),
  };
}

tool({
  name: "accounting.profit_and_loss", agent: "accounting", scopes: ["finance"],
  description: "Profit and loss from recorded transactions (cash basis), with unreviewed items counted.",
  async run(ctx, input: { from: string; to: string }) { return profitAndLoss(ctx.tdb, input.from, input.to); },
});

tool({
  name: "accounting.export_csv", agent: "accounting", scopes: ["finance"],
  description: "Accountant export of transactions with category, source and review status.",
  async run(ctx, input: { from: string; to: string }) {
    const rows = await ctx.tdb.query<Record<string, unknown>>(
      `select occurred_on, description, case direction when 'expense' then -amount_cents else amount_cents end amount_cents, category, category_source, status, tax_cents, source
       from bai_transactions where occurred_on between $1 and $2 order by occurred_on`, [input.from, input.to]);
    const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v instanceof Date ? v.toISOString().slice(0, 10) : v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replaceAll('"', '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
    const head = "date,description,amount,category,category_source,status,tax,source";
    const body = rows.map((r) => [r.occurred_on, r.description, (Number(r.amount_cents) / 100).toFixed(2), r.category, r.category_source, r.status, r.tax_cents === null ? "" : (Number(r.tax_cents) / 100).toFixed(2), r.source].map(esc).join(","));
    return { csv: [head, ...body].join("\n"), rows: rows.length };
  },
});

// ---------------------------------------------------------------- tax

export async function gstHstSummary(tdb: TenantDb, province: string | undefined, registered: boolean, from: string, to: string) {
  const rate = taxRateFor(province, registered);
  const collected = await one<{ cents: number; n: number }>(tdb,
    "select coalesce(sum(tax_cents), 0)::bigint cents, count(*)::int n from bai_invoices where status <> 'void' and status <> 'draft' and issued_at::date between $1 and $2", [from, to]);
  const paid = await one<{ cents: number; n: number; missing: number }>(tdb,
    `select coalesce(sum(tax_cents), 0)::bigint cents, count(*) filter (where tax_cents is not null)::int n, count(*) filter (where tax_cents is null)::int missing
     from bai_transactions where direction = 'expense' and occurred_on between $1 and $2`, [from, to]);
  const c = Number(collected.cents); const p = Number(paid.cents);
  return {
    period: { from, to }, rate,
    taxCollected: { label: "ESTIMATE", cents: c, source: `tax on ${collected.n} issued invoices` } as Figure,
    taxPaidOnExpenses: { label: "ESTIMATE", cents: p, source: `tax recorded on ${paid.n} expense transactions` } as Figure,
    netEstimate: { label: "ESTIMATE", cents: c - p, source: "collected minus tax paid on expenses", note: "Not a confirmed liability. Input tax credits depend on eligibility and supporting documents; confirm with your accountant." } as Figure,
    missingDocumentation: paid.missing ? [`${paid.missing} expense transactions have no tax amount recorded`] : [],
    disclaimer: "Prepared by an AI assistant, not a licensed accountant or tax professional. Filing and remittance are done by you or your accountant.",
    source: TAX_SOURCE.rates,
  };
}

tool({
  name: "tax.gst_hst_summary", agent: "tax", scopes: ["finance", "invoices", "tax", "profile"],
  description: "GST/HST collected and paid for a period, labelled as estimates, with missing documentation.",
  async run(ctx, input: { from: string; to: string }) {
    const s = await gstHstSummary(ctx.tdb, ctx.profile.identity.province, ctx.profile.financial.gstHstRegistered === true, input.from, input.to);
    for (const m of s.missingDocumentation) await ctx.adminTask(`Tax records: ${m} (${input.from} to ${input.to})`, "task", `tax_missing:${input.from}:${input.to}`);
    return s;
  },
});

tool({
  name: "tax.registration_check", agent: "tax", scopes: ["finance", "invoices", "profile", "tax"],
  description: "If the business is not GST/HST registered, compare the last four calendar quarters of recorded revenue with the $30,000 small-supplier threshold.",
  async run(ctx) {
    if (ctx.profile.financial.gstHstRegistered !== false) return { applicable: false, reason: ctx.profile.financial.gstHstRegistered ? "already registered" : "registration status not set" };
    const q = Math.floor(ctx.now.getUTCMonth() / 3);
    const start = new Date(Date.UTC(ctx.now.getUTCFullYear(), q * 3 - 12, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(ctx.now.getUTCFullYear(), q * 3, 0)).toISOString().slice(0, 10);
    const rev = await one<{ inv: number; tx: number }>(ctx.tdb,
      `select (select coalesce(sum(subtotal_cents), 0) from bai_invoices where status not in ('void','draft') and issued_at::date between $1 and $2)::bigint inv,
              (select coalesce(sum(amount_cents), 0) from bai_transactions where direction = 'income' and occurred_on between $1 and $2)::bigint tx`, [start, end]);
    const recorded = Math.max(Number(rev.inv), Number(rev.tx));
    const over = recorded > SMALL_SUPPLIER_THRESHOLD_CENTS;
    if (over) {
      await ctx.recommend({ kind: "issue", title: "Recorded revenue is above the GST/HST small-supplier threshold",
        rationale: `Recorded revenue for ${start} to ${end} is above $30,000. Businesses that are not small suppliers and make taxable supplies generally have to register; confirm with the CRA or your accountant.`,
        assumptions: ["Uses revenue recorded in CONARO Business AI only; revenue recorded elsewhere is not included.", "Some supplies may be exempt or zero-rated."],
        dataBasis: { start, end, recordedCents: recorded, source: TAX_SOURCE.smallSupplier }, dedupeKey: `small_supplier:${end}` });
    }
    return { applicable: true, window: { start, end }, recordedRevenue: { label: "ACTUAL", cents: recorded, source: "invoices and imported income" }, thresholdCents: SMALL_SUPPLIER_THRESHOLD_CENTS, over, source: TAX_SOURCE.smallSupplier };
  },
});

// ---------------------------------------------------------------- financial analyst

export async function financialCommandCentre(tdb: TenantDb, province: string | undefined, registered: boolean, from: string, to: string) {
  const inv = await one<{ invoiced: number; tax: number; outstanding: number; n: number }>(tdb,
    `select coalesce(sum(subtotal_cents) filter (where issued_at::date between $1 and $2), 0)::bigint invoiced,
            coalesce(sum(tax_cents) filter (where issued_at::date between $1 and $2), 0)::bigint tax,
            coalesce(sum(total_cents - paid_cents) filter (where status in ('issued','partially_paid')), 0)::bigint outstanding,
            count(*) filter (where issued_at::date between $1 and $2)::int n
     from bai_invoices where status not in ('void','draft')`, [from, to]);
  const pay = await one<{ cents: number; n: number }>(tdb, "select coalesce(sum(amount_cents), 0)::bigint cents, count(*)::int n from bai_payments where received_on between $1 and $2", [from, to]);
  const byService = await tdb.query<{ service: string; cents: number; jobs: number; minutes: number }>(
    `select s.name service, sum(i.subtotal_cents)::bigint cents, count(*)::int jobs, sum(extract(epoch from b.ends_at - b.starts_at) / 60)::int minutes
     from bai_invoices i join bai_jobs j on j.id = i.job_id join bai_bookings b on b.id = j.booking_id join bai_services s on s.id = b.service_id
     where i.status not in ('void','draft') and i.issued_at::date between $1 and $2 group by s.name order by 2 desc`, [from, to]);
  const byEmployee = await tdb.query<{ employee: string; cents: number }>(
    `select coalesce(e.name, 'Unassigned') employee, sum(i.subtotal_cents)::bigint cents from bai_invoices i join bai_jobs j on j.id = i.job_id
     join bai_bookings b on b.id = j.booking_id left join bai_employees e on e.id = b.employee_id
     where i.status not in ('void','draft') and i.issued_at::date between $1 and $2 group by 1 order by 2 desc`, [from, to]);
  const byCustomer = await tdb.query<{ customer: string; cents: number }>(
    `select c.name customer, sum(i.subtotal_cents)::bigint cents from bai_invoices i join bai_customers c on c.id = i.customer_id
     where i.status not in ('void','draft') and i.issued_at::date between $1 and $2 group by 1 order by 2 desc limit 10`, [from, to]);
  const repeat = await one<{ cents: number }>(tdb,
    `select coalesce(sum(i.subtotal_cents), 0)::bigint cents from bai_invoices i where i.status not in ('void','draft') and i.issued_at::date between $1 and $2
       and (select count(*) from bai_invoices p where p.customer_id = i.customer_id and p.status not in ('void','draft') and p.issued_at < i.issued_at) > 0`, [from, to]);
  const pl = await profitAndLoss(tdb, from, to);
  const marketing = await one<{ cents: number; n: number }>(tdb,
    "select coalesce(sum(amount_cents), 0)::bigint cents, count(*)::int n from bai_transactions where direction = 'expense' and category = 'Advertising' and occurred_on between $1 and $2", [from, to]);
  const newCustomers = await one<{ n: number }>(tdb,
    `select count(distinct i.customer_id)::int n from bai_invoices i where i.status not in ('void','draft') and i.issued_at::date between $1 and $2
       and not exists (select 1 from bai_invoices p where p.customer_id = i.customer_id and p.status not in ('void','draft') and p.issued_at::date < $1)`, [from, to]);
  const payable = await one<{ n: number }>(tdb, "select count(*)::int n from bai_transactions where direction = 'expense'");
  const tax = await gstHstSummary(tdb, province, registered, from, to);
  return {
    period: { from, to },
    revenueInvoiced: inv.n ? actual(Number(inv.invoiced), `${plural(inv.n, "invoice")} issued (before tax)`) : unavailable("no invoices issued in this period"),
    cashReceived: pay.n ? actual(Number(pay.cents), `${plural(pay.n, "payment")} recorded`) : unavailable("no payments recorded in this period"),
    revenueByService: byService.map((r) => ({ ...r, cents: Number(r.cents), revenuePerHourCents: r.minutes ? Math.round(Number(r.cents) / (r.minutes / 60)) : null })),
    revenueByEmployee: byEmployee.map((r) => ({ ...r, cents: Number(r.cents) })),
    revenueByCustomer: byCustomer.map((r) => ({ ...r, cents: Number(r.cents) })),
    repeatCustomerRevenue: inv.n ? actual(Number(repeat.cents), "invoices to customers invoiced before") : unavailable("no invoices issued in this period"),
    averageBookingValue: inv.n ? actual(Math.round(Number(inv.invoiced) / inv.n), "invoiced revenue ÷ invoices") : unavailable("no invoices issued in this period"),
    operatingExpenses: pl.expenses,
    netOperatingResult: pl.net,
    grossProfit: unavailable("job costs (materials, labour) are not recorded per job yet"),
    profitabilityByService: unavailable("costs are not allocated to services; revenue per hour is shown instead"),
    accountsReceivable: actual(Number(inv.outstanding), "issued invoices not fully paid"),
    accountsPayable: payable.n ? unavailable("supplier bills are not tracked yet; only paid expenses are imported") : unavailable("no expenses imported"),
    taxCollected: tax.taxCollected,
    estimatedTaxLiability: tax.netEstimate,
    marketingExpenditure: marketing.n ? actual(Number(marketing.cents), "expenses categorised Advertising") : unavailable("no expenses categorised Advertising"),
    customerAcquisitionCost: marketing.n && newCustomers.n ? { label: "ESTIMATE", cents: Math.round(Number(marketing.cents) / newCustomers.n), source: "advertising expense ÷ new invoiced customers", note: "Includes customers who would have come anyway." } as Figure
      : unavailable(marketing.n ? "no new customers invoiced" : "no advertising expenses recorded"),
  };
}

tool({
  name: "finance.command_centre", agent: "financial-analyst", scopes: ["finance", "invoices", "services", "jobs", "bookings", "campaigns"],
  description: "The financial command centre: every figure labelled, with its source, or unavailable with the reason.",
  async run(ctx, input: { from: string; to: string }) {
    return financialCommandCentre(ctx.tdb, ctx.profile.identity.province, ctx.profile.financial.gstHstRegistered === true, input.from, input.to);
  },
});

tool({
  name: "finance.service_profitability", agent: "financial-analyst", scopes: ["invoices", "services", "jobs", "bookings"],
  description: "Revenue per booked hour by service over 90 days; flags services far below the business's own average.",
  async run(ctx) {
    const to = ctx.now.toISOString().slice(0, 10);
    const from = new Date(ctx.now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const fc = await financialCommandCentre(ctx.tdb, ctx.profile.identity.province, ctx.profile.financial.gstHstRegistered === true, from, to);
    const rows = fc.revenueByService.filter((r) => r.revenuePerHourCents !== null && r.jobs >= 3);
    const totalH = rows.reduce((s, r) => s + r.minutes / 60, 0);
    const avg = totalH ? rows.reduce((s, r) => s + r.cents, 0) / totalH : null;
    for (const r of rows) {
      if (avg && (r.revenuePerHourCents ?? 0) < avg * 0.6) {
        await ctx.recommend({ kind: "recommendation", title: `${r.service} earns less per hour than your other services`,
          rationale: `${r.service}: about $${((r.revenuePerHourCents ?? 0) / 100).toFixed(0)}/booked hour vs your average of $${(avg / 100).toFixed(0)} over 90 days.`,
          assumptions: ["Uses booked time, not actual time on site.", "Material and travel costs are not included.", "Services with fewer than 3 jobs are excluded."],
          dataBasis: { service: r.service, jobs: r.jobs, minutes: r.minutes, cents: r.cents }, dedupeKey: `low_rate:${r.service}:${to.slice(0, 7)}` });
      }
    }
    return { from, to, averageRevenuePerHourCents: avg === null ? null : Math.round(avg), services: fc.revenueByService };
  },
});

tool({
  name: "finance.cash_flow_forecast", agent: "financial-analyst", scopes: ["finance", "invoices"],
  description: "FORECAST of the next 30 days: receivables by due date and expenses that repeat monthly. Opening balance only if the owner provided one.",
  async run(ctx) {
    const today = ctx.now.toISOString().slice(0, 10);
    const inflows = await one<{ cents: number; n: number }>(ctx.tdb,
      "select coalesce(sum(total_cents - paid_cents), 0)::bigint cents, count(*)::int n from bai_invoices where status in ('issued','partially_paid') and due_on <= $1::date + 30", [today]);
    const recurring = await ctx.tdb.query<{ description: string; cents: number; months: number }>(
      `select lower(left(description, 20)) description, round(avg(amount_cents))::int cents, count(distinct date_trunc('month', occurred_on))::int months
       from bai_transactions where direction = 'expense' and occurred_on > $1::date - 120 group by 1 having count(distinct date_trunc('month', occurred_on)) >= 3`, [today]);
    const outflow = recurring.reduce((s, r) => s + r.cents, 0);
    const opening = await ctx.recall<{ cents: number; asOf: string }>("opening_balance");
    return {
      label: "FORECAST", horizonDays: 30,
      expectedInflows: { label: "FORECAST", cents: Number(inflows.cents), source: `${inflows.n} open invoices due within 30 days`, note: "Assumes customers pay on time." },
      expectedOutflows: { label: "FORECAST", cents: outflow, source: `${recurring.length} expenses that recurred in each of the last 3+ months`, note: "One-off and new expenses are not included." },
      openingBalance: opening ? { label: "ACTUAL", cents: opening.cents, source: `entered by the owner on ${opening.asOf}` } : unavailable("no bank balance provided (connect a bank feed or enter it)"),
      recurringExpenses: recurring,
    };
  },
});

export { parseCsv };
