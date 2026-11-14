/**
 * The control centre and public pages in French.
 *
 * Pages are written in English. For a French request the rendered HTML goes through `translateHtml()`,
 * which replaces UI text — whole text nodes, button and label text, aria-labels, titles — found in the
 * dictionary below or matched by a pattern. It never touches:
 *   - text inside <pre>, <code>, <textarea>, <script> and <style> (records, JSON, what people typed);
 *   - <option> elements without a value attribute (their text is the value that is submitted);
 *   - attribute values other than aria-label, title and placeholder (form values stay as they are).
 * Business data (names, services, descriptions) and agent-written text (summaries, recommendations,
 * chat replies) are shown as written; only text that exactly matches a UI string is translated.
 *
 * Dates and money follow the request's language (fr-CA: "13 nov. 2026", "1 250,00 $").
 * Glossary: quote = soumission, booking = réservation, enquiry = demande, provider = fournisseur.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { formatMoney, type Lang } from "../i18n.ts";
import { AGENTS } from "../catalog/agents.ts";
import { INDUSTRY_PACKS } from "../catalog/industries.ts";
import { PLANS } from "../catalog/plans.ts";
import { AGENT_COPY } from "../landing/agents-copy.ts";
import { INDUSTRY_FR, PLAN_FEATURES_FR, PLAN_NAME_FR } from "../landing/copy.ts";

const store = new AsyncLocalStorage<Lang>();
export const runInLang = <T>(lang: Lang, fn: () => T): T => store.run(lang, fn);
export const currentLang = (): Lang => store.getStore() ?? "en";

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return currentLang() === "fr" ? "non disponible" : "unavailable";
  return formatMoney(currentLang(), cents);
}

export function when(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString(currentLang() === "fr" ? "fr-CA" : "en-CA", { timeZone: "America/Moncton", dateStyle: "medium", timeStyle: "short" });
}

/** Names of the agents that are not available yet (operational ones come from the landing copy). */
export const PLANNED_AGENTS_FR: Record<string, { name: string; role: string }> = {
  inventory: { name: "Gestionnaire IA des stocks et des achats", role: "Suit les stocks et recommande des achats selon les limites d'approbation." },
  "business-development": { name: "Directeur IA du développement des affaires", role: "Trouve de nouveaux services, segments et partenariats." },
  "competitor-intelligence": { name: "Spécialiste IA de la veille concurrentielle", role: "Analyse l'information publique sur les concurrents." },
};

