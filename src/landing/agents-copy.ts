import type { Lang } from "../i18n.ts";

/**
 * One explainer per operational agent (src/catalog/agents.ts), in English and French. Each script is
 * spoken by the presenter (recorded narration or video when available, otherwise the visitor's device
 * voice) and shown as captions. tests/landing.test.ts checks every operational agent has one, and none
 * for planned agents.
 *
 * Rules: describe what the agent's tools really do; no numbers, customers or results; nothing says that
 * messages, posts or payments already go out (pilot). French follows the CONARO glossary
 * (soumission, réservation, fournisseur) and needs a fluent reviewer before publication.
 */
export type Dept = "manage" | "front" | "jobs" | "money" | "growth" | "office";
type T = Record<Lang, string>;
type L = Record<Lang, string[]>;
export interface AgentCopy { id: string; dept: Dept; name: T; summary: T; how: L; script: L }

export const DEPTS: Record<Dept, T> = {
  manage: { en: "Management", fr: "Direction" },
  front: { en: "Front desk", fr: "Accueil" },
  jobs: { en: "Scheduling and jobs", fr: "Horaire et travaux" },
  money: { en: "Money", fr: "Finances" },
  growth: { en: "Growth", fr: "Croissance" },
  office: { en: "Office", fr: "Bureau" },
};

