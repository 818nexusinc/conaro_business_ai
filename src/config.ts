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
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Names only; values are never printed.
    throw new Error(`Configuration problem: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const env = parsed.data;
  if (env.BAI_MARKETPLACE_LINK_SECRET && env.BAI_MARKETPLACE_LINK_SECRET === env.BAI_BOS_LINK_SECRET) {
    throw new Error("Configuration problem: the marketplace and BOS link keys must be different");
  }
  return env;
}