const UI: Record<string, string> = {
  // Layout and sign-in
  "Skip to content": "Passer au contenu", "Sections": "Sections", "Sign out": "Se déconnecter", "Sign in": "Se connecter",
  "DEMO WORKSPACE: every business, customer, booking, invoice and bank line here is invented for testing.":
    "ESPACE DE DÉMONSTRATION : chaque entreprise, client, réservation, facture et ligne bancaire ici est inventé pour les essais.",
  "SIMULATION: no message, post, payment or purchase leaves CONARO Business AI yet. External actions are recorded and labelled simulated.":
    "SIMULATION : aucun message, aucune publication, aucun paiement ni achat ne sort encore de CONARO Business AI. Les actions externes sont enregistrées et marquées comme simulées.",
  "All agents are paused.": "Tous les agents sont en pause.", "Resume agents": "Relancer les agents", "Pause all agents now": "Mettre tous les agents en pause",
  "Your business. Your AI workforce.": "Votre entreprise. Votre équipe IA.", "Email": "Courriel", "Password": "Mot de passe",
  "Too many attempts. Try again in 15 minutes.": "Trop de tentatives. Réessayez dans 15 minutes.",
  "Email or password not recognised.": "Courriel ou mot de passe non reconnu.",
  "Could not sign you in": "Connexion impossible",
  // Navigation and page titles
  "Today": "Aujourd'hui", "Approvals": "Approbations", "Growth": "Croissance", "Finance": "Finances", "Enquiries and quotes": "Demandes et soumissions",
  "Bookings and jobs": "Réservations et travaux", "AI workforce": "Équipe IA", "Agent activity": "Activité des agents", "Recommendations": "Recommandations",
  "Reports": "Rapports", "Documents": "Documents", "Business settings": "Paramètres de l'entreprise", "Connections": "Connexions",
  "Plan and usage": "Forfait et utilisation", "Audit log": "Journal d'audit", "Growth command centre": "Centre de commande de la croissance",
  "Financial command centre": "Centre de commande financier", "Recommendations and tasks": "Recommandations et tâches",
  // Today
  "Approvals waiting": "Approbations en attente", "Profile gaps": "Éléments manquants au profil", "Industry": "Secteur d'activité", "Tax": "Taxes",
  "1. What happened": "1. Ce qui s'est passé", "Enquiries": "Demandes", "Quotes prepared": "Soumissions préparées", "Quotes accepted": "Soumissions acceptées",
  "New bookings": "Nouvelles réservations", "Jobs completed": "Travaux terminés", "2. Revenue": "2. Revenus", "Cash received:": "Encaissements :", "Invoiced:": "Facturé :",
  "3. Opportunities identified": "3. Occasions repérées", "None identified.": "Aucune repérée.", "4. Work completed by agents": "4. Travail accompli par les agents",
  "Agent": "Agent", "Outcome": "Résultat", "Count": "Nombre", "No agent work recorded that day.": "Aucun travail d'agent enregistré ce jour-là.",
  "5. Needs your attention": "5. À votre attention", "Nothing waiting.": "Rien en attente.", "6. Priorities today": "6. Priorités du jour", "Nothing.": "Rien.",
  "The first summary is produced the morning after set-up.": "Le premier sommaire est produit le matin suivant la configuration.",
  "Finish setting up": "Terminer la configuration", "Nothing to show yet.": "Rien à afficher pour l'instant.",
  // Profile gaps and tax
  "Business description": "Description de l'entreprise", "Province (tax jurisdiction)": "Province (compétence fiscale)", "Service areas": "Secteurs desservis",
  "Business hours": "Heures d'ouverture", "Contact email or phone": "Courriel ou téléphone de contact",
  "Mailing address (required in marketing messages)": "Adresse postale (obligatoire dans les messages de marketing)",
  "Monthly revenue target": "Objectif de revenus mensuel", "Growth priorities": "Priorités de croissance", "Cancellation policy": "Politique d'annulation",
  "Payment methods": "Modes de paiement", "GST/HST registration status": "Statut d'inscription à la TPS/TVH",
  "At least one service with pricing": "Au moins un service avec un prix",
  "At least one person who does the work (employee or owner)": "Au moins une personne qui fait le travail (employé ou propriétaire)",
  "No GST/HST (business not registered)": "Pas de TPS/TVH (entreprise non inscrite)", "Tax jurisdiction not set": "Province fiscale non définie",
  "Set the business's province before quoting tax.": "Indiquez la province de l'entreprise avant de calculer les taxes.",
  // Chat
  "Answers come from your business's records. It recommends; it does not act on its own from this chat.":
    "Les réponses viennent des dossiers de votre entreprise. Il recommande; il n'agit pas de lui-même à partir de cette conversation.",
  "You:": "Vous :", "Business Manager:": "Gestionnaire d'entreprise :", "Ask about revenue, bookings, quotes or what to focus on.":
    "Posez une question sur vos revenus, vos réservations, vos soumissions ou vos priorités.", "Your question": "Votre question", "Ask": "Demander",
  // Approvals
  "Level 2 actions wait here when their rule is off or the payload is outside your limits. Level 3 actions always wait for the owner. Approved external actions are SIMULATED in this version.":
    "Les actions de niveau 2 attendent ici lorsque leur règle est désactivée ou que leur contenu dépasse vos limites. Les actions de niveau 3 attendent toujours le propriétaire. Dans cette version, les actions externes approuvées sont SIMULÉES.",
  "Ref": "Réf.", "Level": "Niveau", "Requested by": "Demandé par", "What": "Quoi", "Details": "Détails", "Status": "Statut", "Payload": "Contenu",
  "Note": "Note", "Approve": "Approuver", "Reject": "Refuser", "No approvals yet.": "Aucune approbation pour l'instant.", "Rejected.": "Refusé.",
  // Growth
  "From": "Du", "To": "Au", "Show": "Afficher", "New enquiries": "Nouvelles demandes", "Qualified": "Qualifiées", "Repeat bookings": "Réservations répétées",
  "Open issues": "Problèmes ouverts", "Measure": "Mesure", "Value": "Valeur", "Quote acceptance": "Acceptation des soumissions",
  "Enquiry to booking": "Demande à réservation", "Revenue attributed to campaigns": "Revenus attribués aux campagnes",
  "Employee utilisation": "Taux d'occupation des employés", "Unused capacity": "Capacité inutilisée", "Marketing reach": "Portée du marketing",
  "Social engagement": "Engagement sur les médias sociaux", "Website visits": "Visites du site Web", "Marketplace profile visits": "Visites du profil sur le marché CONARO",
  // Finance
  "ACTUAL = recorded in your books. ESTIMATE and FORECAST are calculations with stated assumptions. Unavailable means the data is not there yet; nothing is invented.":
    "RÉEL = inscrit dans vos livres. ESTIMATION et PRÉVISION sont des calculs dont les hypothèses sont indiquées. Non disponible signifie que les données ne sont pas encore là; rien n'est inventé.",
  "Revenue invoiced": "Revenus facturés", "Cash received": "Encaissements", "Operating expenses": "Charges d'exploitation", "Net operating result": "Résultat d'exploitation net",
  "Gross profit": "Bénéfice brut", "Accounts receivable": "Comptes clients", "Accounts payable": "Comptes fournisseurs", "Tax collected": "Taxes perçues",
  "Estimated tax liability": "Taxes à payer estimées", "Average booking value": "Valeur moyenne d'une réservation", "Repeat-customer revenue": "Revenus des clients fidèles",
  "Marketing expenditure": "Dépenses de marketing", "Customer acquisition cost": "Coût d'acquisition d'un client", "Profitability by service": "Rentabilité par service",
  "Revenue by service": "Revenus par service", "Service": "Service", "Revenue": "Revenus", "Jobs": "Travaux", "Revenue per booked hour": "Revenus par heure réservée",
  "No invoiced jobs in this period.": "Aucun travail facturé pendant cette période.", "Revenue by employee": "Revenus par employé", "Employee": "Employé",
  "Profit and loss by category": "Résultats par catégorie", "Direction": "Sens", "Category": "Catégorie", "Amount": "Montant", "Items": "Éléments",
  "Unreviewed": "Non vérifiés", "No transactions imported.": "Aucune transaction importée.", "Open invoices": "Factures ouvertes", "Invoice": "Facture",
  "Total": "Total", "Paid": "Payé", "Due": "Échéance", "Amount $": "Montant ($)", "Method": "Mode", "Date": "Date", "Record payment": "Enregistrer le paiement",
  "No open invoices.": "Aucune facture ouverte.", "Transactions": "Transactions", "Description": "Description", "Suggestion": "Suggestion", "Flags": "Signalements",
  "Confirm": "Confirmer", "No transactions yet.": "Aucune transaction pour l'instant.", "Import transactions (CSV)": "Importer des transactions (CSV)",
  "Columns: date (YYYY-MM-DD), description, amount (negative for expenses), optional category, tax":
    "Colonnes : date (AAAA-MM-JJ), description, montant (négatif pour les dépenses), catégorie (facultative), taxe",
  "Source": "Source", "Import": "Importer", "Bank balance (for the cash-flow forecast)": "Solde bancaire (pour la prévision de trésorerie)",
  "Balance $": "Solde ($)", "Save": "Enregistrer", "expense": "dépense", "income": "revenu",
  "Payment recorded.": "Paiement enregistré.", "Category confirmed.": "Catégorie confirmée.", "Balance saved.": "Solde enregistré.",
  // Enquiries and bookings
  "Customer": "Client", "Channel": "Canal", "Score": "Pointage", "Est. value": "Valeur est.", "Received": "Reçue", "No enquiries yet.": "Aucune demande pour l'instant.",
  "Quotes": "Soumissions", "Valid until": "Valide jusqu'au", "Customer accepted for": "Le client a accepté pour le", "Record acceptance": "Enregistrer l'acceptation",
  "No quotes yet.": "Aucune soumission pour l'instant.", "Record an enquiry": "Enregistrer une demande",
  "Phone calls, walk-ins or messages from elsewhere. Marketplace enquiries arrive automatically once the marketplace is connected.":
    "Appels, visites en personne ou messages reçus ailleurs. Les demandes du marché CONARO arrivent automatiquement une fois le marché connecté.",
  "Customer name": "Nom du client", "Phone": "Téléphone", "Not sure": "Je ne sais pas", "What they need": "Ce dont le client a besoin", "Area": "Quartier ou secteur",
  "Preferred date": "Date souhaitée", "Preferred time": "Heure souhaitée",
  "phone": "téléphone", "email": "courriel", "website": "site Web", "walk-in": "en personne", "referral": "recommandation", "social": "médias sociaux", "marketplace": "marché CONARO",
  "The customer explicitly agreed to receive marketing messages": "Le client a expressément accepté de recevoir des messages de marketing",
  "Save enquiry": "Enregistrer la demande", "Acceptance recorded. The booking agent will validate the time and book it.":
    "Acceptation enregistrée. L'agent des réservations validera l'heure et fera la réservation.",
  "Booking": "Réservation", "When": "Quand", "Who": "Qui", "Job": "Travail", "Mark completed": "Marquer comme terminé", "No bookings yet.": "Aucune réservation pour l'instant.",
  "Job completed. Invoicing and follow-up start in the next cycle.": "Travail terminé. La facturation et le suivi commencent au prochain cycle.",
  // Agents and activity
  "#": "nº", "Role": "Rôle", "In plan": "Dans le forfait", "Relevant to your industry": "Utile pour votre secteur", "Actions (30 days)": "Actions (30 jours)",
  "Settings": "Réglages", "optional": "facultatif", "On": "Activé", "Off": "Désactivé", "On or off": "Activé ou désactivé", "Autonomy": "Autonomie",
  "Draft only": "Brouillon seulement", "Ask first": "Demander d'abord", "Within my rules": "Selon mes règles", "Autonomous": "Autonome", "Agent updated.": "Agent mis à jour.",
  "Actions": "Actions", "Action": "Action", "Why": "Pourquoi", "No agent actions yet.": "Aucune action d'agent pour l'instant.", "Workflows": "Flux de travail",
  "Started": "Début", "Workflow": "Flux de travail", "Steps": "Étapes", "Error": "Erreur", "No workflows yet.": "Aucun flux de travail pour l'instant.",
  "Agent-to-agent messages": "Messages entre agents", "Kind": "Type", "Content": "Contenu", "None yet.": "Aucun pour l'instant.",
  // Recommendations, reports, documents
  "Recommendation": "Recommandation", "Assumptions": "Hypothèses", "Accept": "Accepter", "Dismiss": "Écarter", "No recommendations yet.": "Aucune recommandation pour l'instant.",
  "Your task list": "Votre liste de tâches", "Task": "Tâche", "Type": "Type", "No open tasks.": "Aucune tâche ouverte.", "issue": "problème", "opportunity": "occasion",
  "Report": "Rapport", "Period": "Période", "Produced": "Produit le", "Open": "Ouvrir", "Reports appear after the first daily cycle.": "Les rapports apparaissent après le premier cycle quotidien.",
  "All reports": "Tous les rapports", "daily summary": "sommaire quotidien", "weekly report": "rapport hebdomadaire", "monthly report": "rapport mensuel",
  "Search": "Rechercher", "Document": "Document", "Excerpt": "Extrait", "No matches.": "Aucun résultat.", "Name": "Nom", "Size": "Taille", "Added": "Ajouté le",
  "No documents yet.": "Aucun document pour l'instant.", "Add a text document": "Ajouter un document texte",
  "Policies, price lists, procedures. Text only, up to 1 MB. Content is treated as untrusted data by the agents.":
    "Politiques, listes de prix, procédures. Texte seulement, jusqu'à 1 Mo. Les agents traitent le contenu comme des données non fiables.",
  "Text": "Texte", "Document saved.": "Document enregistré.",
  "Saved. Note: the document contains text that looks like instructions to an AI; agents will treat it as data only.":
    "Enregistré. Remarque : le document contient du texte qui ressemble à des consignes pour une IA; les agents le traiteront seulement comme des données.",
  // Settings
  "Business Intelligence Profile": "Profil d'intelligence d'affaires", "Missing": "Manquant", "Industry operating rules": "Règles d'exploitation du secteur",
  "Profile": "Profil", "Choose": "Choisir", "Service areas (comma-separated)": "Secteurs desservis (séparés par des virgules)", "Contact email": "Courriel de contact",
  "Mailing address (required on marketing messages)": "Adresse postale (obligatoire dans les messages de marketing)",
  "Business hours (leave blank when closed)": "Heures d'ouverture (laisser vide si fermé)",
  "Mon": "lun.", "Tue": "mar.", "Wed": "mer.", "Thu": "jeu.", "Fri": "ven.", "Sat": "sam.", "Sun": "dim.",
  "Monthly revenue target $": "Objectif de revenus mensuel ($)", "Growth priorities (one per line)": "Priorités de croissance (une par ligne)",
  "Payment methods (comma-separated)": "Modes de paiement (séparés par des virgules)", "Booking lead time (hours)": "Délai de réservation (heures)",
  "GST/HST registered": "Inscrit à la TPS/TVH", "Not set": "Non défini", "Yes": "Oui", "No": "Non", "Save profile": "Enregistrer le profil",
  "Services and pricing": "Services et prix", "Pricing": "Tarification", "Price": "Prix", "Duration": "Durée", "Skill": "Compétence", "Season": "Saison",
  "fixed": "prix fixe", "hourly": "à l'heure", "per_unit": "à l'unité", "all year": "toute l'année", "not set min": "non définie", "No services yet.": "Aucun service pour l'instant.",
  "Fixed price": "Prix fixe", "Per hour": "À l'heure", "Per unit": "À l'unité", "Unit label (per unit)": "Unité (tarif à l'unité)", "Price $": "Prix ($)",
  "Minimum charge $": "Frais minimum ($)", "Travel fee $": "Frais de déplacement ($)", "Standard duration (minutes)": "Durée standard (minutes)",
  "Required skill": "Compétence requise", "Season months (e.g. 5,6,7)": "Mois de la saison (p. ex. 5,6,7)", "Limitations": "Limites", "Save service": "Enregistrer le service",
  "Team": "Équipe", "Skills": "Compétences", "Working days": "Jours de travail", "No team members yet.": "Aucun membre de l'équipe pour l'instant.",
  "Skills (comma-separated)": "Compétences (séparées par des virgules)", "Works Monday–Friday from": "Travaille du lundi au vendredi de", "to": "à",
  "Also Saturdays": "Aussi le samedi", "Add team member": "Ajouter un membre de l'équipe", "Operating rules": "Règles d'exploitation",
  "Level-2 actions run automatically only when you turn their rule on and the agent is set to \"within my rules\". Money limits start at $0.":
    "Les actions de niveau 2 s'exécutent automatiquement seulement si vous activez leur règle et que l'agent est réglé à « selon mes règles ». Les limites d'argent commencent à 0 $.",
  "Confirm bookings automatically once availability is validated": "Confirmer les réservations automatiquement une fois la disponibilité validée",
  "Send quotes automatically": "Envoyer les soumissions automatiquement", "…up to a total of $": "… jusqu'à un total de ($)", "Maximum discount %": "Rabais maximal (%)",
  "Follow up open quotes (consented customers only)": "Relancer les soumissions ouvertes (clients consentants seulement)",
  "Ask for feedback after completed jobs": "Demander une rétroaction après les travaux terminés", "Issue invoices automatically": "Émettre les factures automatiquement",
  "Send overdue payment reminders": "Envoyer des rappels de paiement en retard", "Days between reminders": "Jours entre les rappels",
  "Send appointment reminders": "Envoyer des rappels de rendez-vous", "Hours before the appointment": "Heures avant le rendez-vous",
  "Send marketing messages automatically (consented customers, within budget)": "Envoyer automatiquement les messages de marketing (clients consentants, selon le budget)",
  "Monthly marketing budget $": "Budget de marketing mensuel ($)", "Publish social posts without asking": "Publier sur les médias sociaux sans demander",
  "Supplies spending limit $": "Limite de dépenses en fournitures ($)", "Refund limit $": "Limite de remboursement ($)",
  "Travel time between jobs (minutes)": "Temps de déplacement entre les travaux (minutes)", "Quotes valid for (days)": "Soumissions valides pendant (jours)",
  "Invoices due after (days)": "Factures payables après (jours)", "Save rules": "Enregistrer les règles",
  "Only the owner can change operating rules.": "Seul le propriétaire peut modifier les règles d'exploitation.", "People with access": "Personnes ayant accès",
  "Temporary password (12+ characters)": "Mot de passe temporaire (12 caractères ou plus)", "Manager": "Gestionnaire", "Staff": "Employé",
  "Accountant": "Comptable", "Viewer": "Lecture seule", "Add person": "Ajouter la personne",
  "owner": "propriétaire", "manager": "gestionnaire", "staff": "employé", "accountant": "comptable", "viewer": "lecture seule",
  "Service saved.": "Service enregistré.", "Team member added.": "Membre de l'équipe ajouté.", "Operating rules saved.": "Règles d'exploitation enregistrées.",
  "Person added.": "Personne ajoutée.", "Saved.": "Enregistré.", "Agents resumed.": "Agents relancés.",
  "Welcome! Your pilot workspace is ready. Start with your services, prices and hours below.":
    "Bienvenue! Votre espace pilote est prêt. Commencez par vos services, vos prix et vos heures ci-dessous.",
  // Connections and plan
  "A connection is shown as operational only after sign-in, permissions, data sync, error handling and an end-to-end test have all passed. No connection is available yet in this version: agents work from what you enter here, and every external action is simulated.":
    "Une connexion n'est indiquée comme fonctionnelle qu'après la réussite de la connexion, des autorisations, de la synchronisation des données, de la gestion des erreurs et d'un essai de bout en bout. Aucune connexion n'est encore offerte dans cette version : les agents travaillent à partir de ce que vous saisissez ici, et chaque action externe est simulée.",
  "Detail": "Détail", "Last checked": "Dernière vérification", "Not connected": "Non connecté",
  "Plan": "Forfait", "Billing": "Facturation", "not connected": "non connectée", "Agents you pay for": "Agents facturés",
  "Agents marked \"planned\" are not available yet and are never charged. Subscription charges are separate from advertising spend, payment processing fees and third-party charges.":
    "Les agents marqués « prévu » ne sont pas encore offerts et ne sont jamais facturés. L'abonnement est distinct des dépenses publicitaires, des frais de traitement des paiements et des frais de tiers.",
  "This month's usage": "Utilisation ce mois-ci", "Used": "Utilisé", "Plan limit": "Limite du forfait", "AI calls": "Appels IA", "External actions": "Actions externes",
  "Workflow runs": "Exécutions de flux de travail", "Plans": "Forfaits", "Working agents": "Agents en service", "Includes": "Comprend", "price not set": "prix non fixé",
  "Switch": "Changer", "Plan changed. Billing is not connected, so nothing was charged.": "Forfait changé. La facturation n'est pas connectée, donc rien n'a été facturé.",
  // Audit
  "Subject": "Objet",
  // Set-up page
  "Set-up is off": "La configuration est désactivée", "CONARO Business AI set-up": "Configuration de CONARO Business AI",
  "This page only works while the BAI_SETUP_KEY setting is present. Add it in the host's environment variables (32+ random characters), redeploy, and come back. Remove it again when you are done.":
    "Cette page fonctionne seulement si le réglage BAI_SETUP_KEY est présent. Ajoutez-le aux variables d'environnement de l'hébergeur (32 caractères aléatoires ou plus), redéployez, puis revenez. Retirez-le lorsque vous avez terminé.",
  "Create demo accounts for testing, or the first real business. Remove BAI_SETUP_KEY from the host when you are done.":
    "Créez des comptes de démonstration pour les essais, ou la première vraie entreprise. Retirez BAI_SETUP_KEY de l'hébergeur lorsque vous avez terminé.",
  "Set-up key (the BAI_SETUP_KEY value)": "Clé de configuration (la valeur de BAI_SETUP_KEY)", "Demo accounts": "Comptes de démonstration",
  "Three invented businesses (cleaning on Premium, snow and lawn on Professional, plumbing on Starter) with logins for owner, manager, staff, accountant and viewer, history, enquiries and agent activity. Running it again gives new passwords and never duplicates data.":
    "Trois entreprises inventées (nettoyage sur Premium, déneigement et pelouse sur Professionnel, plomberie sur Démarrage) avec des accès pour propriétaire, gestionnaire, employé, comptable et lecture seule, un historique, des demandes et de l'activité d'agents. Relancer donne de nouveaux mots de passe et ne duplique jamais les données.",
  "Create demo accounts (or new passwords)": "Créer les comptes de démonstration (ou de nouveaux mots de passe)", "Remove demo accounts": "Retirer les comptes de démonstration",
  "First real business": "Première vraie entreprise", "Business name": "Nom de l'entreprise",
  "Short name for addresses (lower-case letters, digits, dashes)": "Nom court pour les adresses (lettres minuscules, chiffres, traits d'union)",
  "Owner's name": "Nom du propriétaire", "Owner's email": "Courriel du propriétaire", "Owner's password (12+ characters)": "Mot de passe du propriétaire (12 caractères ou plus)",
  "Create business": "Créer l'entreprise", "That set-up key is not right.": "Cette clé de configuration n'est pas la bonne.",
  "Too many wrong keys. Try again in 15 minutes.": "Trop de clés erronées. Réessayez dans 15 minutes.", "Unknown action.": "Action inconnue.", "No open demo businesses.": "Aucune entreprise de démonstration ouverte.",
};

