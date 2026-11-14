export type Cadence = "daily" | "weekly" | "monthly" | "quarterly";

/** Calendar parts of `at` in an IANA time zone (default America/Moncton). */
export function zonedParts(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** ISO-8601 week number and week-year for a calendar date. */
export function isoWeek(year: number, month: number, day: number): { weekYear: number; week: number } {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const weekYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { weekYear, week };
}

/** A stable label for the period that contains `at`, e.g. 2026-11-11, 2026-W46, 2026-11, 2026-Q4. */
export function periodKey(cadence: Cadence, at: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (cadence) {
    case "daily":
      return `${year}-${pad(month)}-${pad(day)}`;
    case "weekly": {
      const { weekYear, week } = isoWeek(year, month, day);
      return `${weekYear}-W${pad(week)}`;
    }
    case "monthly":
      return `${year}-${pad(month)}`;
    case "quarterly":
      return `${year}-Q${Math.ceil(month / 3)}`;
  }
}
