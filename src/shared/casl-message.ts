import { z } from "zod";

/**
 * Prescribed content of a commercial electronic message under Canada's Anti-Spam Legislation
 * (S.C. 2010, c. 23, s. 6(2); Electronic Commerce Protection Regulations (CRTC), SOR/2012-36):
 *   https://laws-lois.justice.gc.ca/eng/acts/E-1.6/ · https://laws-lois.justice.gc.ca/eng/regulations/SOR-2012-36/
 * Engineering control, not legal advice. Same rules as the CONARO operating system's src/compliance/casl.ts.
 */
export const CommercialMessageSchema = z.object({
  senderName: z.string().min(2),
  onBehalfOf: z.string().optional(),
  mailingAddress: z.string().min(10),
  contact: z.object({ email: z.string().email().optional(), phone: z.string().optional(), url: z.string().url().optional() })
    .refine((c) => Boolean(c.email || c.phone || c.url), "at least one of email, phone or url is required"),
  unsubscribeUrl: z.string().url(),
  subject: z.string().min(1).max(200),
  bodyText: z.string().min(1),
  language: z.enum(["en-CA", "fr-CA"]),
});
export type CommercialMessage = z.infer<typeof CommercialMessageSchema>;

export function validateCommercialMessage(message: unknown): { ok: true; message: CommercialMessage } | { ok: false; problems: string[] } {
  const parsed = CommercialMessageSchema.safeParse(message);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "message"}: ${i.message}`) };
  const m = parsed.data;
  const problems: string[] = [];
  if (!m.bodyText.includes(m.unsubscribeUrl)) problems.push("bodyText must include the unsubscribe link");
  if (!m.bodyText.includes(m.mailingAddress)) problems.push("bodyText must include the mailing address");
  return problems.length ? { ok: false, problems } : { ok: true, message: m };
}
