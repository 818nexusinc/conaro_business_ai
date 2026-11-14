// Prints every explainer script as JSON ({ en: [{ key, lines }], fr: [...] }) for scripts/gen-narration.py.
import { explainers } from "../src/landing/presenters.ts";
console.log(JSON.stringify({ en: explainers("en").map(({ key, lines }) => ({ key, lines })), fr: explainers("fr").map(({ key, lines }) => ({ key, lines })) }));
