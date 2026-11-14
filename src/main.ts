import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createContainer, type Container } from "./container.ts";
import { createPortalHandler, type RequestListener } from "./portal/server.ts";
import { runLockedCycle } from "./cycle-lock.ts";

export interface App { handler: RequestListener; container: Container | null; cycle: (() => ReturnType<typeof runLockedCycle>) | null }

/** Explains a configuration problem on every request (names only, never values) instead of failing silently. */
function problemHandler(message: string): RequestListener {
  const reason = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return (_req, res) => {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(`<!doctype html><html lang="en-CA"><meta charset="utf-8"><title>CONARO Business AI cannot start</title><body style="font-family:system-ui;max-width:640px;margin:10vh auto;padding:0 16px"><h1>CONARO Business AI cannot start yet</h1><p>${reason}</p><p>Fix it in the host's environment variables, then redeploy. No secret values are shown here.</p></body></html>`);
  };
}

/** Builds the application: configuration, database (migrations applied), control centre and cron endpoint. */
export async function createApp(): Promise<App> {
  let c: Container;
  try {
    c = await createContainer();
  } catch (err) {
    console.error("[start-up]", (err as Error).message);
    return { handler: problemHandler((err as Error).message), container: null, cycle: null };
  }
  const hosted = Boolean(c.env.PORT || c.env.VERCEL);
  const cycle = () => runLockedCycle(c.db, c.app.deps, c.marketplace ? { marketplace: c.marketplace } : {});
  const handler = createPortalHandler({
    db: c.db, app: c.app, linkSecret: c.env.BAI_UNSUBSCRIBE_SECRET,
    secure: c.env.BAI_PUBLIC_URL.startsWith("https://"), trustProxy: hosted,
    ...(c.env.BAI_MARKETPLACE_LINK_SECRET ? { marketplaceLinkSecret: c.env.BAI_MARKETPLACE_LINK_SECRET } : {}),
    ...(c.env.BAI_BOS_LINK_SECRET ? { bosLinkSecret: c.env.BAI_BOS_LINK_SECRET } : {}),
    ...(c.env.CRON_SECRET ? { cron: { secret: c.env.CRON_SECRET, run: cycle } } : {}),
  });
  return { handler, container: c, cycle };
}

let shared: Promise<App> | null = null;

/** One application per process, created on the first request (Vercel Functions reuse instances). */
export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  shared ??= createApp();
  (await shared).handler(req, res);
}

/**
 * Long-running host: the control centre on $PORT (or BAI_PORT) and, with `loop`, the agents' cycle
 * every BAI_TICK_SECONDS in this process.
 */
export async function start(opts: { loop: boolean }): Promise<Server> {
  const app = await createApp();
  const port = Number(process.env.PORT ?? app.container?.env.BAI_PORT ?? 8790);
  const hosted = Boolean(process.env.PORT);
  const server = createServer(app.handler);
  server.listen(port, hosted ? "0.0.0.0" : "127.0.0.1", () => console.log(`CONARO Business AI on port ${port} (simulation: no external effects)`));
  const c = app.container;
  if (opts.loop && c && app.cycle) {
    const cycle = app.cycle;
    let stopping = false;
    const tick = async () => {
      if (stopping) return;
      try {
        const r = await cycle();
        console.log(`[cycle] ${new Date().toISOString()} ${r.ran ? `businesses=${r.tenants} failures=${r.failures.length}` : r.reason}`);
        if (r.ran) for (const f of r.failures) console.error(`[cycle] workspace ${f.tenantId}: ${f.error}`);
      } catch (err) { console.error("[cycle] failed:", (err as Error).message); }
    };
    const timer = setInterval(tick, c.env.BAI_TICK_SECONDS * 1000);
    void tick();
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => { stopping = true; clearInterval(timer); server.close(async () => { await c.close(); process.exit(0); }); });
    }
  }
  return server;
}
