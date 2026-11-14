// Photos and video on the landing page: openly licensed, credited in the page footer (CC BY 2.0 asks for
// attribution and a note of changes). They illustrate the kind of work our customers do; they are not CONARO customers.
// Files live in public/media (640 and 1280 px JPEGs; the hero video is made from these photos).
import type { Lang } from "../i18n.ts";

export interface Credit { title: string; author: string; license: string; source: string; changes?: Record<Lang, string> }
export interface Photo { file: string; w: number; h: number; alt: Record<Lang, string> }

const CROPPED = { en: "cropped and resized", fr: "recadrée et redimensionnée" };
const SOURCES: Record<string, Credit> = {
  "appliance-repair": { title: "Person repairs a kitchen appliance in a home kitchen", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Person_repairs_a_kitchen_appliance_in_a_home_kitchen.jpg", changes: CROPPED },
  "cleaner-smiling": { title: "Middle-aged woman cleaning home with tools in her hands wearing gloves and apron", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Middle-aged_woman_cleaning_home_with_tools_in_her_hands_wearing_gloves_and_apron.jpg", changes: CROPPED },
  "cleaning-cabinets": { title: "Woman cleaning kitchen cabinets in a bright home", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Woman_cleaning_kitchen_cabinets_in_a_bright_home.jpg", changes: CROPPED },
  "cleaning-table": { title: "Cleaning a coffee table at home with cleaning supplies and worn furniture", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Cleaning_a_coffee_table_at_home_with_cleaning_supplies_and_worn_furniture.jpg", changes: CROPPED },
  "couple-phone": { title: "Couple enjoys time together laughing and talking on the phone", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Couple_enjoys_time_together_laughing_and_talking_on_the_phone.jpg", changes: CROPPED },
  "phone-closeup": { title: "Woman talking on phone in a modern indoor space closeup", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Woman_talking_on_phone_in_a_modern_indoor_space_closeup.jpg", changes: CROPPED },
  "phone-coffee": { title: "Woman talking on the phone and holding a cup at home", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Woman_talking_on_the_phone_and_holding_a_cup_at_home.jpg", changes: CROPPED },
  "phone-kitchen": { title: "Woman talking on the phone in a kitchen while wearing pajamas", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Woman_talking_on_the_phone_in_a_kitchen_while_wearing_pajamas.jpg", changes: CROPPED },
  "phone-kitchen-water": { title: "Woman talking on phone while holding glass of water in kitchen during daytime", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Woman_talking_on_phone_while_holding_glass_of_water_in_kitchen_during_daytime.jpg", changes: CROPPED },
  "phone-morning": { title: "Woman wearing pajamas talking on phone in kitchen during morning", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Woman_wearing_pajamas_talking_on_phone_in_kitchen_during_morning.jpg", changes: CROPPED },
  "phone-window": { title: "Woman smiling while talking on the phone by the window", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Woman_smiling_while_talking_on_the_phone_by_the_window.jpg", changes: CROPPED },
  "vacuum-closeup": { title: "Cleaning the floor with a vacuum cleaner in a home setting", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Cleaning_the_floor_with_a_vacuum_cleaner_in_a_home_setting.jpg", changes: CROPPED },
  "vacuum-living-room": { title: "Person cleaning living room floor with vacuum cleaner in modern home", author: "Shixart1985", license: "CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Person_cleaning_living_room_floor_with_vacuum_cleaner_in_modern_home.jpg", changes: CROPPED },
  "electrician": { title: "Day 271 - Kev the electrician", author: "Phil and Pam", license: "CC BY 2.0", source: "https://www.flickr.com/photos/33987777@N00/2591308406", changes: CROPPED },
  "laptop-office": { title: "studying proctor", author: "joguldi", license: "CC BY 2.0", source: "https://www.flickr.com/photos/55573153@N00/113524107", changes: CROPPED },
  "laptop-window": { title: "elearn_2006_12", author: "wgreller", license: "CC BY 2.0", source: "https://www.flickr.com/photos/77773883@N00/260560053", changes: CROPPED },
  "lawn-mower": { title: "Mowing lawn with an electirc lawn mower", author: "Ivan Radic", license: "CC BY 2.0", source: "https://www.flickr.com/photos/26344495@N05/50000872276", changes: CROPPED },
  "lawn-mowing": { title: "Man Mows Lawn in the Garden", author: "rattandirectuk", license: "CC BY 2.0", source: "https://www.flickr.com/photos/166056147@N08/45857797561", changes: CROPPED },
  "painter-wall": { title: "Painter smoking during work", author: "StockyPics", license: "CC0 1.0", source: "https://www.flickr.com/photos/135371437@N04/22125776303", changes: CROPPED },
  "phone-coffee-table": { title: "Grab a coffee", author: "freestocks.org", license: "CC0 1.0", source: "https://www.flickr.com/photos/135396164@N05/25574269621", changes: CROPPED },
  "phone-social": { title: "Welcome to Twitter", author: "freestocks.org", license: "CC0 1.0", source: "https://www.flickr.com/photos/135396164@N05/25314591330", changes: CROPPED },
  "pipe-wrenches": { title: "Plumbing Pipe Wrench Plumber Edited 2020", author: "chimpwithcan", license: "CC BY 2.0", source: "https://www.flickr.com/photos/188454520@N02/49917730697", changes: CROPPED },
  "plumber-kitchen": { title: "Plumber fixing pipes (Creative commons by https://heatable.co.uk/)", author: "Heatable", license: "CC BY 2.0", source: "https://www.flickr.com/photos/194279519@N04/51634867071", changes: CROPPED },
  "snow-plow": { title: "Like a good neighbor", author: "frankieleon", license: "CC BY 2.0", source: "https://www.flickr.com/photos/23307937@N04/16561419722", changes: CROPPED },
  "snow-shovel": { title: "Jeffrey Shovels the Driveway", author: "bcmom", license: "CC BY 2.0", source: "https://www.flickr.com/photos/46857557@N00/68130573", changes: CROPPED },
};
const P = (file: keyof typeof ALT): Photo => ({ file, w: 1280, h: 853, alt: ALT[file] });
const ALT = {
  "appliance-repair": { en: "A technician repairing a kitchen appliance", fr: "Un technicien répare un appareil de cuisine" },
  "cleaner-smiling": { en: "A smiling cleaner holding a cloth and spray bottle", fr: "Une préposée à l'entretien souriante tient un chiffon et un vaporisateur" },
  "cleaning-cabinets": { en: "A woman cleaning kitchen cabinets", fr: "Une femme nettoie des armoires de cuisine" },
  "cleaning-table": { en: "A person in rubber gloves wiping a coffee table", fr: "Une personne avec des gants de caoutchouc essuie une table basse" },
  "couple-phone": { en: "A couple laughing together on the couch", fr: "Un couple rit ensemble sur le canapé" },
  "phone-closeup": { en: "A woman smiling during a phone call", fr: "Une femme sourit pendant un appel téléphonique" },
  "phone-coffee": { en: "A business owner on the phone with a morning coffee", fr: "Une propriétaire d'entreprise au téléphone avec son café du matin" },
  "phone-kitchen": { en: "A woman on the phone in her kitchen, waving", fr: "Une femme au téléphone dans sa cuisine, faisant un signe de la main" },
  "phone-kitchen-water": { en: "A woman on the phone in a bright kitchen", fr: "Une femme au téléphone dans une cuisine lumineuse" },
  "phone-morning": { en: "A woman taking a call at the kitchen counter", fr: "Une femme prend un appel au comptoir de la cuisine" },
  "phone-window": { en: "A woman smiling on the phone by a window", fr: "Une femme sourit au téléphone près d'une fenêtre" },
  "vacuum-closeup": { en: "Vacuuming a rug, close up", fr: "Aspirateur sur un tapis, en gros plan" },
  "vacuum-living-room": { en: "Vacuuming a living room floor", fr: "On passe l'aspirateur dans un salon" },
  "electrician": { en: "A tradesman checking tiles with a level", fr: "Un ouvrier vérifie des carreaux avec un niveau" },
  "laptop-office": { en: "A woman working on a laptop at her desk", fr: "Une femme travaille sur un ordinateur portable à son bureau" },
  "laptop-window": { en: "A woman working on a laptop by a window", fr: "Une femme travaille sur un ordinateur portable près d'une fenêtre" },
  "lawn-mower": { en: "A lawn mower cutting grass, close up", fr: "Une tondeuse coupe le gazon, en gros plan" },
  "lawn-mowing": { en: "A man mowing a lawn beside flower pots", fr: "Un homme tond une pelouse près de pots de fleurs" },
  "painter-wall": { en: "A painter preparing paint beside a house wall", fr: "Un peintre prépare la peinture près du mur d'une maison" },
  "phone-coffee-table": { en: "A smartphone beside a cup of coffee", fr: "Un téléphone intelligent à côté d'une tasse de café" },
  "phone-social": { en: "A hand holding a smartphone open on a social app", fr: "Une main tient un téléphone ouvert sur une application sociale" },
  "pipe-wrenches": { en: "Pipe wrenches on a plumbing pipe", fr: "Des clés à tuyau sur une conduite de plomberie" },
  "plumber-kitchen": { en: "A plumber kneeling at work in a kitchen", fr: "Un plombier à genoux au travail dans une cuisine" },
  "snow-plow": { en: "A backhoe clearing deep snow from a driveway", fr: "Une rétrocaveuse dégage la neige d'une entrée" },
  "snow-shovel": { en: "A man shovelling a snowy driveway", fr: "Un homme déneige une entrée à la pelle" },
} satisfies Record<string, Record<Lang, string>>;

/** Each agent's presenter photo: the moment of work it handles. */
export const AGENT_PHOTO: Record<string, Photo> = {
  "business-manager": P("phone-coffee"), "growth-analyst": P("phone-kitchen"),
  "customer-service": P("phone-closeup"), sales: P("phone-window"), quotation: P("plumber-kitchen"),
  booking: P("phone-kitchen-water"), workforce: P("snow-shovel"), operations: P("appliance-repair"),
  invoicing: P("phone-morning"), accounting: P("laptop-window"), tax: P("laptop-office"), "financial-analyst": P("lawn-mowing"),
  "marketing-director": P("couple-phone"), "social-media-manager": P("phone-social"), "local-seo": P("phone-coffee-table"),
  crm: P("cleaning-cabinets"), reputation: P("cleaner-smiling"), "admin-assistant": P("vacuum-closeup"),
};

/** "A day with your AI team", one photo per moment. */
export const DAY_PHOTOS: Photo[] = [P("phone-coffee"), P("phone-window"), P("plumber-kitchen"), P("phone-kitchen-water"), P("snow-plow"), P("laptop-window")];

/** Trades in the hero strip that have a photo. */
export const TRADE_PHOTO: Record<string, Photo> = {
  "residential-cleaning": P("vacuum-living-room"), "commercial-cleaning": P("cleaning-cabinets"), "lawn-care": P("lawn-mowing"), landscaping: P("lawn-mower"),
  "snow-removal": P("snow-plow"), plumbing: P("pipe-wrenches"), handyman: P("electrician"), "home-renovation": P("electrician"),
  painting: P("painter-wall"), "appliance-repair": P("appliance-repair"),
};

/** Hero background: real footage of local work (Mixkit Stock Video Free License: commercial use allowed), cut into one
 *  muted, looping 22-second video with crossfades (made with ffmpeg; files in public/media). */
export const HERO_VIDEO = { mp4: "hero.mp4", webm: "hero.webm", poster: "hero-poster.jpg" };
const TRIMMED = { en: "trimmed and combined into the background video", fr: "coupée et assemblée dans la vidéo de fond" };
const HERO_CLIPS: Credit[] = [
  { title: "Snowing on the streets of Canada", author: "Mixkit", license: "Mixkit Stock Video Free License", source: "https://mixkit.co/free-stock-video/snowing-on-the-streets-of-canada-3323/", changes: TRIMMED },
  { title: "Carpenter marking a piece of wood", author: "Mixkit", license: "Mixkit Stock Video Free License", source: "https://mixkit.co/free-stock-video/carpenter-marking-a-piece-of-wood-778/", changes: TRIMMED },
  { title: "Delivering a package to the door of a house", author: "Mixkit", license: "Mixkit Stock Video Free License", source: "https://mixkit.co/free-stock-video/delivering-a-package-to-the-door-of-a-house-31155/", changes: TRIMMED },
  { title: "Mechanic repairing a car engine", author: "Mixkit", license: "Mixkit Stock Video Free License", source: "https://mixkit.co/free-stock-video/mechanic-repairing-a-car-engine-4716/", changes: TRIMMED },
  { title: "Gardener arranging the soil for a plant", author: "Mixkit", license: "Mixkit Stock Video Free License", source: "https://mixkit.co/free-stock-video/gardener-arranging-the-soil-for-a-plant-43697/", changes: TRIMMED },
  { title: "Hand of a carpenter leveling a wooden board", author: "Mixkit", license: "Mixkit Stock Video Free License", source: "https://mixkit.co/free-stock-video/hand-of-a-carpenter-leveling-a-wooden-board-39684/", changes: TRIMMED },
  { title: "Man answering a whatsapp", author: "Mixkit", license: "Mixkit Stock Video Free License", source: "https://mixkit.co/free-stock-video/man-answering-a-whatsapp-41165/", changes: TRIMMED },
];

/** Explainer narration: AI voices made with Piper (open-source text-to-speech) from models trained on these recordings. */
const VOICES: Credit[] = [
  { title: "Narration voice (English): Piper en_US-ljspeech-high, trained on the LJ Speech Dataset", author: "Keith Ito and Linda Johnson; Piper voice by the Rhasspy project", license: "Public domain (dataset); MIT (Piper)",
    source: "https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ljspeech/high", changes: { en: "used to generate the English explainer audio", fr: "utilisée pour produire l'audio des présentations en anglais" } },
  { title: "Narration voice (French): Piper fr_FR-siwis-medium, trained on the SIWIS French Speech Synthesis Database", author: "Junichi Yamagishi, Pierre-Edouard Honnet et al. (University of Edinburgh, Idiap); Piper voice by the Rhasspy project", license: "CC BY 4.0 (dataset); MIT (Piper)",
    source: "https://datashare.ed.ac.uk/handle/10283/2353", changes: { en: "used to generate the French explainer audio", fr: "utilisée pour produire l'audio des présentations en français" } },
];

export const CREDITS: Credit[] = [...HERO_CLIPS, ...Object.values(SOURCES), ...VOICES];
