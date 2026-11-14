// The Vercel Function that serves every path (see vercel.json rewrites and docs/DEPLOY_VERCEL.md).
// dist/handler.mjs is bundled from src/vercel-entry.ts by `npm run build`, which Vercel runs first.
export { default } from "../dist/handler.mjs";
