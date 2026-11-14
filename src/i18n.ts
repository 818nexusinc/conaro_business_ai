/**
 * English and French. CONARO serves Greater Moncton, where Dieppe, Memramcook and Shediac are strongly
 * francophone, so every page exists in both languages.
 *
 * Terminology follows the CONARO glossary (marketplace `src/i18n/fr.ts`, see the BOS bilingual-copywriting
 * skill): quote = soumission, booking = réservation, provider = fournisseur. Canadian French conventions:
 * `25 $`, a space before `:`.
 *
 * French marketing copy must be reviewed by a fluent person before it is published: until
 * BAI_FR_REVIEWED_BY names the reviewer, French pages carry a "translation under review" note.
 */
export type Lang = "en" | "fr";
export const LANGS: readonly Lang[] = ["en", "fr"];
export const HTML_LANG: Record<Lang, string> = { en: "en-CA", fr: "fr-CA" };
export const LANG_COOKIE = "bai_lang";

/** ?lang= wins (and is remembered), then the remembered choice, then the browser's preference. */
export function resolveLang(query: string | null, cookie: string | undefined, acceptLanguage: string | undefined): { lang: Lang; remember: boolean } {
  if (query === "fr" || query === "en") return { lang: query, remember: true };
  if (cookie === "fr" || cookie === "en") return { lang: cookie, remember: false };
  const prefs = (acceptLanguage ?? "").toLowerCase().split(",").map((p) => {
    const [tag, q] = p.trim().split(";q=");
    return { tag: tag ?? "", q: q ? Number(q) : 1 };
  }).filter((p) => p.tag).sort((a, b) => b.q - a.q);
  for (const p of prefs) {
    if (p.tag.startsWith("fr")) return { lang: "fr", remember: false };
    if (p.tag.startsWith("en")) return { lang: "en", remember: false };
  }
  return { lang: "en", remember: false };
}

export function langCookie(lang: Lang, secure: boolean): string {
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Canadian French money: "1 250,00 $"; English: "$1,250.00". */
export function formatMoney(lang: Lang, cents: number): string {
  if (lang === "fr") return `${(cents / 100).toLocaleString("fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
