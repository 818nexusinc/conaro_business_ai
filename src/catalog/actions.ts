/**
 * Every action a Business AI agent can take. An action not listed here cannot
 * run at all (the tenant gateway blocks it).
 *
 * Levels (brief §11):
 *   1  autonomous within configured policies
 *   2  executes only when the owner has enabled an explicit rule and the
 *      payload is inside its limits; otherwise it becomes an approval request
 *   3  always needs the owner's approval
 *
 * `external`: the effect reaches someone outside the business's records
 * (a customer, a platform, money). In this build no external executor exists,
 * so every external effect is recorded as SIMULATED, never performed.
 * `personOnly`: even after approval the system does not act; a person does
 * (bank transfers, filings, legal agreements, employment decisions).
 */
export interface BusinessActionPolicy {
  level: 1 | 2 | 3;
  external: boolean;
  personOnly?: boolean;
  /** CASL: recipients need valid consent (commercial electronic message). */
  commercial?: boolean;
  /** The owner rule (in settings) that allows level-2 execution. */
  rule?: string;
  description: string;
}

export const BUSINESS_ACTIONS = {
  // Level 1 — internal records and analysis
  "report.generate": { level: 1, external: false, description: "Generate and store a report." },
  "recommendation.record": { level: 1, external: false, description: "Record a recommendation, opportunity or issue for the owner." },
  "admin.task.create": { level: 1, external: false, description: "Add an item to the owner's task or deadline list." },
  "lead.qualify": { level: 1, external: false, description: "Score and qualify an enquiry." },
  "quote.prepare": { level: 1, external: false, description: "Prepare a draft quote from approved pricing rules." },
  "invoice.prepare": { level: 1, external: false, description: "Prepare a draft invoice for a completed job." },
  "bookkeeping.suggest_category": { level: 1, external: false, description: "Suggest a category for an imported transaction (owner confirms)." },
  "content.draft": { level: 1, external: false, description: "Draft marketing or profile content." },
  "campaign.draft": { level: 1, external: false, description: "Draft a campaign (launches nothing)." },
  "customer.update": { level: 1, external: false, description: "Update a customer relationship record." },
  "job.create": { level: 1, external: false, description: "Create a job and checklist from a confirmed booking." },
  "job.complete": { level: 1, external: false, description: "Record a job's completion." },
  "employee.assign": { level: 1, external: false, description: "Assign an eligible employee to a booking." },
  // Level 1 — routine external messages within approved policies
  "reminder.send": { level: 1, external: true, description: "Send an appointment reminder for a confirmed booking." },
  "message.transactional": { level: 1, external: true, description: "Send a booking or job update to the customer concerned." },
  "message.reply": { level: 1, external: true, description: "Answer a routine customer question from approved information." },
  "social.publish": { level: 1, external: true, rule: "social_autopublish", description: "Publish a post the owner has approved (or one inside the autopublish rule)." },

  // Level 2 — rule-based execution
  "booking.confirm": { level: 2, external: true, rule: "auto_confirm_bookings", description: "Confirm a booking whose availability has been validated." },
  "booking.reschedule": { level: 2, external: true, rule: "auto_reschedule", description: "Reschedule within the configured notice rules." },
  "quote.send": { level: 2, external: true, rule: "auto_send_quotes", description: "Send a quote within the approved price and discount limits." },
  "discount.offer": { level: 2, external: true, rule: "max_discount_pct", description: "Offer a discount within the configured maximum." },
  "marketing.send": { level: 2, external: true, commercial: true, rule: "marketing_autosend", description: "Send a marketing message to consented customers within budget." },
  "message.follow_up": { level: 2, external: true, commercial: true, rule: "auto_follow_up", description: "Follow up an open quote with an eligible prospect." },
  "feedback.request": { level: 2, external: true, rule: "auto_feedback_requests", description: "Ask a customer for genuine feedback after a completed job." },
  "invoice.issue": { level: 2, external: true, rule: "auto_issue_invoices", description: "Issue an invoice to the customer." },
  "payment.reminder": { level: 2, external: true, rule: "auto_payment_reminders", description: "Send a reminder for an overdue invoice." },
  "purchase.supplies": { level: 2, external: true, rule: "supplies_limit_cents", description: "Buy approved low-cost supplies within the spending limit." },
  "refund.issue": { level: 2, external: true, rule: "refund_limit_cents", description: "Issue a credit or refund within the explicit limit." },

  // Level 3 — owner approval required
  "purchase.large": { level: 3, external: true, description: "A purchase above the supplies limit." },
  "ads.spend": { level: 3, external: true, description: "Advertising spend or a budget increase." },
  "pricing.change": { level: 3, external: false, description: "A material change to live pricing rules." },
  "refund.large": { level: 3, external: true, description: "A refund above the configured limit." },
  "review.public_response": { level: 3, external: true, description: "Publish a reply to a public review." },
  "data.disclose": { level: 3, external: true, description: "Disclose sensitive customer data." },
  "bank.transfer": { level: 3, external: true, personOnly: true, description: "Move money between accounts." },
  "payout.destination_change": { level: 3, external: true, personOnly: true, description: "Add or change a payout destination." },
  "banking.change": { level: 3, external: true, personOnly: true, description: "Change banking information." },
  "tax.file": { level: 3, external: true, personOnly: true, description: "File or remit tax (done by the owner or their accountant)." },
  "legal.agreement": { level: 3, external: true, personOnly: true, description: "Enter a legal agreement." },
  "employment.decision": { level: 3, external: false, personOnly: true, description: "Termination, discipline or other consequential employment decision." },
  "financial.high_risk": { level: 3, external: true, personOnly: true, description: "Any other high-risk financial transaction." },
} as const satisfies Record<string, BusinessActionPolicy>;

export type BusinessActionType = keyof typeof BUSINESS_ACTIONS;

export function isBusinessAction(t: string): t is BusinessActionType {
  return Object.hasOwn(BUSINESS_ACTIONS, t);
}

export function actionPolicy(t: BusinessActionType): BusinessActionPolicy {
  return BUSINESS_ACTIONS[t];
}