/** Fixed phrases the finance and growth tools attach to figures (sources, notes, reasons). */
const FIGURES: Record<string, string> = {
  "no social account is connected": "aucun compte de médias sociaux n'est connecté", "Google Analytics is not connected": "Google Analytics n'est pas connecté",
  "The CONARO marketplace feed is not connected": "le flux du marché CONARO n'est pas connecté", "engagement import is not built yet": "l'importation de l'engagement n'est pas encore offerte",
  "analytics import is not built yet": "l'importation des statistiques n'est pas encore offerte", "profile-visit feed from the marketplace is not built yet": "le flux des visites de profil du marché n'est pas encore offert",
  "no invoiced job came from an enquiry with a campaign tracking code": "aucun travail facturé ne provient d'une demande portant un code de suivi de campagne",
  "Attribution: last tracked campaign on the enquiry.": "Attribution : dernière campagne suivie sur la demande.",
  "job costs (materials, labour) are not recorded per job yet": "les coûts par travail (matériaux, main-d'œuvre) ne sont pas encore enregistrés",
  "supplier bills are not tracked yet; only paid expenses are imported": "les factures des fournisseurs ne sont pas encore suivies; seules les dépenses payées sont importées",
  "costs are not allocated to services; revenue per hour is shown instead": "les coûts ne sont pas répartis par service; les revenus par heure sont affichés à la place",
  "no invoices issued in this period": "aucune facture émise pendant cette période", "no payments recorded in this period": "aucun paiement enregistré pendant cette période",
  "no expenses imported": "aucune dépense importée", "no expenses categorised Advertising": "aucune dépense classée dans Publicité",
  "no transactions imported for this period": "aucune transaction importée pour cette période", "imported transactions": "transactions importées",
  "expenses categorised Advertising": "dépenses classées dans Publicité", "invoiced revenue ÷ invoices": "revenus facturés ÷ factures",
  "invoices to customers invoiced before": "factures à des clients déjà facturés", "issued invoices not fully paid": "factures émises non entièrement payées",
  "advertising expense ÷ new invoiced customers": "dépenses publicitaires ÷ nouveaux clients facturés", "Includes customers who would have come anyway.": "Comprend des clients qui seraient venus de toute façon.",
  "collected minus tax paid on expenses": "taxes perçues moins taxes payées sur les dépenses",
  "Not a confirmed liability. Input tax credits depend on eligibility and supporting documents; confirm with your accountant.":
    "Ce n'est pas un montant confirmé. Les crédits de taxe sur les intrants dépendent de l'admissibilité et des pièces justificatives; confirmez auprès de votre comptable.",
  "Assumes customers pay on time.": "Suppose que les clients paient à temps.", "One-off and new expenses are not included.": "Les dépenses ponctuelles et nouvelles ne sont pas incluses.",
  "invoices and imported income": "factures et revenus importés", "same description as earlier transactions you categorised": "même description que des transactions que vous avez déjà classées",
  "no monthly revenue target set": "aucun objectif de revenus mensuel défini",
  "no payments recorded that day": "aucun paiement enregistré ce jour-là", "no invoices issued that day": "aucune facture émise ce jour-là",
  // Why an action waits or did not run (gateway)
  "above the refund limit": "au-dessus de la limite de remboursement", "above the supplies spending limit": "au-dessus de la limite de dépenses en fournitures",
  "appointment reminders are off": "les rappels de rendez-vous sont désactivés", "automatic booking confirmation is off": "la confirmation automatique des réservations est désactivée",
  "automatic feedback requests are off": "les demandes de rétroaction automatiques sont désactivées", "automatic follow-ups are off": "les relances automatiques sont désactivées",
  "automatic invoice issuing is off": "l'émission automatique des factures est désactivée", "automatic payment reminders are off": "les rappels de paiement automatiques sont désactivés",
  "automatic quote sending is off": "l'envoi automatique des soumissions est désactivé", "automatic rescheduling is off": "le changement d'horaire automatique est désactivé",
  "autonomous marketing is off": "le marketing autonome est désactivé", "availability was not validated": "la disponibilité n'a pas été validée",
  "discount above the configured maximum": "rabais au-dessus du maximum configuré", "discount outside the configured maximum": "rabais hors du maximum configuré",
  "over the monthly marketing budget": "au-delà du budget de marketing mensuel", "post not approved and autopublish is off": "publication non approuvée et publication automatique désactivée",
  "agent set to ask before acting": "agent réglé pour demander avant d'agir", "all agents are paused by the owner": "tous les agents sont mis en pause par le propriétaire",
  "monthly action limit of the plan reached": "limite mensuelle d'actions du forfait atteinte", "SIMULATION: no external executor is connected": "SIMULATION : aucun exécutant externe n'est connecté", "plan prices are not set yet": "les prix des forfaits ne sont pas encore fixés",
};

