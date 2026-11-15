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

## Plans and pricing

`/admin/plans` (owners): monthly price in CAD before tax (blank = "Price announced before billing starts"), names and features in English and French, and the recommended plan. Drafts until **Publish pricing**; the website, sign-up and each business's *Plan and usage* page then show the published values. Which agents a plan includes stays in `src/catalog/plans.ts`.

## Billing (Stripe, test mode)

`/admin/billing` shows whether Stripe is configured (never the keys), the webhook address, each plan's Stripe price, billing accounts and recent events.

1. In the Stripe Dashboard **test mode**, create a Product per plan with a monthly recurring CAD Price.
2. Host settings: `STRIPE_SECRET_KEY` (`sk_test_…` or restricted `rk_test_…`) and, after adding the webhook endpoint `https://<domain>/api/billing/stripe/webhook` with the events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, its signing secret as `STRIPE_WEBHOOK_SECRET`. Redeploy.
3. Paste each plan's price id (`price_…`) on `/admin/billing`.
4. A business owner then sees **Subscribe with a card** on *Plan and usage* (Stripe Checkout; test card 4242 4242 4242 4242) and, once subscribed, **Manage billing in Stripe** (customer portal). Webhooks update the subscription and billing status.

Real charging is off: live keys and live events are refused until the owner sets `BAI_STRIPE_LIVE_APPROVED_BY` (their name) and switches to live keys. Evidence: `docs/REFERENCE_CHECKS.md` R68–R71.
