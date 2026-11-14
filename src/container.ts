import { loadEnv, type Env } from "./config.ts";
import { createPgliteDb, createPostgresDb, type Db } from "./shared/db.ts";
import { migrate } from "./shared/migrate.ts";
import { SimulatedReasoning, type ReasoningPort } from "./shared/reasoning.ts";
import { AnthropicReasoning } from "./shared/anthropic-reasoning.ts";
import { createBusinessAi, type BusinessAi } from "./index.ts";
import { MarketplaceFeedClient } from "./interop/marketplace.ts";

export interface Container {
  env: Env;
  db: Db;
  reasoning: ReasoningPort;
  app: BusinessAi;
  marketplace: MarketplaceFeedClient | null;
  close(): Promise<void>;
}

/** Wires the application from environment variables and applies pending migrations. */
export async function createContainer(source: Record<string, string | undefined> = process.env): Promise<Container> {
  const env = loadEnv(source);
  const db = env.DATABASE_URL ? await createPostgresDb(env.DATABASE_URL) : await createPgliteDb(env.BAI_PGLITE_DIR);
  await migrate(db);
  const reasoning = env.ANTHROPIC_API_KEY ? new AnthropicReasoning(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL, env.ANTHROPIC_EFFORT) : new SimulatedReasoning();
  const app = createBusinessAi({ reasoning, publicBaseUrl: env.BAI_PUBLIC_URL, linkSecret: env.BAI_UNSUBSCRIBE_SECRET });
  const marketplace = env.BAI_MARKETPLACE_LINK_SECRET ? new MarketplaceFeedClient(env.MARKETPLACE_BASE_URL, env.BAI_MARKETPLACE_LINK_SECRET) : null;
  return { env, db, reasoning, app, marketplace, async close() { await db.close(); } };
}
