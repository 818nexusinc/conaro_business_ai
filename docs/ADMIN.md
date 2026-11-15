# Platform admin (/admin)

The admin runs **CONARO Business AI itself**: its website, plans and pricing, billing and its own agents. It is separate from a business owner's control centre (`/`), with its own accounts (`bai_platform_admins`), cookie and audit log (`bai_admin_audit`, append-only).

## First owner

1. Set `BAI_SETUP_KEY` (32+ random characters) on the host and redeploy.
2. Open `/admin/login`: while no owner exists it asks for the set-up key, your name, email and a password (12+ characters).
3. Remove `BAI_SETUP_KEY` when you no longer need `/setup`.

Roles: **owner** (everything, including admins, pricing and billing), **editor** (website content, admin agents), **viewer** (read only). Sign-in is rate-limited; sessions last 8 hours.

## Website editor

`/admin/site` → *Edit in English* / *Edit in French* opens the real landing page in edit mode:

- **Text**: click any outlined text and type; Enter or click away saves a draft (Esc cancels). Plain text only.
- **Photos**: click a photo (presenters, timeline, trade strip) to upload a replacement (JPEG, PNG or WebP under 3 MB; the file type is checked).
- **Sections**: use ↑ ↓ to reorder and *Hide*/*Show*. Hidden sections stay visible (faded) in the editor.
- **Publish**: the bottom bar shows how many drafts are waiting; *Publish* makes them live. `/admin/site` lists waiting changes, *Discard all drafts*, and the full history with *Restore*.

The explainer scripts are not editable here because each has recorded narration; change them in `src/landing/agents-copy.ts` and regenerate the audio (`docs/PRESENTER_SCRIPTS.md`).

Storage: `bai_site_content` (draft and published value per key and language), `bai_site_content_history` (append-only), `bai_site_media` (uploaded images, served at `/media/u/<id>`). All are system-only tables (RLS on, no policy for `bai_tenant`).
