/**
 * GST/HST rates by province, from the Canada Revenue Agency.
 *   Source: https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html
 *   (page "Date modified: 2025-04-01", fetched 14 Nov 2026; docs/REFERENCE_CHECKS.md R58)
 * Small supplier threshold ($30,000 over four consecutive calendar quarters):
 *   https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html
 *   (page "Date modified: 2026-06-16", fetched 14 Nov 2026; R59)
 *
 * Only GST/HST is modelled. Provincial sales taxes (BC, MB, SK PST; QC QST)
 * are NOT computed: for those provinces the quote shows GST only and the tax
 * agent reports that PST/QST is not configured. The rate applies where the
 * supply is made; the business confirms its jurisdiction during onboarding.
 */
export const TAX_SOURCE = {
  rates: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html",
  ratesModified: "2025-04-01",
  smallSupplier: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html",
  smallSupplierModified: "2026-06-16",
} as const;

/** Basis points (1500 = 15%). Rates in effect on or after 1 April 2025. */
export const GST_HST_BP: Record<string, { bp: number; kind: "HST" | "GST"; otherProvincialTax: boolean }> = {
  AB: { bp: 500, kind: "GST", otherProvincialTax: false },
  BC: { bp: 500, kind: "GST", otherProvincialTax: true },
  MB: { bp: 500, kind: "GST", otherProvincialTax: true },
  NB: { bp: 1500, kind: "HST", otherProvincialTax: false },
  NL: { bp: 1500, kind: "HST", otherProvincialTax: false },
  NT: { bp: 500, kind: "GST", otherProvincialTax: false },
  NS: { bp: 1400, kind: "HST", otherProvincialTax: false },
  NU: { bp: 500, kind: "GST", otherProvincialTax: false },
  ON: { bp: 1300, kind: "HST", otherProvincialTax: false },
  PE: { bp: 1500, kind: "HST", otherProvincialTax: false },
  QC: { bp: 500, kind: "GST", otherProvincialTax: true },
  SK: { bp: 500, kind: "GST", otherProvincialTax: true },
  YT: { bp: 500, kind: "GST", otherProvincialTax: false },
};

export const SMALL_SUPPLIER_THRESHOLD_CENTS = 30_000_00;

export function taxRateFor(province: string | undefined, registered: boolean): { bp: number; label: string; note?: string } {
  if (!registered) return { bp: 0, label: "No GST/HST (business not registered)" };
  const r = province ? GST_HST_BP[province.toUpperCase()] : undefined;
  if (!r) return { bp: 0, label: "Tax jurisdiction not set", note: "Set the business's province before quoting tax." };
  return {
    bp: r.bp,
    label: `${r.kind} ${r.bp / 100}%`,
    ...(r.otherProvincialTax ? { note: "Provincial sales tax is not calculated by CONARO Business AI; confirm it with your accountant." } : {}),
  };
}

/** Rounds half up to the nearest cent. */
export function applyRate(cents: number, bp: number): number {
  return Math.round((cents * bp) / 10_000);
}
