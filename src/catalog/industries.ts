/**
 * Industry intelligence packs (brief §5).
 *
 * A pack says WHICH factors matter in an industry; it never supplies numbers
 * the business has not given. Durations and prices come only from the
 * business's own services (bai_services). Regulatory items are prompts to
 * confirm with the relevant authority, not legal statements.
 *
 * Packs are applied by id only. Nothing reads another pack's assumptions:
 * the tools take `IndustryPack` for the tenant's own industry
 * (tests/business-ai-catalog.test.ts checks distinct, complete packs).
 */
export interface IndustryPack {
  id: string;
  name: string;
  agents: string[];
  enquiries: string[];
  bookingFields: string[];
  durationBasis: string;
  pricingVariables: string[];
  workflows: {
    recurring: boolean;
    emergency: boolean;
    weatherAware: boolean;
    /** Months (1–12) with typical demand; empty = year-round. */
    seasonMonths: number[];
    equipment: boolean;
    vehicleCapacity: boolean;
    mobile: boolean;
    qualifiedStaff: boolean;
  };
  checklist: string[];
  safety: string[];
  regulatory: string[];
  marketing: { theme: string; months: number[] }[];
  kpis: string[];
}

const CORE = ["business-manager", "booking", "customer-service", "sales", "quotation", "crm", "invoicing", "growth-analyst",
  "admin-assistant", "reputation", "marketing-director", "social-media-manager", "local-seo", "accounting", "tax", "financial-analyst"];
const CREW = [...CORE, "workforce", "operations"];
const MATERIALS = [...CREW, "inventory"];

const W = (o: Partial<IndustryPack["workflows"]>): IndustryPack["workflows"] => ({
  recurring: false, emergency: false, weatherAware: false, seasonMonths: [], equipment: false,
  vehicleCapacity: false, mobile: true, qualifiedStaff: false, ...o,
});
const ALL_YEAR: number[] = [];
const SPRING_FALL = [4, 5, 6, 7, 8, 9, 10];
const WINTER = [11, 12, 1, 2, 3];
const BASE_KPIS = ["Quote-to-booking conversion", "Average job value", "Repeat customer rate", "Utilisation of working hours"];
const CONFIRM_INSURANCE = "Confirm the liability insurance your clients and CONARO expect for this work.";

