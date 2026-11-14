// Everything in one process: the owner control centre on $PORT (or BAI_PORT) and the agents'
// cycle every BAI_TICK_SECONDS for every business. Simulation only: no executor exists.
import { createContainer } from "../src/container.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { businessAiCycle } from "../src/workflows.ts";

const c = await createContainer();
const port = c.env.PORT ?? c.env.BAI_PORT;
const secure = c.env.BAI_PUBLIC_URL.startsWith("https://");
const hosted = Boolean(c.env.PORT);
const server = createPortalServer({
  db: c.db, app: c.app, linkSecret: c.env.BAI_UNSUBSCRIBE_SECRET, secure, trustProxy: hosted,
  ...(c.env.BAI_MARKETPLACE_LINK_SECRET ? { marketplaceLinkSecret: c.env.BAI_MARKETPLACE_LINK_SECRET } : {}),
  ...(c.env.BAI_BOS_LINK_SECRET ? { bosLinkSecret: c.env.BAI_BOS_LINK_SECRET } : {}),
});
server.listen(port, hosted ? "0.0.0.0" : "127.0.0.1", () => console.log(`CONARO Business AI on port ${port} (simulation: no external effects)`));

let running = false;
let stopping = false;
async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    const r = await businessAiCycle(c.db, c.app.deps, c.marketplace ? { marketplace: c.marketplace } : {});
    console.log(`[cycle] ${new Date().toISOString()} businesses=${r.tenants} failures=${r.failures.length}`);
    for (const f of r.failures) console.error(`[cycle] workspace ${f.tenantId}: ${f.error}`);
  } catch (err) {
    console.error("[cycle] failed:", (err as Error).message);
  } finally { running = false; }
}
const timer = setInterval(tick, c.env.BAI_TICK_SECONDS * 1000);
void tick();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    clearInterval(timer);
    server.close(async () => { while (running) await new Promise((r) => setTimeout(r, 200)); await c.close(); process.exit(0); });
  });
}
