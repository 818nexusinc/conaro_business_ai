/** Local-time helpers for a tenant's time zone (no external dependency). */

export function localParts(at: Date, timeZone: string): { date: string; weekday: number; minutes: number; hhmm: string } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday ?? "") + 1;
  const hh = Number(p.hour);
  const mm = Number(p.minute);
  return { date: `${p.year}-${p.month}-${p.day}`, weekday, minutes: hh * 60 + mm, hhmm: `${p.hour}:${p.minute}` };
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** UTC instant for a local wall-clock date and time in a time zone. */
export function zonedTime(date: string, hhmm: string, timeZone: string): Date {
  const guess = new Date(`${date}T${hhmm}:00Z`);
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, timeZone);
    const diff = (toMinutes(hhmm) - p.minutes) + (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${p.date}T00:00:00Z`)) / 60_000;
    guess.setTime(guess.getTime() + diff * 60_000);
  }
  return guess;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "unavailable";
  return `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A date column as YYYY-MM-DD (drivers return Date objects for `date`). */
export function isoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? "").slice(0, 10);
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