/** Badge and status words (statusBadge replaces "_" with a space). */
const STATUS: Record<string, string> = {
  succeeded: "réussi", approved: "approuvé", executed: "exécuté", active: "actif", resolved: "résolu", queued: "en file", running: "en cours", pending: "en attente",
  "awaiting approval": "en attente d'approbation", "approval pending": "approbation en attente", "changes requested": "modifications demandées", simulated: "simulé",
  warning: "avertissement", open: "ouvert", failed: "échoué", dead: "abandonné", rejected: "refusé", blocked: "bloqué", critical: "critique", expired: "expiré",
  cancelled: "annulé", yes: "oui", upgrade: "forfait supérieur", current: "actuel", complete: "complet", trial: "essai", draft: "brouillon", sent: "envoyée",
  accepted: "acceptée", declined: "refusée", new: "nouvelle", qualified: "qualifiée", lost: "perdue", won: "gagnée", confirmed: "confirmée", completed: "terminé",
  scheduled: "planifié", "in progress": "en cours", issued: "émise", paid: "payée", "partially paid": "payée en partie", overdue: "en retard", void: "annulée",
  dismissed: "écarté", "not connected": "non connecté", operational: "fonctionnel", unreviewed: "non vérifié",
  ACTUAL: "RÉEL", TARGET: "CIBLE", ESTIMATE: "ESTIMATION", FORECAST: "PRÉVISION", UNAVAILABLE: "NON DISPONIBLE",
};

