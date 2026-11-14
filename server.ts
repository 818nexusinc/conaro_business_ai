// Entry point Vercel detects for a Node.js server (see docs/DEPLOY_VERCEL.md). It loads the bundle that
// `npm run build` writes (dist/server.mjs), so the deployment does not depend on how the platform
// compiles TypeScript. Locally: `npm run build && node server.ts`.
// @ts-ignore -- generated at build time
await import("./dist/server.mjs");
