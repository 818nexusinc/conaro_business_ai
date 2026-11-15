/**
 * Editable website content. Each text has a built-in default in the code (src/landing/copy.ts, agents-copy.ts);
 * the admin can override it per language. Edits are drafts until published; every save, publish, discard and
 * restore is kept in bai_site_content_history.
 */
import { createHash } from "node:crypto";
import type { Db } from "../shared/db.ts";
import { maybeOne } from "../shared/db.ts";
import { PermanentError } from "../shared/errors.ts";
import { adminAudit, type AdminSession } from "./auth.ts";

export type ContentLang = "en" | "fr" | "*";
export type ContentMap = Record<string, string>;

/** Keys the website reads. Anything else is refused, so the table cannot fill with junk. */
const ALLOWED = /^(nav|hero|team|day|plans|start|faq|footer|agent|photo|layout|meta)\.[a-z0-9._-]{1,100}$|^layout$/;
export const MAX_TEXT = 2000;

let cache: { at: number; lang: string; map: ContentMap }[] = [];
const TTL_MS = 15_000;
export function clearContentCache(): void { cache = []; }

/** What visitors see: published overrides for a language plus language-neutral settings ('*'). */
export async function publishedContent(db: Db, lang: "en" | "fr"): Promise<ContentMap> {
  const hit = cache.find((c) => c.lang === lang && Date.now() - c.at < TTL_MS);
  if (hit) return hit.map;
  const rows = await db.query<{ key: string; published_value: string }>(
    "select key, published_value from bai_site_content where lang in ($1, '*') and published_value is not null", [lang]);
  const map: ContentMap = Object.fromEntries(rows.map((r) => [r.key, r.published_value]));
  cache = [...cache.filter((c) => c.lang !== lang), { at: Date.now(), lang, map }];
  return map;
}

/** What the editor shows: the draft where there is one, otherwise the published value. */
export async function draftContent(db: Db, lang: "en" | "fr"): Promise<ContentMap> {
  const rows = await db.query<{ key: string; draft_value: string | null; published_value: string | null; draft_changed: boolean }>(
    "select key, draft_value, published_value, draft_changed from bai_site_content where lang in ($1, '*')", [lang]);
  const map: ContentMap = {};
  for (const r of rows) {
    const v = r.draft_changed ? r.draft_value : r.published_value;
    if (v !== null) map[r.key] = v;
  }
  return map;
}

export async function pendingChanges(db: Db): Promise<{ key: string; lang: string; updated_at: string }[]> {
  return db.query("select key, lang, updated_at from bai_site_content where draft_changed order by updated_at desc");
}

function check(key: string, lang: string, value: string | null): void {
  if (!ALLOWED.test(key)) throw new PermanentError(`Not an editable item: ${key}`);
  if (!["en", "fr", "*"].includes(lang)) throw new PermanentError("Unknown language.");
  if (value !== null && value.length > (key === "layout" ? 4000 : MAX_TEXT)) throw new PermanentError("That text is too long.");
}

/** Saves a draft. `null` means "back to the built-in default" once published. */
export async function saveDraft(db: Db, admin: AdminSession, key: string, lang: ContentLang, value: string | null): Promise<void> {
  const v = value === null ? null : value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  check(key, lang, v);
  await db.query(
    `insert into bai_site_content (key, lang, draft_value, draft_changed, updated_by, updated_at) values ($1, $2, $3, true, $4, now())
     on conflict (key, lang) do update set draft_value = excluded.draft_value, draft_changed = true, updated_by = excluded.updated_by, updated_at = now()`,
    [key, lang, v, admin.adminId]);
  await db.query("insert into bai_site_content_history (key, lang, value, action, admin_id) values ($1, $2, $3, 'save', $4)", [key, lang, v, admin.adminId]);
}