const DICT: Record<string, string> = { ...STATUS, ...FIGURES, ...UI };
for (const a of AGENTS) {
  const fr = AGENT_COPY.find((c) => c.id === a.id)?.name.fr ?? PLANNED_AGENTS_FR[a.id]?.name;
  if (fr) DICT[a.name] = fr;
}
for (const p of INDUSTRY_PACKS) if (INDUSTRY_FR[p.id]) DICT[p.name] = INDUSTRY_FR[p.id]!;
const FEATURE: Record<string, string> = {};
for (const p of PLANS) {
  if (PLAN_NAME_FR[p.id]) DICT[p.name] = PLAN_NAME_FR[p.id]!;
  p.features.forEach((f, i) => { const fr = PLAN_FEATURES_FR[p.id]?.[i]; if (fr) FEATURE[f] = fr; });
}

const tr = (s: string): string => DICT[s] ?? s;
const DAYS = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [\d:–]+(?:; )?)+$/;

/** Text with interpolated values: the fixed words change, the values stay. */
const PATTERNS: [RegExp, (...m: string[]) => string][] = [
  [/^All agents are paused: ([\s\S]*)\.$/, (_, r) => `Tous les agents sont en pause : ${r}.`],
  [/^Daily executive summary( · [\s\S]*)?$/, (_, p) => `Sommaire quotidien de direction${p ?? ""}`],
  [/^Unavailable: ([\s\S]*)$/, (_, r) => `Non disponible : ${tr(r!)}`],
  [/^(\d+) (invoice|invoices|payment|payments) (issued \(before tax\)|recorded)$/, (_, n, k, v) =>
    `${n} ${k!.startsWith("invoice") ? (k === "invoice" ? "facture émise" : "factures émises") : (k === "payment" ? "paiement enregistré" : "paiements enregistrés")}${v!.startsWith("issued") ? " (avant taxes)" : ""}`],
  [/^([\s\S]*) — Why approval: ([\s\S]*)$/, (_, x, w) => `${x} — Pourquoi une approbation : ${tr(w!)}`],
  [/^Why approval: ([\s\S]*)$/, (_, w) => `Pourquoi une approbation : ${tr(w!)}`],
  [/^less than (\d+) hours' notice$/, (_, n) => `préavis de moins de ${n} heures`],
  [/^total above the automatic limit \(([\d.]+) CAD\)$/, (_, n) => `total au-dessus de la limite automatique (${n!.replace(".", ",")} $ CA)`],
  [/^(\d+) transactions not yet reviewed by the owner$/, (_, n) => `${n} transactions pas encore vérifiées par le propriétaire`],
  [/^matched the keyword rule for ([\s\S]*)$/, (_, c) => `correspond à la règle de mot-clé pour ${c}`],
  [/^(\d+) open invoices due within 30 days$/, (_, n) => `${n} factures ouvertes payables d'ici 30 jours`],
  [/^(HST|GST) ([\d.]+)%$/, (_, k, n) => `${k === "HST" ? "TVH" : "TPS"} ${n!.replace(".", ",")} %`],
  [/^Price not set for "([\s\S]*)" \(quotes cannot be prepared\)$/, (_, s) => `Prix non défini pour « ${s} » (impossible de préparer des soumissions)`],
  [/^Industry pack: ([\s\S]*?) · Tax: ([\s\S]*?)(?: · ([\s\S]*))?$/, (_, i, t, n) => `Secteur : ${tr(i!)} · Taxes : ${translateText(t!)}${n ? ` · ${tr(n)}` : ""}`],
  [/^(\d+)%$/, (_, n) => `${n} %`],
  [/^(\d+)% \((\d+) of (\d+) h\)$/, (_, p, a, b) => `${p} % (${a} sur ${b} h)`],
  [/^— \((\d+) of (\d+) h\)$/, (_, a, b) => `— (${a} sur ${b} h)`],
  [/^(\d+) hours$/, (_, n) => `${n} heures`],
  [/^(\d+) min$/, (_, n) => `${n} min`],
  [/^(\d+) KB$/, (_, n) => `${n} Ko`],
  [/^planned \(phase (\d)\)$/, (_, n) => `prévu (phase ${n})`],
  [/^chain intact · (\d+) events$/, (_, n) => `chaîne intacte · ${n} événements`],
  [/^chain broken at ([\s\S]*)$/, (_, n) => `chaîne rompue à ${n}`],
  [/^Approved: ([\s\S]*)\.$/, (_, s) => `Approuvé : ${STATUS[s!] ?? s}.`],
  [/^The Growth Analyst is not active: ([\s\S]*)$/, (_, r) => `L'analyste du rendement n'est pas actif : ${r}`],
  [/^Imported (\d+), skipped (\d+) already imported, (\d+) unreadable rows\.$/, (_, a, b, c) => `${a} importées, ${b} déjà importées ignorées, ${c} lignes illisibles.`],
  [/^Enquiry (\S+) saved; the agents will pick it up in the next cycle\.$/, (_, r) => `Demande ${r} enregistrée; les agents la traiteront au prochain cycle.`],
  [/^Profile saved \((\d+)% complete\)\.$/, (_, n) => `Profil enregistré (complet à ${n} %).`],
  [/^Plan changed\. Switched off: ([\s\S]*)\.$/, (_, l) => `Forfait changé. Désactivés : ${l}.`],
  [/^Table: ([\s\S]*)$/, (_, h) => `Tableau : ${h!.split(", ").map(tr).join(", ")}`],
  [/^([\s\S]+) · (owner|manager|staff|accountant|viewer)$/, (_, n, r) => `${n} · ${STATUS[r!] ?? tr(r!)}`],
  [/^([^·]+)( · [\s\S]+ · CONARO Business AI)$/, (_, t, rest) => `${tr(t!)}${rest}`],
  [/^([^·]+) · CONARO Business AI$/, (_, t) => `${tr(t!)} · CONARO Business AI`],
  [/^([\s\S]+; [\s\S]+)$/, (_, l) => (l!.split("; ").every((f) => FEATURE[f]) ? l!.split("; ").map((f) => FEATURE[f]).join("; ") : l!)],
  [/^Created (\d+) demo businesses\.$/, (_, n) => `${n} entreprises de démonstration créées.`],
  [/^Closed (\d+) demo businesses and disabled their logins\. Their records are kept\.$/, (_, n) => `${n} entreprises de démonstration fermées et leurs accès désactivés. Leurs dossiers sont conservés.`],
];

function decode(s: string): string {
  return s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}
function encode(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** One piece of UI text (already decoded, trimmed): its French form, or the same text when it is not UI text. */
export function translateText(s: string): string {
  if (DICT[s] !== undefined) return DICT[s]!;
  if (DAYS.test(s)) return s.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g, (d) => DICT[d]!);
  for (const [re, f] of PATTERNS) {
    const m = s.match(re);
    if (m) return f(...(m as unknown as string[]));
  }
  return s;
}

function translateNode(raw: string): string {
  const m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m || !m[2]) return raw;
  const text = decode(m[2]);
  const out = translateText(text);
  return out === text ? raw : `${m[1]}${encode(out)}${m[3]}`;
}

