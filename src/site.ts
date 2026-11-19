// A community's site: how it shows on Anthill, set by whoever may change its
// settings (OffchainTree.canChangeSettings). Which pages it shows besides its
// home ("You", always on), an accent colour from a fixed palette, and an
// About text in Markdown (the frontend renders it, safely; here it's only
// text). Pages are presentation: a page that's off is hidden, nothing in it
// is deleted and no rule changes.
//
// Pages are a record of booleans, { explore, polls, people, agents }, in the
// API and in the log. The log keeps only the pages the community could choose
// when it saved: a page it couldn't (Agents, before the operator gave it a
// commons) or one added later is on by default, as for a community that never
// saved its site. An Agents choice it made earlier is kept by a save while it
// can't choose (its commons taken away for a while), so the choice comes back
// with the commons. A name this code doesn't know (from a newer version,
// rolled back) shows as the default.

import { ActionError } from "./offchain";

// in the order the site shows them
export const SITE_PAGES = ["explore", "polls", "people", "agents"] as const;
export type SitePage = (typeof SITE_PAGES)[number];

// The palette's names; the frontend has the colours (light and dark). Indigo
// is the look from before sites.
export const ACCENTS = ["indigo", "blue", "teal", "green", "amber", "orange", "rose", "violet"] as const;
export type Accent = (typeof ACCENTS)[number];
export const DEFAULT_ACCENT: Accent = "indigo";

export const MAX_ABOUT = 10_000;

export type SitePages = Record<SitePage, boolean>;

// As logged (see the top): pages, the ones it could choose.
export type StoredSite = { pages: Partial<SitePages>; accent: string; about: string };

export type Site = { pages: SitePages; accent: Accent; about: string };

export const DEFAULT_SITE: StoredSite = { pages: {}, accent: DEFAULT_ACCENT, about: "" };

const isPage = (v: unknown): v is SitePage => (SITE_PAGES as readonly unknown[]).includes(v);
const isAccent = (v: unknown): v is Accent => (ACCENTS as readonly unknown[]).includes(v);

// The pages a community can show: Agents only where the operator configured
// a commons (COMMONS_SITES).
function available(hasCommons: boolean): SitePage[] {
  return SITE_PAGES.filter((p) => p !== "agents" || hasCommons);
}

// The site as it shows, from what's logged (DEFAULT_SITE if nothing is).
export function siteView(stored: StoredSite, hasCommons: boolean): Site {
  const shown = new Set(available(hasCommons).filter((p) => stored.pages[p] !== false));
  return {
    pages: Object.fromEntries(SITE_PAGES.map((p) => [p, shown.has(p)])) as SitePages,
    accent: isAccent(stored.accent) ? stored.accent : DEFAULT_ACCENT,
    about: stored.about,
  };
}

// For community summaries, which are listed: the About only says whether
// there is one (GET /c/<id>/site has the text).
export function siteSummary(stored: StoredSite, hasCommons: boolean) {
  const { pages, accent, about } = siteView(stored, hasCommons);
  return { pages, accent, hasAbout: about !== "" };
}

// Control characters but tabs and line breaks (as \n), which Markdown needs.
const CONTROL = /[^\P{Cc}\t\n]/gu;

// What shows nothing on its own: whitespace, and characters like zero-width
// spaces and joiners, soft hyphens and variation selectors.
const INVISIBLE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}]/gu;

// The About as it's kept: line breaks made \n, control characters out,
// trailing whitespace and leading blank lines trimmed (leading spaces on the
// first line stay: in Markdown they can mean code). One with nothing visible
// (zero-width characters pasted in) is none, or it would show as an empty
// About tab; inside text they stay (emoji and some scripts need joiners).
export function cleanAbout(v: string): string {
  const cleaned = v
    .normalize("NFC")
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(CONTROL, "")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  return cleaned.replace(INVISIBLE, "") === "" ? "" : cleaned;
}

const PAGES_RECORD = `pages must say, for each of ${SITE_PAGES.join(", ")}, true or false.`;

// The pages a save shows: a record of booleans (explore, polls and people
// required; agents may be left out, meaning off), or, for leniency, a list of
// the pages shown.
function shownPages(pages: unknown): SitePage[] {
  if (Array.isArray(pages)) {
    if (pages.some((p) => !isPage(p))) throw new ActionError(PAGES_RECORD);
    if (new Set(pages).size !== pages.length) throw new ActionError("pages lists a page twice.");
    return pages;
  }
  if (pages === null || typeof pages !== "object") throw new ActionError(PAGES_RECORD);
  const record = pages as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !isPage(k));
  if (unknown.length > 0) throw new ActionError(`Unknown page ${unknown.join(", ")}: ${PAGES_RECORD}`);
  for (const p of SITE_PAGES) {
    const v = record[p];
    if (typeof v !== "boolean" && !(p === "agents" && v === undefined)) throw new ActionError(PAGES_RECORD);
  }
  return SITE_PAGES.filter((p) => record[p] === true);
}

// A POST /c/<id>/site body, { pages, accent, about }, checked strictly: all
// three, nothing else. Answers it as it's logged (a full replacement), with
// the Agents choice from `prev` (the site it replaces) kept when it can't be
// chosen now (see the top).
export function parseSite(body: unknown, hasCommons: boolean, prev: StoredSite = DEFAULT_SITE): StoredSite {
  const { pages: given, accent, about, ...rest } = (body ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) throw new ActionError(`Unknown field ${unknown.join(", ")}: a site has pages, accent and about.`);
  const pages = shownPages(given);
  if (pages.includes("agents") && !hasCommons) {
    throw new ActionError("This community has no agent commons, so it can't show an Agents page.", "no commons");
  }
  if (!isAccent(accent)) throw new ActionError(`Choose an accent colour: ${ACCENTS.join(", ")}.`);
  if (typeof about !== "string") throw new ActionError("about must be text.");
  // Counted as it's kept: NFC can make text longer (a few precomposed
  // letters become two characters), so the count is said.
  const cleaned = cleanAbout(about);
  if (cleaned.length > MAX_ABOUT) {
    const n = (k: number) => k.toLocaleString("en-US");
    throw new ActionError(`The About can be at most ${n(MAX_ABOUT)} characters; this one has ${n(cleaned.length)}.`);
  }
  const kept = !hasCommons && typeof prev.pages.agents === "boolean" ? { agents: prev.pages.agents } : {};
  return {
    pages: { ...Object.fromEntries(available(hasCommons).map((p) => [p, pages.includes(p)])), ...kept },
    accent,
    about: cleaned,
  };
}

// (a page left out counts as on, as siteView shows it)
export function sameSite(a: StoredSite, b: StoredSite) {
  return (
    a.accent === b.accent &&
    a.about === b.about &&
    SITE_PAGES.every((p) => (a.pages[p] !== false) === (b.pages[p] !== false))
  );
}

// A logged site's pages, read warily (store.ts): only known pages with a
// boolean; anything else (a newer version's) is left out, so it's on.
export function readPages(raw: unknown): Partial<SitePages> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  return Object.fromEntries(SITE_PAGES.filter((p) => typeof record[p] === "boolean").map((p) => [p, record[p]]));
}
