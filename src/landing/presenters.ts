import { agentDef } from "../catalog/agents.ts";

/**
 * The video presenters on the landing page. Each script is ~25–35 seconds when read aloud, written for
 * an AI avatar tool (HeyGen, Synthesia…) or a real spokesperson. docs/PRESENTER_SCRIPTS.md is generated
 * from this list (npm run gen:assets) with recording notes.
 *
 * Wording rules (CLAUDE.md): no invented numbers, customers or results; nothing claims that messages,
 * posts or payments already go out (the product is in pilot/simulation).
 */
export interface Presenter {
  id: string;
  /** Section title on the page. */
  title: string;
  /** The presenter's on-screen name tag. */
  presenter: string;
  /** One line under the video. */
  tagline: string;
  /** Agents covered (ids from src/catalog/agents.ts; the page shows their names). */
  agents: string[];
  /** Spoken script, one caption line per entry. */
  script: string[];
  /** Avatar colors for the illustrated presenter card (tokens from DESIGN.md). */
  tone: "navy" | "copper" | "slate" | "teal" | "plum" | "olive" | "sand";
}

export const PRESENTERS: Presenter[] = [
  {
    id: "manager", title: "Meet your AI Business Manager", presenter: "AI Business Manager", tone: "navy",
    tagline: "Your virtual operations manager: it coordinates the team and tells you what matters today.",
    agents: ["business-manager"],
    script: [
      "Hi, I'm your AI Business Manager.",
      "I run a team of AI specialists that work on your business every day:",
      "answering enquiries, preparing quotes, booking jobs, invoicing and keeping your books.",
      "Every morning I tell you what happened, what needs you, and what to focus on.",
      "You set the rules. Anything that spends money or speaks for you waits for your OK.",
      "Pick a plan and I'll start learning how your business works.",
    ],
  },
  {
    id: "front-desk", title: "Your front desk", presenter: "Customer service, sales and quotes", tone: "copper",
    tagline: "Every enquiry gets an answer, a qualified lead and a quote from your own prices.",
    agents: ["customer-service", "sales", "quotation"],
    script: [
      "When a customer asks for a job, we're on it.",
      "Your customer service assistant answers from your own information, and says it's an AI.",
      "Sales checks the job fits: right service, right area, right season.",
      "Quotes are built from your prices, minimum charges, travel fees and the correct GST or HST.",
      "Quotes go out automatically only within limits you set. Otherwise they wait for you.",
    ],
  },
  {
    id: "scheduling", title: "Scheduling and jobs", presenter: "Booking, team and operations", tone: "teal",
    tagline: "No double bookings: availability is checked before anything is confirmed.",
    agents: ["booking", "workforce", "operations"],
    script: [
      "Before a booking is confirmed, we check it properly:",
      "your hours, the job length, travel time, and who has the right skills and is free.",
      "The right person is assigned, the job gets a checklist for your trade, and reminders are prepared.",
      "If a slot doesn't work, we suggest the next open times instead of guessing.",
    ],
  },
  {
    id: "money", title: "Money, done properly", presenter: "Invoicing, bookkeeping, tax and profit", tone: "olive",
    tagline: "Invoices, bookkeeping and GST/HST summaries, with every figure labelled.",
    agents: ["invoicing", "accounting", "tax", "financial-analyst"],
    script: [
      "When a job is done, the invoice is ready from the accepted quote.",
      "Payments are matched, and overdue invoices get polite reminders.",
      "Import your bank lines: we suggest categories, flag duplicates, and you confirm.",
      "You get profit and loss, cash flow, and a GST or HST summary for your accountant.",
      "Actual, estimate or forecast: every number says which it is. We never make figures up.",
    ],
  },
  {
    id: "growth", title: "Growth and reputation", presenter: "Marketing, social, local search, CRM and reviews", tone: "plum",
    tagline: "Seasonal campaigns, social posts, local search and repeat customers, inside your budget.",
    agents: ["marketing-director", "social-media-manager", "local-seo", "crm", "reputation"],
    script: [
      "We plan campaigns around your season and the hours you have free.",
      "Social posts are drafted from your real services. No fake reviews, ever.",
      "We check your CONARO profile and draft local search content you can approve.",
      "Past customers are invited back, only if they agreed to hear from you.",
      "And after each job, we ask for honest feedback and help you reply.",
    ],
  },
  {
    id: "office", title: "The back office", presenter: "Admin assistant and performance analyst", tone: "slate",
    tagline: "Deadlines, documents and a monthly report on what the AI actually achieved.",
    agents: ["admin-assistant", "growth-analyst"],
    script: [
      "We keep your to-do list, deadlines and documents in order.",
      "Every month you get a value report:",
      "what the agents did, what changed in your business, and what the AI cost.",
      "Improvement is measured against your own starting point, not promised up front.",
    ],
  },
  {
    id: "control", title: "You stay in control", presenter: "How the controls work", tone: "sand",
    tagline: "Three levels of autonomy, your limits, and one button that pauses everything.",
    agents: [],
    script: [
      "You decide how much the agents do on their own.",
      "Reports and drafts happen automatically.",
      "Bookings, quotes and reminders go out only under rules and limits you switch on.",
      "Big decisions, like prices, refunds or ad spend, always wait for you.",
      "And one button pauses every agent, instantly.",
    ],
  },
];

export function agentNames(p: Presenter): string[] {
  return p.agents.map((id) => agentDef(id).name.replace(/^AI /, ""));
}

/** WebVTT captions from the script (about 2.6 words a second, which is a natural speaking pace). */
export function captionsVtt(p: Presenter): string {
  let t = 0;
  const ts = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0")}`;
  const cues = p.script.map((line, i) => {
    const d = Math.max(2, line.split(/\s+/).length / 2.6);
    const cue = `${i + 1}\n${ts(t)} --> ${ts(t + d)}\n${line}`;
    t += d + 0.3;
    return cue;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