const SKIP = new Set(["pre", "code", "textarea", "script", "style"]);

/** Translates the UI text of a rendered English page (see the file comment for what is never touched). */
export function translateHtml(page: string): string {
  let skip = 0; let plainOption = false;
  return page.replace(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|[^<]+/g, (tok, close: string | undefined, name: string | undefined, attrs: string | undefined) => {
    if (name) {
      const tag = name.toLowerCase();
      if (SKIP.has(tag)) skip += close ? -1 : 1;
      if (tag === "option") plainOption = !close && !/\svalue=/.test(attrs ?? "");
      if (close || skip > 0) return tok;
      if (tag === "html") return tok.replace('lang="en-CA"', 'lang="fr-CA"');
      return tok.replace(/\s(aria-label|title|placeholder)="([^"]*)"/g, (a, k: string, v: string) => ` ${k}="${encode(translateText(decode(v)))}"`);
    }
    if (tok.startsWith("<!--") || skip > 0 || plainOption) return tok;
    return translateNode(tok);
  });
}

/** Plain-text error responses. */
const PLAIN: Record<string, string> = {
  "Not allowed for your role.": "Votre rôle ne permet pas cette action.", "Form expired. Go back, reload and try again.": "Formulaire expiré. Revenez en arrière, rechargez la page et réessayez.",
  "Sign in again.": "Reconnectez-vous.", "Not found": "Introuvable", "Method not allowed": "Méthode non permise",
  "Something went wrong. It has been logged.": "Une erreur s'est produite. Elle a été consignée.",
};
export const translatePlain = (s: string) => (currentLang() === "fr" ? PLAIN[s] ?? s : s);

/** Every dictionary entry, for tests. */
export const UI_STRINGS = Object.keys(UI);
