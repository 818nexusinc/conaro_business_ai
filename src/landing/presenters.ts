import type { Lang } from "../i18n.ts";
import { AGENT_COPY, CONTROL_SCRIPT } from "./agents-copy.ts";
import { COPY } from "./copy.ts";

/**
 * Every explainer on the landing page: one per operational agent plus "you stay in control", each in
 * English and French. Captions (/captions/<lang>/<key>.vtt) and docs/PRESENTER_SCRIPTS.md come from here.
 */
export interface Explainer { key: string; name: string; lines: string[] }

export function explainers(lang: Lang): Explainer[] {
  return [
    ...AGENT_COPY.map((a) => ({ key: a.id, name: a.name[lang], lines: a.script[lang] })),
    { key: "control", name: COPY[lang].controlName, lines: CONTROL_SCRIPT[lang] },
  ];
}

export function findExplainer(lang: Lang, key: string): Explainer | undefined {
  return explainers(lang).find((e) => e.key === key);
}

/** Words a second at a natural speaking pace: English ~2.6, French a little slower in syllables per word. */
const PACE: Record<Lang, number> = { en: 2.6, fr: 2.4 };

export function seconds(lang: Lang, lines: string[]): number {
  return Math.round(lines.join(" ").split(/\s+/).length / PACE[lang]);
}

/** WebVTT captions from the script, timed at a natural speaking pace. */
export function captionsVtt(lang: Lang, lines: string[]): string {
  let t = 0;
  const ts = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0")}`;
  const cues = lines.map((line, i) => {
    const d = Math.max(2, line.split(/\s+/).length / PACE[lang]);
    const cue = `${i + 1}\n${ts(t)} --> ${ts(t + d)}\n${line}`;
    t += d + 0.3;
    return cue;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
