# CONARO Business AI — design system

Direction: **calm, competent, local**. It is a tool for owners of trades and service businesses who are short on time, so plain words, strong contrast and one clear action per screen. It builds on the CONARO brand: marketplace navy `#172D46`, Manrope and Inter. This direction was chosen from the existing brand and general rules, not from comparing other sites (the UXKIN library was not connected).

Avoid: purple/blue gradients, glass effects, gradient text, emoji as icons, rows of identical feature cards, stock photos of handshakes, invented numbers or testimonials.

## Color

Tokens live in `src/shared/app.css` (`:root`, with dark values under `prefers-color-scheme: dark`). Use the names, never raw values.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f6f7f9` | `#0f1620` | Page background |
| `--surface` | `#ffffff` | `#17212d` | Cards, panels, inputs |
| `--text` | `#14202e` | `#e6ebf1` | Body text (16.5:1 / 15.2:1) |
| `--muted` | `#5b6878` | `#9aa7b6` | Secondary text (5.7:1 / 7.4:1) |
| `--line` | `#dde2e8` | `#2a3644` | Borders, dividers |
| `--brand` | `#172d46` | `#9cc3ec` | Navy: headers, dark bands, primary buttons in the app |
| `--accent` | `#b4561b` | `#f0a46b` | Copper: the one call-to-action color on marketing pages, focus rings (white on copper 4.9:1) |
| `--accent-strong` | `#9a4614` | `#f6b98a` | CTA hover |
| `--ok` / `--warn` / `--bad` / `--info` | as in `app.css` | as in `app.css` | Status only, each with a `-bg` tint |

On navy bands: text `#ffffff` (14:1), secondary `#c9d6e6` (9.5:1), accent `#f0a46b` (6.8:1).

## Typography

- **Headings:** Manrope (self-hosted, `public/fonts`), weights 700 and 800, tight letter-spacing (-0.02em) at display sizes.
- **Body and UI:** Inter where installed, otherwise `system-ui`. Weights 400 and 600.
- **Scale** (rem / line height): 3.25/1.05 display · 2.25/1.15 h2 · 1.5/1.25 h3 · 1.125/1.55 lead · 1/1.6 body · 0.875/1.5 small · 0.75/1.4 eyebrow (uppercase, 0.08em).
- Body text at least 16px on marketing pages (the app's tables use 15px); lines at most 68 characters.

## Spacing and layout

- 4px base: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Marketing sections: 96px top and bottom on desktop, 64px on phones. Content width 1120px, text columns 68ch, gutters 24px (16px on phones).
- Alternate light (`--bg`/`--surface`) and navy bands to separate sections; no section uses a background image behind text.

## Shape and depth

- Radius: 6px inputs and small buttons, 12px cards, 20px video frames, 999px pills.
- Shadows: one, `0 1px 2px rgb(20 32 46 / .06), 0 8px 24px rgb(20 32 46 / .08)`, for raised cards and video frames only.

## Components

- **Buttons:** primary (copper fill, white text) for the single main action, secondary (navy outline on light, white outline on navy), quiet (text link with underline on hover). 44px minimum height, 3px copper focus ring with 2px offset, disabled at 50% opacity with `not-allowed`.
- **Links:** `--info` in the app; on marketing pages, underlined text in the text color.
- **Inputs:** 44px height on marketing forms, visible label above, error text in `--bad` below the field.
- **Cards:** surface, 1px line, 12px radius, 24px padding; a plan card that is recommended gets a 2px copper border and a "Most chosen" label only if that is true.
- **Agent tabs:** one tab per operational agent, grouped by department (group labels are visual only). Desktop and tablet: a sticky vertical list (260px) beside the panel; phones: a horizontal strip that keeps the selected tab in view. Selected tab: surface fill, 3px copper left border (copper outline on phones). Arrow keys, Home and End move between tabs; without JavaScript every panel is shown and the tabs are anchor links.
- **Video presenter:** 16:9 frame, 20px radius, poster image, native controls, captions track on by default, transcript in a `details` element below. Without a video file it shows the presenter card with a "Play explainer" button: recorded narration if configured, otherwise the device's most natural voice for the page's language, with the current line as a caption and highlighted in the transcript; captions advance alone when no voice exists. The voice used is named under the button. No fake video controls.
- **Language switch:** globe icon plus the other language's name ("Français" / "English") in the header and footer; the choice is remembered.
- **Navigation (marketing):** logo left, at most four anchors, one primary CTA right; collapses to the CTA plus a menu on phones.
- **Footer:** navy band, legal links, CONARO address placeholder, language switch.

## Imagery and icons

- Icons: one line set, 1.75px stroke, 24px grid, drawn as inline SVG in the brand colors (no icon font, no emoji).
- Video presenters for the agents (see `docs/PRESENTER_SCRIPTS.md`); posters are frames from those videos.
- Screenshots of the real control centre, cropped and framed, never mock dashboards with invented figures.