export const AGENT_COPY: AgentCopy[] = [
  {
    id: "business-manager", dept: "manage",
    name: { en: "AI Business Manager", fr: "Gestionnaire d'entreprise IA" },
    summary: { en: "Runs the team and tells you each morning what matters today.", fr: "Dirige l'équipe et vous dit chaque matin ce qui compte aujourd'hui." },
    how: {
      en: ["Coordinates every agent and keeps one view of your business.", "Writes your daily, weekly and monthly reports from your own records.", "Spots unused hours or revenue behind target and starts a plan."],
      fr: ["Coordonne chaque agent et garde une vue d'ensemble de votre entreprise.", "Rédige vos rapports quotidiens, hebdomadaires et mensuels à partir de vos propres données.", "Repère les heures libres ou les revenus sous l'objectif et lance un plan."],
    },
    script: {
      en: ["Hi, I'm your AI Business Manager.", "I run a team of AI specialists working on your business every day.", "Each morning I tell you what happened, what needs you and what to focus on.", "You set the rules. Anything that spends money or speaks for you waits for your OK."],
      fr: ["Bonjour, je suis votre gestionnaire d'entreprise IA.", "Je dirige une équipe de spécialistes IA qui travaillent pour votre entreprise chaque jour.", "Chaque matin, je vous dis ce qui s'est passé, ce qui vous attend et sur quoi vous concentrer.", "Vous fixez les règles. Tout ce qui coûte de l'argent ou parle en votre nom attend votre accord."],
    },
  },
  {
    id: "customer-service", dept: "front",
    name: { en: "Customer Service Representative", fr: "Représentant du service à la clientèle" },
    summary: { en: "Answers customers from your own information, and says it's an AI.", fr: "Répond aux clients à partir de vos propres informations et précise qu'il est une IA." },
    how: {
      en: ["Reads each enquiry as data, never as instructions.", "Answers only from your services, prices and policies.", "Hands anything unusual to you instead of guessing."],
      fr: ["Lit chaque demande comme une information, jamais comme une consigne.", "Répond seulement à partir de vos services, de vos prix et de vos politiques.", "Vous transmet tout ce qui sort de l'ordinaire au lieu de deviner."],
    },
    script: {
      en: ["I'm your customer service assistant.", "When someone asks about a job, I answer from your own information, and I tell them I'm an AI.", "I never invent a price, a booking or a promise.", "If a question needs you, I pass it on with everything you need to reply."],
      fr: ["Je suis votre assistant au service à la clientèle.", "Quand quelqu'un pose une question, je réponds à partir de vos informations et je précise que je suis une IA.", "Je n'invente jamais un prix, une réservation ou une promesse.", "Si une question vous revient, je vous la transmets avec tout ce qu'il faut pour répondre."],
    },
  },
  {
    id: "sales", dept: "front",
    name: { en: "Sales and Lead Specialist", fr: "Spécialiste des ventes" },
    summary: { en: "Qualifies every enquiry and follows up the ones worth winning.", fr: "Évalue chaque demande et relance celles qui en valent la peine." },
    how: {
      en: ["Scores each enquiry: right service, area, season, timing and detail.", "Gives the reason for every score.", "Follows up open quotes only when the customer agreed to hear from you."],
      fr: ["Évalue chaque demande : bon service, bon secteur, bonne saison, délai et détails.", "Donne la raison de chaque note.", "Relance les soumissions en attente seulement si le client a accepté d'avoir de vos nouvelles."],
    },
    script: {
      en: ["I'm your sales specialist.", "I check every enquiry fits your business: the right service, area and season.", "You see the reasons, not just a score.", "And I follow up open quotes, only with customers who agreed to hear from you."],
      fr: ["Je suis votre spécialiste des ventes.", "Je vérifie que chaque demande vous convient : le bon service, le bon secteur et la bonne saison.", "Vous voyez les raisons, pas seulement une note.", "Et je relance les soumissions en attente, seulement auprès des clients qui l'ont accepté."],
    },
  },
  {
    id: "quotation", dept: "front",
    name: { en: "Quotation and Pricing Specialist", fr: "Spécialiste des soumissions et des prix" },
    summary: { en: "Builds quotes from your prices, fees and the correct GST/HST.", fr: "Prépare les soumissions à partir de vos prix, de vos frais et de la bonne TPS/TVH." },
    how: {
      en: ["Uses your prices, minimum charges and travel fees, never invented costs.", "Applies the GST/HST rate for your province.", "Sends automatically only within the limits you set; otherwise it waits for you."],
      fr: ["Utilise vos prix, vos frais minimums et vos frais de déplacement, jamais des coûts inventés.", "Applique le taux de TPS/TVH de votre province.", "Envoie automatiquement seulement dans les limites que vous fixez; sinon, attend votre accord."],
    },
    script: {
      en: ["I prepare your quotes.", "Every quote uses your own prices, minimum charges and travel fees, with the correct GST or HST.", "If information is missing, I ask instead of guessing.", "Quotes go out on their own only within the limits you choose."],
      fr: ["Je prépare vos soumissions.", "Chaque soumission utilise vos prix, vos frais minimums et vos frais de déplacement, avec la bonne TPS ou TVH.", "S'il manque une information, je la demande au lieu de deviner.", "Les soumissions partent seules seulement dans les limites que vous choisissez."],
    },
  },
  {
    id: "booking", dept: "jobs",
    name: { en: "Booking and Scheduling Manager", fr: "Gestionnaire des réservations et de l'horaire" },
    summary: { en: "Confirms bookings only after checking they really fit.", fr: "Confirme une réservation seulement après avoir vérifié qu'elle convient vraiment." },
    how: {
      en: ["Checks your hours, the job length, travel time and who is free with the right skills.", "Suggests the next open times when a slot doesn't work.", "Prepares reminders and groups nearby jobs to save driving."],
      fr: ["Vérifie vos heures, la durée du travail, le déplacement et qui est libre avec les bonnes compétences.", "Propose les prochaines plages libres quand une heure ne convient pas.", "Prépare les rappels et regroupe les travaux voisins pour réduire la route."],
    },
    script: {
      en: ["I look after your schedule.", "Before a booking is confirmed, I check your hours, travel time, and who has the right skills and is free.", "If a time doesn't work, I offer the next open ones.", "No double bookings, and reminders ready before every visit."],
      fr: ["Je m'occupe de votre horaire.", "Avant de confirmer une réservation, je vérifie vos heures, le déplacement et qui est libre avec les bonnes compétences.", "Si une heure ne convient pas, je propose les prochaines plages libres.", "Aucune double réservation, et des rappels prêts avant chaque visite."],
    },
  },
  {
    id: "workforce", dept: "jobs",
    name: { en: "Employee and Workforce Manager", fr: "Gestionnaire de l'équipe" },
    summary: { en: "Puts the right person on each job and keeps the workload fair.", fr: "Assigne la bonne personne à chaque travail et répartit la charge équitablement." },
    how: {
      en: ["Matches skills and working hours to each job.", "Gives work to whoever has the lightest week.", "Shows booked versus available hours, so you see free capacity."],
      fr: ["Associe les compétences et les heures de travail à chaque travail.", "Confie le travail à la personne la moins chargée de la semaine.", "Montre les heures réservées et disponibles pour voir la capacité libre."],
    },
    script: {
      en: ["I manage your team's time.", "Each job goes to someone with the right skills who is free, starting with whoever has the lightest week.", "You see how full everyone's schedule is.", "I never make hiring or disciplinary decisions. Those stay with you."],
      fr: ["Je gère le temps de votre équipe.", "Chaque travail va à une personne compétente et libre, en commençant par la moins chargée.", "Vous voyez à quel point l'horaire de chacun est rempli.", "Je ne prends jamais de décision d'embauche ou de discipline. Elles vous reviennent."],
    },
  },
  {
    id: "operations", dept: "jobs",
    name: { en: "Job and Operations Manager", fr: "Gestionnaire des travaux" },
    summary: { en: "Turns each confirmed booking into a job with a checklist for your trade.", fr: "Transforme chaque réservation confirmée en travail avec une liste de vérification adaptée à votre métier." },
    how: {
      en: ["Creates the job and checklist, including safety points for your trade.", "Records completion and starts invoicing and follow-up.", "Flags jobs running late so nothing is forgotten."],
      fr: ["Crée le travail et sa liste de vérification, avec les points de sécurité de votre métier.", "Enregistre la fin du travail et lance la facturation et le suivi.", "Signale les travaux en retard pour que rien ne soit oublié."],
    },
    script: {
      en: ["I run your jobs.", "Every confirmed booking becomes a job with a checklist made for your trade, safety points included.", "When you mark it done, invoicing and follow-up start on their own.", "If a job runs late, it's on your list."],
      fr: ["Je m'occupe de vos travaux.", "Chaque réservation confirmée devient un travail avec une liste adaptée à votre métier, sécurité comprise.", "Quand vous le marquez terminé, la facturation et le suivi démarrent seuls.", "Si un travail prend du retard, il apparaît dans votre liste."],
    },
  },
  {
    id: "invoicing", dept: "money",
    name: { en: "Invoicing and Payment Manager", fr: "Gestionnaire de la facturation" },
    summary: { en: "Invoices from the accepted quote, matches payments, prepares reminders.", fr: "Facture à partir de la soumission acceptée, rapproche les paiements, prépare les rappels." },
    how: {
      en: ["Prepares the invoice as soon as a job is done.", "Matches the payments you receive to their invoices.", "Prepares polite reminders for overdue balances."],
      fr: ["Prépare la facture dès qu'un travail est terminé.", "Rapproche les paiements reçus de leurs factures.", "Prépare des rappels polis pour les soldes en retard."],
    },
    script: {
      en: ["I take care of your invoices.", "When a job is done, the invoice is ready from the accepted quote.", "Payments you receive are matched, and late balances get a polite reminder.", "I never change bank details or issue refunds without you."],
      fr: ["Je m'occupe de vos factures.", "Quand un travail est terminé, la facture est prête à partir de la soumission acceptée.", "Les paiements reçus sont rapprochés et les soldes en retard reçoivent un rappel poli.", "Je ne change jamais vos coordonnées bancaires et je ne rembourse jamais sans vous."],
    },
  },
  {
    id: "accounting", dept: "money",
    name: { en: "Accounting and Bookkeeping Agent", fr: "Agent de comptabilité et de tenue de livres" },
    summary: { en: "Imports bank lines, suggests categories and flags anything odd.", fr: "Importe vos opérations bancaires, propose des catégories et signale ce qui est inhabituel." },
    how: {
      en: ["Imports bank or card transactions from a file.", "Suggests categories; you confirm, and every change is kept.", "Flags possible duplicates and unusual amounts; prepares statements and exports."],
      fr: ["Importe les opérations bancaires ou de carte à partir d'un fichier.", "Propose des catégories; vous confirmez, et chaque changement est conservé.", "Signale les doublons possibles et les montants inhabituels; prépare états et exportations."],
    },
    script: {
      en: ["I keep your books tidy.", "Import your bank lines and I suggest a category for each one.", "You confirm, and every change is recorded.", "Possible duplicates and unusual amounts are flagged before they cause trouble."],
      fr: ["Je garde vos livres en ordre.", "Importez vos opérations bancaires et je propose une catégorie pour chacune.", "Vous confirmez, et chaque changement est enregistré.", "Les doublons possibles et les montants inhabituels sont signalés avant de causer des problèmes."],
    },
  },
  {
    id: "tax", dept: "money",
    name: { en: "Tax and Compliance Assistant", fr: "Assistant fiscal" },
    summary: { en: "Prepares GST/HST summaries for you or your accountant.", fr: "Prépare des sommaires de TPS/TVH pour vous ou votre comptable." },
    how: {
      en: ["Totals the GST/HST you collected and paid, labelled as estimates.", "Lists missing receipts and documents.", "Tells you if your recorded revenue passes the small-supplier threshold."],
      fr: ["Additionne la TPS/TVH perçue et payée, présentée comme une estimation.", "Dresse la liste des reçus et documents manquants.", "Vous avertit si vos revenus enregistrés dépassent le seuil du petit fournisseur."],
    },
    script: {
      en: ["I help with GST and HST.", "I total the tax you collected and paid, and list any missing receipts.", "Everything is clearly marked as an estimate.", "I'm not an accountant. Filing stays with you or your accountant."],
      fr: ["Je vous aide avec la TPS et la TVH.", "J'additionne les taxes perçues et payées, et je dresse la liste des reçus manquants.", "Tout est clairement indiqué comme une estimation.", "Je ne suis pas comptable. La production des déclarations reste entre vos mains ou celles de votre comptable."],
    },
  },
  {
    id: "financial-analyst", dept: "money",
    name: { en: "Financial Analyst", fr: "Analyste financier" },
    summary: { en: "Shows where you make money, with every figure labelled.", fr: "Montre où vous faites de l'argent, avec chaque chiffre identifié." },
    how: {
      en: ["Revenue by service, employee and customer, from your invoices.", "Revenue per booked hour, to spot services that earn less.", "A 30-day cash-flow forecast with its assumptions."],
      fr: ["Revenus par service, par employé et par client, à partir de vos factures.", "Revenu par heure réservée, pour repérer les services moins payants.", "Une prévision de trésorerie sur 30 jours avec ses hypothèses."],
    },
    script: {
      en: ["I watch your numbers.", "You see revenue by service, by employee and by customer, and what each booked hour earns.", "Every figure says whether it's actual, an estimate or a forecast.", "When data is missing, I say so. I never make numbers up."],
      fr: ["Je surveille vos chiffres.", "Vous voyez vos revenus par service, par employé et par client, et ce que rapporte chaque heure réservée.", "Chaque chiffre indique s'il est réel, estimé ou prévu.", "Quand une donnée manque, je le dis. Je n'invente jamais de chiffres."],
    },
  },
  {
    id: "marketing-director", dept: "growth",
    name: { en: "Marketing Director", fr: "Directeur du marketing" },
    summary: { en: "Plans seasonal and repeat-customer campaigns inside your budget.", fr: "Planifie des campagnes saisonnières et de fidélisation dans votre budget." },
    how: {
      en: ["Drafts each month's campaigns from your season and in-season services.", "Drafts short campaigns when you have open hours to fill.", "Never buys advertising without your approval."],
      fr: ["Prépare les campagnes du mois selon votre saison et vos services offerts.", "Prépare de courtes campagnes quand vous avez des heures à combler.", "N'achète jamais de publicité sans votre approbation."],
    },
    script: {
      en: ["I plan your marketing.", "Each month I draft campaigns around your season and the services you offer right then.", "When you have open hours, I suggest a short campaign to fill them.", "Advertising spend always waits for your approval."],
      fr: ["Je planifie votre marketing.", "Chaque mois, je prépare des campagnes selon votre saison et les services que vous offrez.", "Quand vous avez des heures libres, je propose une courte campagne pour les combler.", "Les dépenses publicitaires attendent toujours votre approbation."],
    },
  },
  {
    id: "social-media-manager", dept: "growth",
    name: { en: "Social Media Manager", fr: "Gestionnaire des médias sociaux" },
    summary: { en: "Drafts a posting calendar from your real services. No fake reviews, ever.", fr: "Prépare un calendrier de publications à partir de vos vrais services. Jamais de faux avis." },
    how: {
      en: ["Plans two posts a week per campaign.", "Writes only from your real services and areas.", "Publishes only to accounts you connect, with your approval or your rule."],
      fr: ["Planifie deux publications par semaine par campagne.", "Écrit seulement à partir de vos vrais services et secteurs.", "Publie seulement sur les comptes que vous reliez, avec votre approbation ou selon votre règle."],
    },
    script: {
      en: ["I manage your social media.", "I draft a posting calendar from your real services and the areas you serve.", "No fake reviews, followers or claims, ever.", "Posts go out only on accounts you connect, when you approve them."],
      fr: ["Je gère vos médias sociaux.", "Je prépare un calendrier de publications à partir de vos vrais services et de vos secteurs.", "Jamais de faux avis, de faux abonnés ou de fausses affirmations.", "Les publications partent seulement sur les comptes que vous reliez, après votre approbation."],
    },
  },
  {
    id: "local-seo", dept: "growth",
    name: { en: "Local Search Specialist", fr: "Spécialiste de la recherche locale" },
    summary: { en: "Helps local customers find you: profile checks and FAQ drafts.", fr: "Aide les clients du coin à vous trouver : vérification du profil et foire aux questions." },
    how: {
      en: ["Checks your CONARO profile and service descriptions for gaps.", "Drafts answers to the questions customers in your trade ask.", "Answers come from your own facts; you approve them."],
      fr: ["Vérifie votre profil CONARO et vos descriptions de services.", "Prépare des réponses aux questions que posent les clients de votre métier.", "Les réponses viennent de vos propres données; vous les approuvez."],
    },
    script: {
      en: ["I help local customers find you.", "I check your CONARO profile and service descriptions for anything missing.", "I draft answers to the questions people in your trade always ask.", "Everything comes from your own facts, and you approve it."],
      fr: ["J'aide les clients du coin à vous trouver.", "Je vérifie ce qui manque dans votre profil CONARO et vos descriptions de services.", "Je prépare des réponses aux questions que les gens posent toujours dans votre métier.", "Tout vient de vos propres données, et vous l'approuvez."],
    },
  },
  {
    id: "crm", dept: "growth",
    name: { en: "Customer Relationship Manager", fr: "Gestionnaire de la relation client" },
    summary: { en: "Keeps customer history and brings past customers back, with consent.", fr: "Garde l'historique des clients et fait revenir les anciens, avec leur consentement." },
    how: {
      en: ["Keeps each customer's history and preferences.", "Finds customers who haven't booked in six months.", "Contacts only people who agreed, and respects every unsubscribe."],
      fr: ["Garde l'historique et les préférences de chaque client.", "Repère les clients qui n'ont rien réservé depuis six mois.", "Ne contacte que les personnes qui ont accepté et respecte chaque désabonnement."],
    },
    script: {
      en: ["I look after your customer relationships.", "I keep each customer's history, and notice when someone hasn't booked in a while.", "Repeat business is your easiest growth.", "I only contact people who agreed, and an unsubscribe is final."],
      fr: ["Je prends soin de vos relations avec vos clients.", "Je garde l'historique de chaque client et je remarque quand quelqu'un n'a pas réservé depuis longtemps.", "Les clients fidèles sont votre croissance la plus facile.", "Je ne contacte que les personnes qui ont accepté, et un désabonnement est définitif."],
    },
  },
  {
    id: "reputation", dept: "growth",
    name: { en: "Review and Reputation Manager", fr: "Gestionnaire de la réputation" },
    summary: { en: "Asks for honest feedback and helps you reply to unhappy customers.", fr: "Demande des avis honnêtes et vous aide à répondre aux clients insatisfaits." },
    how: {
      en: ["Asks for genuine feedback after each completed job.", "Drafts a private reply when a rating is low.", "Finds the complaints that keep coming back."],
      fr: ["Demande un avis sincère après chaque travail terminé.", "Prépare une réponse privée quand une note est basse.", "Repère les plaintes qui reviennent souvent."],
    },
    script: {
      en: ["I look after your reputation.", "After each job, I ask for honest feedback, good or bad.", "When someone is unhappy, I draft a reply for you to send.", "I never buy, fake or hide reviews."],
      fr: ["Je prends soin de votre réputation.", "Après chaque travail, je demande un avis honnête, bon ou mauvais.", "Quand un client est mécontent, je prépare une réponse que vous pouvez envoyer.", "Je n'achète, n'invente et ne cache jamais d'avis."],
    },
  },
  {
    id: "admin-assistant", dept: "office",
    name: { en: "Administrative Assistant", fr: "Adjoint administratif" },
    summary: { en: "Keeps your to-do list, deadlines and documents in order.", fr: "Garde en ordre votre liste de tâches, vos échéances et vos documents." },
    how: {
      en: ["Keeps one task list for everything agents need from you.", "Reminds you of deadlines a week ahead.", "Stores your documents and finds them when you search."],
      fr: ["Tient une seule liste de tâches pour tout ce que les agents attendent de vous.", "Vous rappelle vos échéances une semaine à l'avance.", "Range vos documents et les retrouve quand vous cherchez."],
    },
    script: {
      en: ["I keep your office in order.", "Everything the team needs from you lands on one task list.", "Deadlines get a reminder a week ahead.", "Your policies and price lists are stored and searchable."],
      fr: ["Je garde votre bureau en ordre.", "Tout ce que l'équipe attend de vous se retrouve dans une seule liste de tâches.", "Chaque échéance a un rappel une semaine à l'avance.", "Vos politiques et vos listes de prix sont rangées et faciles à retrouver."],
    },
  },
  {
    id: "growth-analyst", dept: "manage",
    name: { en: "Performance and Growth Analyst", fr: "Analyste du rendement" },
    summary: { en: "Measures what the AI actually achieved, against your own starting point.", fr: "Mesure ce que l'IA a vraiment accompli, par rapport à votre point de départ." },
    how: {
      en: ["Tracks enquiries, quotes, bookings, completed jobs and repeat customers.", "Records your starting month before claiming any improvement.", "Prepares a monthly value report: work done, results and what the AI cost."],
      fr: ["Suit les demandes, les soumissions, les réservations, les travaux terminés et les clients fidèles.", "Enregistre votre mois de départ avant d'affirmer une amélioration.", "Prépare un rapport mensuel : travail accompli, résultats et coût de l'IA."],
    },
    script: {
      en: ["I measure what the team really achieves.", "I record your starting point before claiming any improvement.", "Every month you get a value report: work done, results and what the AI cost.", "Revenue is only credited to a campaign when it can be traced to it."],
      fr: ["Je mesure ce que l'équipe accomplit vraiment.", "J'enregistre votre point de départ avant d'affirmer une amélioration.", "Chaque mois, vous recevez un rapport : travail accompli, résultats et coût de l'IA.", "Un revenu n'est attribué à une campagne que s'il peut vraiment y être relié."],
    },
  },
];

/** "You stay in control" explainer (not an agent). */
export const CONTROL_SCRIPT: L = {
  en: ["You decide how much the agents do on their own.", "Reports and drafts happen automatically.", "Quotes, bookings and reminders go out only under rules and limits you switch on.", "Prices, refunds and ad spend always wait for you, and one button pauses everything."],
  fr: ["Vous décidez de ce que les agents font seuls.", "Les rapports et les brouillons se font automatiquement.", "Les soumissions, les réservations et les rappels partent seulement selon les règles et les limites que vous activez.", "Les prix, les remboursements et la publicité attendent toujours votre accord, et un seul bouton met tout en pause."],
};
