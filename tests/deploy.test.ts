import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, seedBusiness, SECRET } from "./fixtures.ts";
import { buildAssets } from "../scripts/gen-assets.ts";
import { runLockedCycle } from "../src/cycle-lock.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { loadEnv } from "../src/config.ts";

describe("deployment", () => {
  it("embedded migrations and stylesheet match the source files (run npm run gen:assets)", () => {
    expect(readFileSync(new URL("../src/generated/assets.ts", import.meta.url), "utf8")).toBe(buildAssets());
  });

  it("vercel.json: build, every path to the one function, only robots.txt static, and only a daily cron (Hobby refuses more)", () => {
    const v = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { crons: { path: string; schedule: string }[]; buildCommand: string; outputDirectory: string; rewrites: unknown[] };
    expect(v.buildCommand).toBe("npm run build");
    expect(v.outputDirectory).toBe("public");
    expect(v.rewrites).toEqual([{ source: "/(.*)", destination: "/api" }]);
    expect(readFileSync(new URL("../api/index.mjs", import.meta.url), "utf8")).toContain('export { default } from "../dist/handler.mjs"');
    expect(readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8")).toContain("Disallow: /");
    expect(v.crons).toEqual([{ path: "/api/cron/tick", schedule: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }]);
  });

  it("on Vercel: a database is required, and the public address defaults to the production domain", () => {
    const base = { BAI_UNSUBSCRIBE_SECRET: "x".repeat(32) };
    expect(() => loadEnv({ ...base, VERCEL: "1" })).toThrow(/DATABASE_URL is required on Vercel/);
    expect(loadEnv({ ...base, VERCEL: "1", DATABASE_URL: "postgres://u:p@h/db", VERCEL_PROJECT_PRODUCTION_URL: "bai.example.test" }).BAI_PUBLIC_URL).toBe("https://bai.example.test");
    expect(loadEnv({ ...base, VERCEL: "1", DATABASE_URL: "postgres://u:p@h/db", BAI_PUBLIC_URL: "https://ai.conaro.ca", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" }).BAI_PUBLIC_URL).toBe("https://ai.conaro.ca");
    expect(() => loadEnv({ ...base, CRON_SECRET: "short" })).toThrow(/CRON_SECRET/);
    expect(loadEnv(base).BAI_PUBLIC_URL).toBe("http://localhost:8790");
  });
});

describe("scheduled cycle", () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });
  afterEach(async () => { await db.close(); });

  it("runs one cycle at a time; a lease left by a crashed run expires", async () => {
    await seedBusiness(db, "alpha");
    const deps = bai(new Date("2026-11-18T14:00:00Z")).deps;
    await db.query("update bai_cycle_lock set holder = 'other', locked_until = now() + interval '5 minutes'");
    expect(await runLockedCycle(db, deps)).toEqual({ ran: false, reason: "another cycle is running" });
    await db.query("update bai_cycle_lock set locked_until = now() - interval '1 second'");
    expect(await runLockedCycle(db, deps)).toMatchObject({ ran: true, tenants: 1, failures: [] });
    expect((await db.query<{ holder: string | null }>("select holder from bai_cycle_lock"))[0]!.holder).toBeNull();
  });

  it("the cron endpoint needs the exact bearer secret and a GET", async () => {
    let calls = 0;
    const server: Server = createPortalServer({ db, app: bai(new Date()), linkSecret: SECRET, cron: { secret: "cronSecret0123456789abc", run: async () => ({ ran: true, n: ++calls }) } });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cron/tick`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer cronSecret0123456789abX" } })).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "cronSecret0123456789abc" } })).status).toBe(401);
    const ok = await fetch(url, { headers: { authorization: "Bearer cronSecret0123456789abc" } });
    expect(await ok.json()).toEqual({ ran: true, n: 1 });
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer cronSecret0123456789abc" } })).status).toBe(405);
    const off = createPortalServer({ db, app: bai(new Date()), linkSecret: SECRET });
    await new Promise<void>((r) => off.listen(0, "127.0.0.1", r));
    expect((await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/api/cron/tick`)).status).toBe(503);
    await new Promise((r) => server.close(r));
    await new Promise((r) => off.close(r));
  });
});