export const INDUSTRY_PACKS: IndustryPack[] = [
  { id: "residential-cleaning", name: "Residential cleaning", agents: CREW,
    enquiries: ["How much for a standard clean?", "Do you bring your own supplies?", "Can you do a move-out clean?", "Can I book every two weeks?"],
    bookingFields: ["Number of bedrooms and bathrooms", "Type of clean (standard, deep, move-in/out)", "Pets in the home", "Access instructions"],
    durationBasis: "Home size, rooms and type of clean; set per service.", pricingVariables: ["Bedrooms", "Bathrooms", "Clean type", "Frequency", "Add-ons (oven, fridge, windows)"],
    workflows: W({ recurring: true }), checklist: ["Confirm access", "Walk-through on arrival", "Room-by-room checklist", "Photos of finished rooms if the client agrees"],
    safety: ["Chemical handling and ventilation", "Slip hazards"], regulatory: [CONFIRM_INSURANCE],
    marketing: [{ theme: "Spring cleaning", months: [3, 4, 5] }, { theme: "Holiday preparation", months: [11, 12] }, { theme: "Move-out cleans", months: [6, 7, 8] }],
    kpis: [...BASE_KPIS, "Recurring client count", "Re-clean requests"] },
  { id: "commercial-cleaning", name: "Commercial cleaning", agents: CREW,
    enquiries: ["Can you clean after hours?", "Do you sign service agreements?", "Can you provide a quote per visit?"],
    bookingFields: ["Floor area", "Cleaning frequency", "After-hours access", "Site contact"],
    durationBasis: "Floor area, frequency and scope of work; set per site.", pricingVariables: ["Area", "Visits per week", "Scope", "Supplies included"],
    workflows: W({ recurring: true, qualifiedStaff: true }), checklist: ["Site security procedure", "Scope checklist per visit", "Supply levels"],
    safety: ["Working alone after hours", "Chemical labelling (WHMIS)"], regulatory: [CONFIRM_INSURANCE, "Confirm any client-required security clearances or WHMIS training records."],
    marketing: [{ theme: "New-year office contracts", months: [1, 2] }, { theme: "Post-construction cleans", months: SPRING_FALL }],
    kpis: [...BASE_KPIS, "Contract renewals", "Complaints per site"] },
  { id: "landscaping", name: "Landscaping", agents: MATERIALS,
    enquiries: ["Can you redesign my garden?", "Do you supply plants and soil?", "When can you start?"],
    bookingFields: ["Property size", "Scope (design, planting, hardscape)", "Site photos", "Access for equipment"],
    durationBasis: "Scope and site conditions; quote after a site visit.", pricingVariables: ["Materials", "Labour hours", "Equipment", "Disposal"],
    workflows: W({ weatherAware: true, seasonMonths: SPRING_FALL, equipment: true }), checklist: ["Call before you dig", "Material delivery", "Equipment check", "Site clean-up"],
    safety: ["Underground utilities", "Equipment operation"], regulatory: [CONFIRM_INSURANCE, "Confirm utility locate requirements before any digging."],
    marketing: [{ theme: "Spring landscaping bookings", months: [3, 4] }, { theme: "Fall clean-ups", months: [9, 10] }],
    kpis: [...BASE_KPIS, "Weather-delayed jobs", "Materials margin"] },
  { id: "lawn-care", name: "Lawn care", agents: CREW,
    enquiries: ["How often do you mow?", "Do you do aeration?", "Is there a seasonal contract?"],
    bookingFields: ["Lawn size", "Frequency", "Gate access", "Pets"],
    durationBasis: "Lawn size and frequency; set per service.", pricingVariables: ["Lawn size", "Frequency", "Season contract"],
    workflows: W({ recurring: true, weatherAware: true, seasonMonths: [5, 6, 7, 8, 9, 10], equipment: true }), checklist: ["Gate closed on exit", "Clippings handled as agreed"],
    safety: ["Mower operation", "Hidden debris"], regulatory: [CONFIRM_INSURANCE, "Confirm provincial rules before applying any pesticide or fertiliser product."],
    marketing: [{ theme: "Season contract sign-ups", months: [3, 4] }, { theme: "Aeration and overseeding", months: [9] }],
    kpis: [...BASE_KPIS, "Season contracts", "Weather cancellations"] },
  { id: "snow-removal", name: "Snow removal", agents: CREW,
    enquiries: ["Do you have a seasonal contract?", "How soon after a storm do you come?", "Do you salt?"],
    bookingFields: ["Driveway or lot size", "Contract or per visit", "Priority (e.g. leave for work time)", "Obstacles"],
    durationBasis: "Area and snowfall; routes are planned per storm.", pricingVariables: ["Area", "Season contract vs per visit", "Salting", "Snowfall trigger"],
    workflows: W({ recurring: true, weatherAware: true, seasonMonths: WINTER, equipment: true, emergency: true }), checklist: ["Route order", "Marker stakes", "Salting log"],
    safety: ["Night operation visibility", "Ice and slip liability"], regulatory: [CONFIRM_INSURANCE, "Keep a service log of visits and salting for liability purposes; confirm requirements with your insurer."],
    marketing: [{ theme: "Season contracts before the first snowfall", months: [9, 10, 11] }],
    kpis: [...BASE_KPIS, "Time to clear after snowfall", "Contracts per route"] },
  { id: "plumbing", name: "Plumbing", agents: MATERIALS,
    enquiries: ["Can someone come today? It's leaking.", "Do you install water heaters?", "What's your call-out fee?"],
    bookingFields: ["Problem description and photos", "Urgency (active leak?)", "Water shut-off located", "Property type"],
    durationBasis: "Diagnosis first; repair time varies by job.", pricingVariables: ["Call-out fee", "Hourly labour", "Parts", "After-hours premium"],
    workflows: W({ emergency: true, qualifiedStaff: true }), checklist: ["Shut-off confirmed", "Parts used recorded", "Test for leaks"],
    safety: ["Water and electricity", "Confined spaces", "Hot water and gas appliances"], regulatory: [CONFIRM_INSURANCE, "Confirm trade certification and permit requirements for plumbing work with the provincial authority."],
    marketing: [{ theme: "Winter pipe freeze prevention", months: [10, 11] }, { theme: "Water heater checks", months: ALL_YEAR }],
    kpis: [...BASE_KPIS, "Emergency response time", "First-visit fix rate"] },
  { id: "electrical", name: "Electrical services", agents: MATERIALS,
    enquiries: ["Can you install a charger for my EV?", "My breaker keeps tripping.", "Do you pull permits?"],
    bookingFields: ["Problem or project description", "Panel information", "Urgency (safety risk?)", "Photos"],
    durationBasis: "Assessment first; set per service.", pricingVariables: ["Hourly labour", "Materials", "Permit fees", "Emergency premium"],
    workflows: W({ emergency: true, qualifiedStaff: true }), checklist: ["Power isolated", "Permit recorded where required", "Test and label"],
    safety: ["Electrical hazard", "Lockout procedures"], regulatory: [CONFIRM_INSURANCE, "Only qualified, licensed staff may be assigned; confirm licensing and permit rules with the provincial authority."],
    marketing: [{ theme: "Holiday lighting safety", months: [11, 12] }, { theme: "EV charger installs", months: ALL_YEAR }],
    kpis: [...BASE_KPIS, "Emergency response time", "Permit turnaround"] },
  { id: "hvac", name: "HVAC", agents: MATERIALS,
    enquiries: ["My furnace isn't working.", "Do you install heat pumps?", "Do you have maintenance plans?"],
    bookingFields: ["System type and age", "Problem description", "Urgency (no heat?)", "Access to unit"],
    durationBasis: "System type and job; set per service.", pricingVariables: ["Diagnostic fee", "Labour", "Parts", "Maintenance plan"],
    workflows: W({ emergency: true, qualifiedStaff: true, recurring: true, seasonMonths: [9, 10, 11, 5, 6] }), checklist: ["Safety check", "Filter replaced", "Readings recorded"],
    safety: ["Gas appliances", "Refrigerants", "Carbon monoxide"], regulatory: [CONFIRM_INSURANCE, "Confirm gas-fitter and refrigerant-handling certifications required for the work."],
    marketing: [{ theme: "Pre-winter furnace tune-ups", months: [9, 10] }, { theme: "Pre-summer heat pump service", months: [5, 6] }],
    kpis: [...BASE_KPIS, "Maintenance plan renewals", "No-heat response time"] },
  { id: "handyman", name: "Handyman services", agents: CREW,
    enquiries: ["Can you do a list of small jobs?", "Do you charge by the hour?", "Can you mount a TV?"],
    bookingFields: ["List of tasks", "Photos", "Materials on site?", "Access"],
    durationBasis: "Sum of the listed tasks; set per service.", pricingVariables: ["Hourly rate", "Minimum charge", "Materials", "Travel"],
    workflows: W({}), checklist: ["Confirm the task list on arrival", "Materials used recorded"],
    safety: ["Ladders", "Power tools"], regulatory: [CONFIRM_INSURANCE, "Refer electrical, plumbing or gas work that requires a licensed trade."],
    marketing: [{ theme: "Spring fix-up lists", months: [4, 5] }, { theme: "Winterising", months: [10] }],
    kpis: [...BASE_KPIS, "Tasks per visit"] },
  { id: "general-contracting", name: "General contracting", agents: MATERIALS,
    enquiries: ["Can you manage my whole project?", "What does an estimate include?", "How long will it take?"],
    bookingFields: ["Project scope", "Drawings or photos", "Budget range", "Desired timeline"],
    durationBasis: "Project plan with phases; estimate after a site visit.", pricingVariables: ["Materials", "Subcontractors", "Labour", "Permits", "Contingency"],
    workflows: W({ qualifiedStaff: true, equipment: true }), checklist: ["Written scope and change-order process", "Permits", "Subcontractor schedule"],
    safety: ["Site safety plan", "Fall protection"], regulatory: [CONFIRM_INSURANCE, "Confirm building permit, workplace safety and contract requirements before work starts."],
    marketing: [{ theme: "Plan next season's projects", months: [1, 2, 3] }],
    kpis: [...BASE_KPIS, "Projects on budget", "Change orders per project"] },
  { id: "painting", name: "Painting", agents: MATERIALS,
    enquiries: ["How much to paint a room?", "Do you do exteriors?", "Do you move furniture?"],
    bookingFields: ["Rooms or surfaces", "Interior or exterior", "Colours chosen?", "Surface condition"],
    durationBasis: "Area, coats and preparation; set per service.", pricingVariables: ["Area", "Coats", "Preparation", "Paint supplied by"],
    workflows: W({ weatherAware: true, seasonMonths: [5, 6, 7, 8, 9] }), checklist: ["Surfaces protected", "Colour codes recorded", "Touch-up walk-through"],
    safety: ["Ladders and scaffolds", "Ventilation", "Lead paint in older homes"], regulatory: [CONFIRM_INSURANCE, "Follow safe practices for older homes that may contain lead paint."],
    marketing: [{ theme: "Exterior painting season", months: [4, 5] }, { theme: "Interior refresh", months: [1, 2, 11] }],
    kpis: [...BASE_KPIS, "Weather delays (exterior)"] },
  { id: "moving", name: "Moving services", agents: CREW,
    enquiries: ["How much to move a two-bedroom?", "Do you provide boxes?", "Can you move a piano?"],
    bookingFields: ["Origin and destination", "Home size / inventory", "Stairs and elevators", "Special items", "Moving date"],
    durationBasis: "Inventory volume, distance and access; set per service.", pricingVariables: ["Crew size", "Truck size", "Hours", "Distance", "Special items"],
    workflows: W({ vehicleCapacity: true, equipment: true, seasonMonths: [5, 6, 7, 8] }), checklist: ["Inventory confirmed", "Truck capacity checked", "Damage check at delivery"],
    safety: ["Lifting injuries", "Vehicle safety"], regulatory: [CONFIRM_INSURANCE, "Confirm cargo insurance and commercial vehicle requirements."],
    marketing: [{ theme: "Peak moving season", months: [5, 6, 7] }, { theme: "Student moves", months: [8, 9] }],
    kpis: [...BASE_KPIS, "Truck utilisation", "Damage claims"] },
  { id: "appliance-repair", name: "Appliance repair", agents: MATERIALS,
    enquiries: ["My dishwasher won't drain.", "Do you repair this brand?", "What's the diagnostic fee?"],
    bookingFields: ["Appliance type, brand and model", "Problem description", "Warranty status"],
    durationBasis: "Diagnosis first; parts may need a second visit.", pricingVariables: ["Diagnostic fee", "Labour", "Parts"],
    workflows: W({ qualifiedStaff: true }), checklist: ["Model and serial recorded", "Parts ordered", "Test after repair"],
    safety: ["Electrical and gas appliances"], regulatory: [CONFIRM_INSURANCE, "Gas appliance work may need a certified gas technician."],
    marketing: [{ theme: "Holiday cooking season checks", months: [11, 12] }],
    kpis: [...BASE_KPIS, "First-visit fix rate", "Parts wait time"] },
  { id: "automotive", name: "Automotive services", agents: MATERIALS,
    enquiries: ["Can you change my tires?", "Do you do mobile service?", "How long is an oil change?"],
    bookingFields: ["Vehicle make, model and year", "Service needed", "Location (mobile?)"],
    durationBasis: "Service type; set per service.", pricingVariables: ["Labour", "Parts", "Mobile fee"],
    workflows: W({ seasonMonths: [4, 10, 11], qualifiedStaff: true, equipment: true }), checklist: ["Vehicle condition recorded", "Torque check", "Parts used"],
    safety: ["Vehicle lifting", "Fluids disposal"], regulatory: [CONFIRM_INSURANCE, "Confirm technician certification and waste-fluid disposal rules."],
    marketing: [{ theme: "Winter tire changeover", months: [10, 11] }, { theme: "Spring changeover", months: [4] }],
    kpis: [...BASE_KPIS, "Bays or vans utilisation"] },
  { id: "pet-care", name: "Pet care", agents: CORE,
    enquiries: ["Can you walk my dog daily?", "Do you do overnight sitting?", "Are you insured?"],
    bookingFields: ["Pet type and temperament", "Medical needs", "Emergency vet contact", "Access instructions"],
    durationBasis: "Visit length chosen by the client; set per service.", pricingVariables: ["Visit length", "Number of pets", "Holidays"],
    workflows: W({ recurring: true }), checklist: ["Feeding and medication log", "Update photo to the owner if agreed"],
    safety: ["Animal behaviour", "Allergies"], regulatory: [CONFIRM_INSURANCE],
    marketing: [{ theme: "Holiday pet sitting", months: [6, 7, 12] }],
    kpis: [...BASE_KPIS, "Recurring clients"] },
  { id: "pest-control", name: "Pest control", agents: MATERIALS,
    enquiries: ["I have mice, can you help?", "Is the treatment safe for pets?", "Do you guarantee results?"],
    bookingFields: ["Pest type", "Property type", "Children or pets present", "Photos"],
    durationBasis: "Inspection first; treatment plan follows.", pricingVariables: ["Inspection fee", "Treatment", "Follow-up visits"],
    workflows: W({ qualifiedStaff: true, seasonMonths: [4, 5, 6, 7, 8, 9, 10] }), checklist: ["Product and quantity log", "Safety instructions given", "Follow-up scheduled"],
    safety: ["Pesticide exposure", "Children and pets"], regulatory: [CONFIRM_INSURANCE, "Pesticide application usually requires a provincial licence; confirm before assigning staff."],
    marketing: [{ theme: "Spring ant and wasp season", months: [4, 5, 6] }, { theme: "Fall rodent proofing", months: [9, 10] }],
    kpis: [...BASE_KPIS, "Re-treatment rate"] },
  { id: "home-renovation", name: "Home renovation", agents: MATERIALS,
    enquiries: ["Can you renovate my kitchen?", "Do you handle permits?", "Can I see past work?"],
    bookingFields: ["Room and scope", "Budget range", "Timeline", "Photos or drawings"],
    durationBasis: "Project plan after a site visit.", pricingVariables: ["Materials", "Labour", "Subcontractors", "Permits", "Contingency"],
    workflows: W({ qualifiedStaff: true, equipment: true }), checklist: ["Signed scope", "Change orders in writing", "Final walk-through"],
    safety: ["Dust and asbestos in older homes", "Fall protection"], regulatory: [CONFIRM_INSURANCE, "Confirm building permit and inspection requirements with your municipality."],
    marketing: [{ theme: "Winter interior projects", months: [11, 12, 1, 2] }],
    kpis: [...BASE_KPIS, "Projects on schedule"] },
  { id: "roofing", name: "Roofing", agents: MATERIALS,
    enquiries: ["My roof is leaking.", "How much for new shingles?", "Do you do inspections?"],
    bookingFields: ["Roof type and age", "Leak or replacement", "Photos", "Access"],
    durationBasis: "Roof area and pitch; set per job after inspection.", pricingVariables: ["Area", "Pitch", "Material", "Tear-off", "Disposal"],
    workflows: W({ weatherAware: true, emergency: true, seasonMonths: [5, 6, 7, 8, 9, 10], equipment: true, qualifiedStaff: true }), checklist: ["Fall protection", "Weather check", "Debris clean-up"],
    safety: ["Working at heights"], regulatory: [CONFIRM_INSURANCE, "Confirm fall-protection training and workplace safety rules for roof work."],
    marketing: [{ theme: "Post-storm inspections", months: ALL_YEAR }, { theme: "Pre-winter inspections", months: [9, 10] }],
    kpis: [...BASE_KPIS, "Weather delays", "Warranty calls"] },
  { id: "pressure-washing", name: "Pressure washing", agents: CREW,
    enquiries: ["Can you clean my deck?", "Do you wash siding?", "How much for a driveway?"],
    bookingFields: ["Surfaces and area", "Water access", "Photos"],
    durationBasis: "Surface area; set per service.", pricingVariables: ["Area", "Surface type", "Sealing"],
    workflows: W({ weatherAware: true, seasonMonths: [5, 6, 7, 8, 9], equipment: true }), checklist: ["Protect plants and openings", "Water source confirmed"],
    safety: ["High-pressure equipment", "Slippery surfaces"], regulatory: [CONFIRM_INSURANCE, "Confirm local rules on wash-water runoff and cleaning products."],
    marketing: [{ theme: "Spring deck and siding", months: [4, 5] }],
    kpis: [...BASE_KPIS, "Weather cancellations"] },
  { id: "window-cleaning", name: "Window cleaning", agents: CREW,
    enquiries: ["Inside and outside?", "Do you do second storey?", "Can I book spring and fall?"],
    bookingFields: ["Number of windows", "Storeys", "Inside/outside", "Screens"],
    durationBasis: "Window count and access; set per service.", pricingVariables: ["Windows", "Storeys", "Inside/outside", "Screens and tracks"],
    workflows: W({ recurring: true, weatherAware: true, seasonMonths: [4, 5, 6, 9, 10] }), checklist: ["Ladder safety check", "Screens returned"],
    safety: ["Ladders and heights"], regulatory: [CONFIRM_INSURANCE],
    marketing: [{ theme: "Spring windows", months: [4, 5] }, { theme: "Fall windows", months: [9, 10] }],
    kpis: [...BASE_KPIS, "Twice-yearly clients"] },
  { id: "photography", name: "Photography", agents: CORE,
    enquiries: ["Are you available on my date?", "What packages do you offer?", "When will I get the photos?"],
    bookingFields: ["Event or session type", "Date and location", "Hours of coverage", "Deliverables"],
    durationBasis: "Package hours plus editing time; set per package.", pricingVariables: ["Hours", "Deliverables", "Travel", "Prints"],
    workflows: W({ seasonMonths: [5, 6, 7, 8, 9, 12] }), checklist: ["Shot list", "Model releases where needed", "Delivery date"],
    safety: [], regulatory: ["Get written consent before using client images in marketing.", "Confirm contract terms for usage rights."],
    marketing: [{ theme: "Wedding season bookings", months: [1, 2, 3] }, { theme: "Holiday mini-sessions", months: [10, 11] }],
    kpis: [...BASE_KPIS, "Delivery on time"] },
  { id: "event-services", name: "Event services", agents: MATERIALS,
    enquiries: ["Are you free on this date?", "What's included?", "Do you need a deposit?"],
    bookingFields: ["Event date and venue", "Guest count", "Services needed", "Set-up time"],
    durationBasis: "Event length plus set-up and tear-down; set per package.", pricingVariables: ["Guest count", "Hours", "Equipment", "Staff"],
    workflows: W({ equipment: true, vehicleCapacity: true, seasonMonths: [5, 6, 7, 8, 9, 12] }), checklist: ["Run sheet", "Equipment list", "Venue contact"],
    safety: ["Crowd and equipment safety"], regulatory: [CONFIRM_INSURANCE, "Confirm venue, permit and any licensing requirements for the event."],
    marketing: [{ theme: "Holiday parties", months: [9, 10, 11] }, { theme: "Summer events", months: [3, 4] }],
    kpis: [...BASE_KPIS, "Deposits collected"] },
  { id: "personal-care", name: "Personal care and beauty", agents: CORE,
    enquiries: ["Do you have an opening this week?", "How long does it take?", "What's your cancellation policy?"],
    bookingFields: ["Service", "Preferred practitioner", "Allergies or sensitivities"],
    durationBasis: "Fixed per service; set per service.", pricingVariables: ["Service", "Practitioner", "Add-ons"],
    workflows: W({ recurring: true, mobile: false, qualifiedStaff: true }), checklist: ["Allergy check", "Sanitation log"],
    safety: ["Allergic reactions", "Hygiene"], regulatory: ["Confirm provincial or municipal licensing and health inspection requirements for your services."],
    marketing: [{ theme: "Holiday and event season", months: [11, 12, 5, 6] }],
    kpis: [...BASE_KPIS, "Rebooking rate", "No-show rate"] },
  { id: "professional-consulting", name: "Professional consulting", agents: CORE,
    enquiries: ["Do you offer a free consultation?", "What are your rates?", "Can we meet online?"],
    bookingFields: ["Topic", "Organisation size", "Preferred format"],
    durationBasis: "Session length or project scope; set per service.", pricingVariables: ["Hourly or fixed fee", "Scope"],
    workflows: W({ mobile: false }), checklist: ["Engagement letter", "Agenda"],
    safety: [], regulatory: ["Confirm whether your advice falls under a regulated profession and keep engagement letters."],
    marketing: [{ theme: "Planning season", months: [1, 9] }],
    kpis: [...BASE_KPIS, "Proposal win rate"] },
  { id: "other-local-services", name: "Other local service businesses", agents: CORE,
    enquiries: ["What do you charge?", "When are you available?", "What areas do you serve?"],
    bookingFields: ["Service needed", "Location", "Preferred time"],
    durationBasis: "Set per service by the business.", pricingVariables: ["Set per service"],
    workflows: W({}), checklist: ["Confirm scope on arrival"],
    safety: [], regulatory: [CONFIRM_INSURANCE, "Confirm any licensing that applies to your services."],
    marketing: [], kpis: BASE_KPIS },
];

export const PACK_BY_ID = new Map(INDUSTRY_PACKS.map((p) => [p.id, p]));

export function industryPack(id: string): IndustryPack {
  return PACK_BY_ID.get(id) ?? (PACK_BY_ID.get("other-local-services") as IndustryPack);
}
