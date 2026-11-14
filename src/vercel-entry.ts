// Bundled by `npm run build` into dist/server.mjs, which the root server.ts loads on Vercel.
// No in-process loop: Vercel Cron calls GET /api/cron/tick (vercel.json), authorised with CRON_SECRET.
import { start } from "./main.ts";

await start({ loop: false });
