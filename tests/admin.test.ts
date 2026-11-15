import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Db } from "../src/shared/db.ts";
import { freshDb, bai, seedBusiness, SECRET } from "./fixtures.ts";
import { createPortalServer } from "../src/portal/server.ts";
import { withTenant } from "../src/tenancy.ts";
import { createAdmin } from "../src/admin/auth.ts";
import { clearContentCache } from "../src/admin/content.ts";

const SETUP_KEY = "setup-key-0123456789abcdef0123456789";
const PW = "correct horse battery staple";
let db: Db; let server: Server; let base: string;

beforeEach(async () => {
  db = await freshDb(); clearContentCache();
  server = createPortalServer({ db, app: bai(new Date("2026-11-18T14:00:00Z")), linkSecret: SECRET, setupKey: SETUP_KEY, landing: { signupOpen: true } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise((r) => server.close(r)); await db.close(); });

const form = (body: Record<string, string>) => ({ method: "POST", redirect: "manual" as const, headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams(body) });
async function signIn(email: string) {
  const r = await fetch(`${base}/admin/login`, form({ email, password: PW }));
  expect(r.status).toBe(303);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const page = await (await fetch(`${base}/admin/site`, { headers: { cookie } })).text();
  return { cookie, csrf: page.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "" };
}
const api = (s: { cookie: string; csrf: string }, path: string, body: unknown, csrf = s.csrf) =>
  fetch(`${base}${path}`, { method: "POST", headers: { cookie: s.cookie, "x-csrf": csrf, "content-type": "application/json", origin: base }, body: JSON.stringify(body) });

describe("platform admin", () => {
  it("creates the first owner only with the set-up key, then signs in; business owners cannot get in", async () => {
    expect(await (await fetch(`${base}/admin/login`)).text()).toContain("No platform owner exists yet");
    const bad = await fetch(`${base}/admin/first-owner`, form({ key: "wrong", name: "Owner", email: "owner@conaro.example", password: PW }));
    expect(bad.status).toBe(401);
    const ok = await fetch(`${base}/admin/first-owner`, form({ key: SETUP_KEY, name: "Owner", email: "owner@conaro.example", password: PW }));
    expect(ok.status).toBe(303);
    expect(await (await fetch(`${base}/admin/login`)).text()).not.toContain("No platform owner exists yet");
    // A second "first owner" is refused.
    expect((await fetch(`${base}/admin/first-owner`, form({ key: SETUP_KEY, name: "X", email: "x@conaro.example", password: PW }))).headers.get("location")).toBe("/admin/login");
    const s = await signIn("owner@conaro.example");
    expect(await (await fetch(`${base}/admin`, { headers: { cookie: s.cookie } })).text()).toContain("Businesses (not demo)");
    // A business owner's control-centre session is not an admin session.
    await seedBusiness(db, "alpha");
    const biz = await fetch(`${base}/login`, form({ email: "owner@alpha.example.test", password: PW }));
    const bizCookie = biz.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await fetch(`${base}/admin`, { headers: { cookie: bizCookie }, redirect: "manual" })).headers.get("location")).toBe("/admin/login");
    for (let i = 0; i < 6; i++) await fetch(`${base}/admin/login`, form({ email: "owner@conaro.example", password: "wrong password!!" }));
    expect((await fetch(`${base}/admin/login`, form({ email: "owner@conaro.example", password: PW }))).status).toBe(429);
  });

  it("edits text as a draft, shows it only after publish, keeps history and can restore", async () => {
    await createAdmin(db, { email: "ed@conaro.example", name: "Editor", password: PW, role: "editor" }, "test");
    await createAdmin(db, { email: "view@conaro.example", name: "Viewer", password: PW, role: "viewer" }, "test");
    const ed = await signIn("ed@conaro.example");
    const editor = await (await fetch(`${base}/admin/editor?lang=en`, { headers: { cookie: ed.cookie } })).text();
    expect(editor).toContain('data-edit="hero.title1"');
    expect(editor).toContain('data-edit-media="photo.agent.booking"');
    expect(editor).toContain('src="/admin/static/editor.js"');

    expect((await api(ed, "/admin/api/content", { key: "hero.title1", lang: "en", value: "Run your business." }, "wrong")).status).toBe(403);
    expect((await api(ed, "/admin/api/content", { key: "evil.key", lang: "en", value: "x" })).status).toBe(400);
    expect((await api(ed, "/admin/api/content", { key: "hero.title1", lang: "en", value: "Run your business." })).status).toBe(200);
    expect(await (await fetch(`${base}/?lang=en`)).text()).not.toContain("Run your business.");
    expect(await (await fetch(`${base}/admin/editor?lang=en`, { headers: { cookie: ed.cookie } })).text()).toContain("Run your business.");

    const viewer = await signIn("view@conaro.example");
    expect((await api(viewer, "/admin/api/content", { key: "hero.title1", lang: "en", value: "Nope" })).status).toBe(403);

    expect(await (await api(ed, "/admin/api/publish", {})).json()).toMatchObject({ published: 1 });
    clearContentCache();
    const live = await (await fetch(`${base}/?lang=en`)).text();
    expect(live).toContain("Run your business.");
    expect(live).not.toContain('data-edit="');
    expect(await (await fetch(`${base}/?lang=fr`)).text()).not.toContain("Run your business.");

    const site = await (await fetch(`${base}/admin/site`, { headers: { cookie: ed.cookie } })).text();
    const firstSave = [...site.matchAll(/name="id" value="(\d+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b)[0]!;
    // Restore the "save" version, then change and discard.
    await api(ed, "/admin/api/content", { key: "hero.title1", lang: "en", value: "Another title." });
    const d = await fetch(`${base}/admin/do/discard`, form({ _csrf: ed.csrf }).method ? { ...form({ _csrf: ed.csrf }), headers: { ...form({}).headers, cookie: ed.cookie } } : {});
    expect(d.status).toBe(303);
    expect(await (await fetch(`${base}/admin/editor?lang=en`, { headers: { cookie: ed.cookie } })).text()).toContain("Run your business.");
    const r = await fetch(`${base}/admin/do/restore`, { ...form({ _csrf: ed.csrf, id: String(firstSave) }), headers: { ...form({}).headers, cookie: ed.cookie } });
    expect(decodeURIComponent(r.headers.get("location") ?? "")).toContain("Restored hero.title1");
    const audit = await db.query<{ action: string }>("select action from bai_admin_audit order by id");
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["admin.created", "admin.signed_in", "site.published", "site.drafts_discarded"]));
  });

  it("hides and reorders sections, and replaces photos with checked uploads", async () => {
    await createAdmin(db, { email: "owner@conaro.example", name: "Owner", password: PW, role: "owner" }, "test");
    const s = await signIn("owner@conaro.example");
    await api(s, "/admin/api/content", { key: "layout", lang: "*", value: JSON.stringify({ order: ["faq", "plans", "day", "team"], hidden: ["day"] }) });
    const notImage = await fetch(`${base}/admin/api/image`, { method: "POST", headers: { cookie: s.cookie, "x-csrf": s.csrf, "x-filename": "x.png", origin: base }, body: Buffer.from("<svg onload=alert(1)>") });
    expect(notImage.status).toBe(400);
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
    const up = await (await fetch(`${base}/admin/api/image`, { method: "POST", headers: { cookie: s.cookie, "x-csrf": s.csrf, "x-filename": "team.png", origin: base }, body: png })).json() as { id: string; url: string };
    await api(s, "/admin/api/content", { key: "photo.agent.booking", lang: "*", value: `u:${up.id}` });
    // Hidden section stays visible (marked) in the editor.
    expect(await (await fetch(`${base}/admin/editor?lang=en`, { headers: { cookie: s.cookie } })).text()).toContain('class="ed-hidden-section"');
    await api(s, "/admin/api/publish", {}); clearContentCache();
    const live = await (await fetch(`${base}/?lang=en`)).text();
    expect(live).not.toContain('id="day"');
    expect(live.indexOf('id="faq"')).toBeLessThan(live.indexOf('id="team"'));
    expect(live).toContain(`src="/media/u/${up.id}"`);
    const img = await fetch(`${base}${up.url}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).equals(png)).toBe(true);
  });

  it("keeps admin tables out of every business workspace", async () => {
    const a = await seedBusiness(db, "alpha");
    await createAdmin(db, { email: "owner@conaro.example", name: "Owner", password: PW, role: "owner" }, "test");
    for (const t of ["bai_platform_admins", "bai_admin_sessions", "bai_site_content", "bai_site_media", "bai_admin_audit"]) {
      await expect(withTenant(db, a.tenantId, (tdb) => tdb.query(`select * from ${t}`)), t).rejects.toThrow(/permission denied/);
    }
    await expect(db.query("update bai_admin_audit set action = 'x'")).rejects.toThrow(/append-only/);
  });
});