/** Publishes every draft (or only one language's). Returns how many items went live. */
export async function publish(db: Db, admin: AdminSession, lang?: ContentLang): Promise<number> {
  const rows = await db.query<{ key: string; lang: string; draft_value: string | null }>(
    `update bai_site_content set published_value = draft_value, draft_changed = false, published_at = now(), updated_by = $2
     where draft_changed and ($1::text is null or lang = $1 or lang = '*') returning key, lang, draft_value`, [lang ?? null, admin.adminId]);
  for (const r of rows) await db.query("insert into bai_site_content_history (key, lang, value, action, admin_id) values ($1, $2, $3, 'publish', $4)", [r.key, r.lang, r.draft_value, admin.adminId]);
  await adminAudit(db, { adminId: admin.adminId, actor: `admin:${admin.adminId}`, action: "site.published", detail: { items: rows.map((r) => `${r.key}:${r.lang}`) } });
  clearContentCache();
  return rows.length;
}

export async function discardDrafts(db: Db, admin: AdminSession): Promise<number> {
  const rows = await db.query<{ key: string; lang: string; published_value: string | null }>(
    "update bai_site_content set draft_value = published_value, draft_changed = false where draft_changed returning key, lang, published_value");
  for (const r of rows) await db.query("insert into bai_site_content_history (key, lang, value, action, admin_id) values ($1, $2, $3, 'discard', $4)", [r.key, r.lang, r.published_value, admin.adminId]);
  await adminAudit(db, { adminId: admin.adminId, actor: `admin:${admin.adminId}`, action: "site.drafts_discarded", detail: { count: rows.length } });
  return rows.length;
}

export async function contentHistory(db: Db, limit = 100): Promise<{ id: number; key: string; lang: string; value: string | null; action: string; occurred_at: string; who: string | null }[]> {
  return db.query(`select h.id::int id, h.key, h.lang, h.value, h.action, h.occurred_at, a.display_name who from bai_site_content_history h
    left join bai_platform_admins a on a.id = h.admin_id order by h.id desc limit $1`, [limit]);
}

/** Puts an earlier version back as the draft (publish to make it live). */
export async function restoreVersion(db: Db, admin: AdminSession, historyId: number): Promise<{ key: string; lang: string }> {
  const h = await maybeOne<{ key: string; lang: ContentLang; value: string | null }>(db, "select key, lang, value from bai_site_content_history where id = $1", [historyId]);
  if (!h) throw new PermanentError("That version was not found.");
  await saveDraft(db, admin, h.key, h.lang, h.value);
  await db.query("insert into bai_site_content_history (key, lang, value, action, admin_id) values ($1, $2, $3, 'restore', $4)", [h.key, h.lang, h.value, admin.adminId]);
  return { key: h.key, lang: h.lang };
}

// ---------------------------------------------------------------- images

const MAGIC: [string, (b: Buffer) => boolean][] = [
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** Stores an uploaded image after checking what it really is (not what the browser says). */
export async function saveImage(db: Db, admin: AdminSession, filename: string, bytes: Buffer): Promise<string> {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new PermanentError("Images must be under 3 MB.");
  const mime = MAGIC.find(([, ok]) => ok(bytes))?.[0];
  if (!mime) throw new PermanentError("Only JPEG, PNG or WebP images can be uploaded.");
  const row = await maybeOne<{ id: string }>(db, "insert into bai_site_media (filename, mime, bytes, sha256, uploaded_by) values ($1, $2, $3, $4, $5) returning id",
    [filename.replace(/[^\w.-]/g, "_").slice(0, 120) || "image", mime, bytes, createHash("sha256").update(bytes).digest("hex"), admin.adminId]);
  await adminAudit(db, { adminId: admin.adminId, actor: `admin:${admin.adminId}`, action: "site.image_uploaded", subject: row!.id, detail: { filename, bytes: bytes.length, mime } });
  return row!.id;
}

export async function getImage(db: Db, id: string): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await maybeOne<{ mime: string; bytes: Uint8Array }>(db, "select mime, bytes from bai_site_media where id = $1", [id]);
  return r ? { mime: r.mime, bytes: Buffer.from(r.bytes) } : null;
}
