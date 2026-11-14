// Long-running host (Docker, Railway, a VM): the control centre on $PORT (or BAI_PORT) plus the agents'
// cycle every BAI_TICK_SECONDS in this process. On Vercel, server.ts is used instead (cycle via cron).
import { start } from "../src/main.ts";

await start({ loop: true });
