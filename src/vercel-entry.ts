// Bundled by `npm run build` into dist/handler.mjs, which api/index.mjs (the Vercel Function) re-exports.
// Every path is rewritten to this function (vercel.json). No in-process loop: Vercel Cron calls
// GET /api/cron/tick, authorised with CRON_SECRET.
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "./main.ts";

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleRequest(req, res);
}
