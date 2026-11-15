import { z } from "zod";

/**
 * Environment for CONARO Business AI. Everything is optional except the unsubscribe key: without a
 * database URL it runs on an embedded PostgreSQL (PGlite), without an Anthropic key it says plainly
 * that no AI analysis was done, and without link keys it simply does not talk to the other apps.
 */
const EnvSchema = z.object({
  BAI_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DATABASE_URL: z.string().optional(),
  BAI_PGLITE_DIR: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  BAI_PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  BAI_PUBLIC_URL: z.string().url().default("http://localhost:8790"),
  BAI_TICK_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /** Signs customers' one-click unsubscribe links. 32+ random characters. */
  BAI_UNSUBSCRIBE_SECRET: z.string().min(32),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** The marketplace: base URL and the shared link key for Business AI (separate from the BOS's key). */
  MARKETPLACE_BASE_URL: z.string().url().default("https://www.conaro.ca"),
  BAI_MARKETPLACE_LINK_SECRET: z.string().min(32).optional(),
  /** Shared link key with the CONARO operating system (it reads the aggregate summary). */
  BAI_BOS_LINK_SECRET: z.string().min(32).optional(),
  /** Scheduled trigger key (Vercel sends it as "Authorization: Bearer …"). Letters and digits, 16+ characters. */
  CRON_SECRET: z.string().regex(/^[A-Za-z0-9_-]{16,}$/, "use 16+ letters, digits, - or _").optional(),
  /** Opens the one-time /setup page (demo accounts, first business) while set. 32+ characters. */
  BAI_SETUP_KEY: z.string().min(32).optional(),
  /** Self-serve pilot sign-up on the landing page: "open" (default) or "closed". */
  BAI_SIGNUP: z.enum(["open", "closed"]).default("open"),
  /** Where the presenter videos live (<id>.mp4 and <id>.jpg). Without it, illustrated presenter cards with captions are shown. */
  BAI_PRESENTER_VIDEO_BASE: z.string().url().optional(),
  /** Recorded narration (natural human voices): <base>/<lang>/<agent>.mp3. Without it, the visitor's device reads the script. */
  BAI_PRESENTER_AUDIO_BASE: z.string().url().optional(),
  /** Name of the fluent reviewer who approved the French copy. Until set, French pages say the translation is under review. */
  BAI_FR_REVIEWED_BY: z.string().min(2).max(120).optional(),
  /** Stripe subscription billing. Test keys (sk_test_/rk_test_) only, unless the owner approves live charging below. */
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, "must be a Stripe secret or restricted key").optional(),
  /** Signing secret of the Stripe webhook endpoint (/api/billing/stripe/webhook). */
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9]+$/, "must start with whsec_").optional(),
  /** Name of the owner who approved real (live-mode) charging. Without it live keys and live events are refused. */
  BAI_STRIPE_LIVE_APPROVED_BY: z.string().min(2).max(120).optional(),
  /** Set by Vercel on its deployments. */
  VERCEL: z.string().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(input: Record<string, string | undefined> = process.env): Env {
  // On Vercel, default the public address to the project's production domain.
  const source = { ...input };
  if (source.VERCEL && !source.BAI_PUBLIC_URL && source.VERCEL_PROJECT_PRODUCTION_URL) source.BAI_PUBLIC_URL = `https://${source.VERCEL_PROJECT_PRODUCTION_URL}`;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Names only; values are never printed.
    throw new Error(`Configuration problem: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const env = parsed.data;
  if (env.BAI_MARKETPLACE_LINK_SECRET && env.BAI_MARKETPLACE_LINK_SECRET === env.BAI_BOS_LINK_SECRET) {
    throw new Error("Configuration problem: the marketplace and BOS link keys must be different");
  }
  if (env.VERCEL && !env.DATABASE_URL) {
    throw new Error("Configuration problem: DATABASE_URL is required on Vercel (the embedded database cannot keep data between requests)");
  }
  return env;
}
