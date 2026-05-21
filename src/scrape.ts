import { parse } from "node-html-parser";
import { decode } from "html-entities";
import type { Page } from "playwright";

const BASE_URL = "https://glorykickboxing.com";
const EVENTS_PAGE_URL = new URL(`${BASE_URL}/en/events`);
const HOME_URL = new URL(BASE_URL);
const NEWS_PAGE_URLS = [
  new URL(`${BASE_URL}/news`),
  new URL(`${BASE_URL}/en/news`),
  HOME_URL,
];
const EVENT_PATH_PATTERN = /^\/(en\/)?events\/[a-z0-9-]+$/;
const NEWS_PATH_PATTERN = /^\/(en\/)?news\/[a-z0-9-]+$/;
const MAX_PLAUSIBLE_FUTURE_EVENT_MS = 1000 * 60 * 60 * 24 * 366 * 5;
const MONTH_NAME_PATTERN =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY_PATTERN =
  "(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const OPTIONAL_TIME_PATTERN =
  "(?:\\s*(?:at\\s+)?\\d{1,2}(?::\\d{2})?(?:\\s*[AP]\\.?M\\.?)?(?:\\s*(?:GMT|UTC|CET|CEST|EST|EDT|PST|PDT))?)?";
const ISO_DATE_PATTERN =
  /\b20\d{2}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gi;
const HUMAN_DATE_WITH_YEAR_PATTERN = new RegExp(
  `\\b(?:${WEEKDAY_PATTERN},?\\s+)?${MONTH_NAME_PATTERN}\\s+\\d{1,2}(?:,\\s*|\\s+)20\\d{2}${OPTIONAL_TIME_PATTERN}\\b`,
  "gi"
);
const HUMAN_DATE_WITHOUT_YEAR_PATTERN = new RegExp(
  `\\b(?:${WEEKDAY_PATTERN},?\\s+)?${MONTH_NAME_PATTERN}\\s+\\d{1,2}(?!,?\\s*20\\d{2})${OPTIONAL_TIME_PATTERN}\\b`,
  "gi"
);

type DateCandidate = {
  raw: string;
  source: string;
  timestampMs: number;
  priority: number;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to extract the embedded __NEXT_DATA__ JSON from a Next.js page.
 */
function extractNextData(html: string): Record<string, unknown> | null {
  const root = parse(html);
  const el = root.querySelector("#__NEXT_DATA__");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns true when the event's unix-timestamp date is in the future.
 */
function isUpcoming(event: GloryEvent, context?: string): boolean {
  const timestampMs = getEventTimestampMs(event);
  const now = Date.now();
  const upcoming = timestampMs !== null && timestampMs > now;

  if (context) {
    const parsedDetails =
      timestampMs === null
        ? `raw="${event.date}" (unparseable)`
        : `raw="${event.date}" -> ${formatTimestamp(timestampMs)} (unix ${Math.floor(
            timestampMs / 1000
          )})`;
    console.log(
      `${context}: classified ${event.url.href} as ${
        upcoming ? "upcoming" : "past"
      } using ${parsedDetails}; now=${formatTimestamp(now)}`
    );
  }

  return upcoming;
}

function getEventTimestampMs(event: GloryEvent): number | null {
  return parseTimestampValue(event.date);
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isPlausibleTimestamp(timestampMs: number): boolean {
  return (
    Number.isFinite(timestampMs) &&
    timestampMs >= Date.UTC(2020, 0, 1) &&
    timestampMs <= Date.now() + MAX_PLAUSIBLE_FUTURE_EVENT_MS
  );
}

function parseTimestampValue(value: string | number): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const timestampMs = Math.abs(value) >= 1e12 ? value : value * 1000;
    return isPlausibleTimestamp(timestampMs) ? timestampMs : null;
  }

  const raw = normalizeText(value);
  if (!raw) return null;

  if (/^\d{13}$/.test(raw)) {
    const timestampMs = Number(raw);
    return isPlausibleTimestamp(timestampMs) ? timestampMs : null;
  }

  if (/^\d{10}$/.test(raw)) {
    const timestampMs = Number(raw) * 1000;
    return isPlausibleTimestamp(timestampMs) ? timestampMs : null;
  }

  const parsed = Date.parse(raw);
  return !isNaN(parsed) && isPlausibleTimestamp(parsed) ? parsed : null;
}

function getDateCandidatePriority(basePriority: number, raw: string): number {
  let priority = basePriority;
  if (/\b\d{1,2}:\d{2}\b/.test(raw)) priority += 20;
  if (/\b(?:[AP]\.?M\.?)\b/i.test(raw)) priority += 10;
  if (/\b(?:GMT|UTC|CET|CEST|EST|EDT|PST|PDT)\b/i.test(raw)) priority += 10;
  if (/20\d{2}/.test(raw)) priority += 5;
  return priority;
}

function pushDateCandidate(
  candidates: DateCandidate[],
  raw: string | number,
  source: string,
  basePriority: number
) {
  const normalized = normalizeText(String(raw));
  if (!normalized) return;

  const timestampMs = parseTimestampValue(normalized);
  if (timestampMs === null) return;

  candidates.push({
    raw: normalized,
    source,
    timestampMs,
    priority: getDateCandidatePriority(basePriority, normalized),
  });
}

function addInferredYear(raw: string, year: number): string {
  if (/20\d{2}/.test(raw)) return raw;

  const monthDayMatch = raw.match(
    new RegExp(`(${MONTH_NAME_PATTERN}\\s+\\d{1,2})`, "i")
  );
  if (!monthDayMatch?.[1]) return raw;

  return raw.replace(monthDayMatch[1], `${monthDayMatch[1]}, ${year}`);
}

function dedupeDateCandidates(candidates: DateCandidate[]): DateCandidate[] {
  const byKey = new Map<string, DateCandidate>();

  for (const candidate of candidates) {
    const key = `${candidate.source}|${candidate.raw}|${candidate.timestampMs}`;
    const existing = byKey.get(key);
    if (!existing || candidate.priority > existing.priority) {
      byKey.set(key, candidate);
    }
  }

  return [...byKey.values()];
}

function extractDateCandidatesFromText(
  text: string,
  source: string,
  basePriority: number,
  inferMissingYear = true
): DateCandidate[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const candidates: DateCandidate[] = [];

  for (const match of normalized.matchAll(ISO_DATE_PATTERN)) {
    if (match[0]) pushDateCandidate(candidates, match[0], source, basePriority);
  }

  for (const match of normalized.matchAll(HUMAN_DATE_WITH_YEAR_PATTERN)) {
    if (match[0]) pushDateCandidate(candidates, match[0], source, basePriority);
  }

  if (inferMissingYear && !/20\d{2}/.test(normalized)) {
    const currentYear = new Date().getUTCFullYear();

    for (const match of normalized.matchAll(HUMAN_DATE_WITHOUT_YEAR_PATTERN)) {
      const raw = match[0];
      if (!raw || /20\d{2}/.test(raw)) continue;
      pushDateCandidate(
        candidates,
        addInferredYear(raw, currentYear),
        `${source} (current year)`,
        basePriority - 5
      );
      pushDateCandidate(
        candidates,
        addInferredYear(raw, currentYear + 1),
        `${source} (next year)`,
        basePriority - 10
      );
    }
  }

  return dedupeDateCandidates(candidates);
}

function extractDateCandidatesFromHTML(html: string): DateCandidate[] {
  const root = parse(html);
  const candidates: DateCandidate[] = [];

  for (const el of root.querySelectorAll("time")) {
    const datetime = el.getAttribute("datetime");
    if (datetime) {
      pushDateCandidate(candidates, datetime, "time[datetime]", 130);
    }

    const dataTimestamp = el.getAttribute("data-timestamp");
    if (dataTimestamp) {
      pushDateCandidate(candidates, dataTimestamp, "time[data-timestamp]", 125);
    }

    const timeText = normalizeText(el.innerText ?? el.textContent ?? "");
    candidates.push(
      ...extractDateCandidatesFromText(timeText, "time element text", 140)
    );
  }

  for (const el of root.querySelectorAll("[data-timestamp]")) {
    const dataTimestamp = el.getAttribute("data-timestamp");
    if (dataTimestamp) {
      pushDateCandidate(candidates, dataTimestamp, "[data-timestamp]", 120);
    }

    const elText = normalizeText(el.innerText ?? el.textContent ?? "");
    candidates.push(
      ...extractDateCandidatesFromText(elText, "[data-timestamp] text", 110)
    );
  }

  const dateTextSelectors = [
    "[class*='date']",
    "[class*='Date']",
    "[class*='time']",
    "[class*='Time']",
    "[class*='schedule']",
    "[class*='Schedule']",
  ];
  const seenText = new Set<string>();
  for (const el of root.querySelectorAll(dateTextSelectors.join(", "))) {
    const text = normalizeText(el.innerText ?? el.textContent ?? "");
    if (!text || seenText.has(text)) continue;
    seenText.add(text);
    candidates.push(
      ...extractDateCandidatesFromText(text, "date/time element text", 100)
    );
  }

  const mainText = normalizeText(
    root.querySelector("main")?.innerText ??
      root.querySelector("article")?.innerText ??
      ""
  );
  candidates.push(...extractDateCandidatesFromText(mainText, "main/article text", 90));

  const metaPublished = root
    .querySelector("meta[property='article:published_time']")
    ?.getAttribute("content");
  if (metaPublished) {
    pushDateCandidate(
      candidates,
      metaPublished,
      "meta[property='article:published_time']",
      10
    );
  }

  for (const match of html.matchAll(ISO_DATE_PATTERN)) {
    if (match[0]) pushDateCandidate(candidates, match[0], "raw HTML ISO", 5);
  }

  return dedupeDateCandidates(candidates);
}

function selectBestDateCandidate(candidates: DateCandidate[]): DateCandidate | null {
  const uniqueCandidates = dedupeDateCandidates(candidates);
  if (!uniqueCandidates.length) return null;

  const now = Date.now();
  const futureCandidates = uniqueCandidates
    .filter((candidate) => candidate.timestampMs > now)
    .sort(
      (a, b) =>
        b.priority - a.priority || a.timestampMs - b.timestampMs
    );

  if (futureCandidates.length) return futureCandidates[0] ?? null;

  const pastCandidates = uniqueCandidates.sort(
    (a, b) => b.priority - a.priority || b.timestampMs - a.timestampMs
  );
  return pastCandidates[0] ?? null;
}

function logDateCandidateSelection(
  context: string,
  url: URL,
  candidates: DateCandidate[],
  selectedCandidate: DateCandidate | null
) {
  const uniqueCandidates = dedupeDateCandidates(candidates).sort(
    (a, b) => b.priority - a.priority || a.timestampMs - b.timestampMs
  );

  if (!uniqueCandidates.length) {
    console.log(`\n${context}: no parsed date candidates for ${url.href}`);
    return;
  }

  console.log(`\n${context}: date candidates for ${url.href}`);
  for (const candidate of uniqueCandidates.slice(0, 8)) {
    console.log(
      `  - "${candidate.raw}" [${candidate.source}] -> ${formatTimestamp(
        candidate.timestampMs
      )} (priority ${candidate.priority})`
    );
  }
  if (uniqueCandidates.length > 8) {
    console.log(`  - ... ${uniqueCandidates.length - 8} more candidate(s) omitted`);
  }

  if (selectedCandidate) {
    console.log(
      `${context}: selected "${selectedCandidate.raw}" [${
        selectedCandidate.source
      }] -> ${formatTimestamp(selectedCandidate.timestampMs)} (unix ${Math.floor(
        selectedCandidate.timestampMs / 1000
      )})`
    );
  }
}

/**
 * Deduplicates a list of URLs by href.
 */
function dedupeURLs(urls: URL[]): URL[] {
  const seen = new Set<string>();
  return urls.filter((u) => {
    if (seen.has(u.href)) return false;
    seen.add(u.href);
    return true;
  });
}

/**
 * Returns event-detail URLs found in an HTML string via anchor-tag scanning.
 */
function extractEventURLsFromHTML(html: string): URL[] {
  return extractMatchingURLsFromHTML(html, EVENT_PATH_PATTERN);
}

/**
 * Returns news/article URLs found in an HTML string via anchor-tag scanning.
 */
function extractNewsURLsFromHTML(html: string): URL[] {
  return extractMatchingURLsFromHTML(html, NEWS_PATH_PATTERN);
}

function extractMatchingURLsFromHTML(html: string, pathPattern: RegExp): URL[] {
  const root = parse(html);
  const anchors = root.querySelectorAll("a[href]");
  return anchors
    .map((a) => {
      const href = a.getAttribute("href") ?? "";
      try {
        const resolved = new URL(href, BASE_URL);
        if (pathPattern.test(resolved.pathname)) return resolved;
      } catch {
        return null;
      }
      return null;
    })
    .filter((u): u is URL => u !== null);
}

/**
 * Attempts to pull event slugs / URLs out of a __NEXT_DATA__ blob.
 */
function extractEventURLsFromNextData(data: Record<string, unknown>): URL[] {
  const pageProps = (
    (data?.props as Record<string, unknown>)?.pageProps as Record<
      string,
      unknown
    >
  );
  if (!pageProps) return [];

  // Try common key names
  const candidates = [
    pageProps?.upcomingEvents,
    pageProps?.events,
    (pageProps?.data as Record<string, unknown>)?.upcomingEvents,
    (pageProps?.data as Record<string, unknown>)?.events,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) {
      const urls: URL[] = [];
      for (const ev of candidate) {
        const slug =
          (ev as Record<string, unknown>)?.slug ??
          (ev as Record<string, unknown>)?.id;
        if (slug) {
          urls.push(new URL(`${BASE_URL}/en/events/${slug}`));
        }
      }
      if (urls.length) return urls;
    }
  }

  return [];
}

function isCanonicalEventURL(url: URL): boolean {
  return EVENT_PATH_PATTERN.test(url.pathname);
}

function normalizeEventName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeEventsPreferCanonical(events: GloryEvent[]): GloryEvent[] {
  const byKey = new Map<string, GloryEvent>();
  for (const event of events) {
    const key = `${normalizeEventName(event.name)}|${event.date}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
      continue;
    }
    if (isCanonicalEventURL(event.url) && !isCanonicalEventURL(existing.url)) {
      byKey.set(key, event);
    }
  }
  return [...byKey.values()];
}

function getFutureTimestampCandidates(text: string): number[] {
  return extractDateCandidatesFromText(text, "article text", 80)
    .map((candidate) => candidate.timestampMs)
    .filter((timestampMs) => timestampMs > Date.now())
    .sort((a, b) => a - b);
}

function extractUpcomingDateFromArticleText(text: string): string {
  const candidates = getFutureTimestampCandidates(text);
  if (!candidates.length) return "";
  const soonest = Math.min(...candidates);
  return String(Math.floor(soonest / 1000));
}

function extractEventNameFromArticle(title: string, text: string): string {
  // Match common announcement formats such as "GLORY 107" or "COLLISION 9".
  const eventMatch = (title + "\n" + text).match(
    /\b(?:GLORY|COLLISION)\s+\d{1,3}(?:[-\s][A-Za-z0-9]+){0,6}\b/i
  );
  if (eventMatch?.[0]) {
    return decode(eventMatch[0].replace(/\s+/g, " ").trim());
  }
  return decode(title.replace(/\s+/g, " ").trim()) || "GLORY Event";
}

function extractLocationFromArticleText(text: string): string {
  // Match venue/location phrases like "at Rotterdam Ahoy" or "in Ahoy Arena".
  const locationMatch = text.match(
    /\b(?:at|in)\s+([A-Z][A-Za-z0-9'.&-]*(?:\s+[A-Z][A-Za-z0-9'.&-]*){0,5}(?:\s+(?:Arena|Stadium|Ahoy|Center|Centre|Hall))?)/m
  );
  return decode(locationMatch?.[1]?.trim() ?? "");
}

// ---------------------------------------------------------------------------
// Static extraction path
// ---------------------------------------------------------------------------

/**
 * Fetches one page and returns any event-detail URLs found in it (static HTML
 * only — no browser).  Returns an empty array on any error.
 */
async function getStaticEventURLsFromPage(pageURL: URL): Promise<URL[]> {
  try {
    const response = await fetch(pageURL);
    const text = await response.text();

    // Prefer __NEXT_DATA__ (richer data, fewer false positives)
    const nextData = extractNextData(text);
    if (nextData) {
      const urls = extractEventURLsFromNextData(nextData);
      if (urls.length) return urls;
    }

    // Fall back to scanning anchor tags
    return extractEventURLsFromHTML(text);
  } catch {
    return [];
  }
}

/**
 * Collects event URLs from static `/en/events` only.
 */
async function getStaticEventURLs(): Promise<URL[]> {
  const urls = dedupeURLs(await getStaticEventURLsFromPage(EVENTS_PAGE_URL));
  if (urls.length) {
    console.log("\nEvent URLs found (via static /en/events):");
    console.log(urls.map((u) => u.href));
  }
  return urls;
}

/**
 * Returns the fight card details of a GLORY event given its URL (static
 * fetch only).
 */
async function getDetailsFromEventURL(url: URL): Promise<GloryEvent> {
  console.log(`\nGetting details from url: ${url.href}`);
  try {
    const response = await fetch(url);
    const text = await response.text();

    let htmlEvent: GloryEvent | null = null;
    try {
      htmlEvent = extractEventFromHTML(text, url);
    } catch (error) {
      console.error(`HTML extraction failed for ${url.href}:`, error);
    }

    const nextData = extractNextData(text);
    let nextDataEvent: GloryEvent | null = null;
    if (nextData) {
      nextDataEvent = extractEventFromNextData(nextData, url);
    }

    const event = choosePreferredEvent(url, htmlEvent, nextDataEvent);
    if (event) {
      return event;
    }

    throw new Error(`Failed to retrieve event details (no date) for: ${url.href}`);
  } catch (error) {
    console.error(error);
    throw new Error(`Failed to retrieve event: ${url.href}\n${error}`);
  }
}

async function getUpcomingEventsFromURLs(urls: URL[]): Promise<GloryEvent[]> {
  const settled = await Promise.allSettled(urls.map(getDetailsFromEventURL));
  return settled
    .filter(
      (result): result is PromiseFulfilledResult<GloryEvent> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value)
    .filter((event) => isUpcoming(event, "Static extraction"));
}

async function getArticleEventFromStaticPage(articleURL: URL): Promise<GloryEvent | null> {
  try {
    console.log(`\nNews fallback: reading article ${articleURL.href}`);
    const response = await fetch(articleURL);
    const html = await response.text();
    const canonicalEventURLs = dedupeURLs(extractEventURLsFromHTML(html));

    for (const canonicalURL of canonicalEventURLs) {
      try {
        const event = await getDetailsFromEventURL(canonicalURL);
        if (isUpcoming(event)) return event;
      } catch (error) {
        console.error(
          `News fallback: failed canonical event extraction for ${canonicalURL.href}:`,
          error
        );
      }
    }

    const root = parse(html);
    const title =
      root.querySelector("h1")?.innerText?.trim() ??
      root.querySelector("title")?.textContent?.trim() ??
      "";
    const bodyText =
      root.querySelector("main")?.innerText ??
      root.querySelector("article")?.innerText ??
      root.innerText ??
      "";

    const date = extractUpcomingDateFromArticleText(`${title}\n${bodyText}`);
    if (!date) return null;

    return {
      name: extractEventNameFromArticle(title, bodyText),
      // Prefer canonical event URLs when present, even if details were derived
      // from article content.
      url: canonicalEventURLs[0] ?? articleURL,
      date,
      location: extractLocationFromArticleText(bodyText),
      fights: [],
    };
  } catch (error) {
    console.error(`News fallback: failed to parse article ${articleURL.href}:`, error);
    return null;
  }
}

async function getStaticNewsArticleURLs(): Promise<URL[]> {
  const urlsByPage = await Promise.all(
    NEWS_PAGE_URLS.map(async (pageURL) => {
      try {
        const response = await fetch(pageURL);
        const html = await response.text();
        return extractNewsURLsFromHTML(html);
      } catch {
        return [];
      }
    })
  );
  return dedupeURLs(urlsByPage.flat());
}

async function getUpcomingEventsFromStaticNewsPages(): Promise<GloryEvent[]> {
  const articleURLs = await getStaticNewsArticleURLs();
  if (!articleURLs.length) {
    console.log("\nStatic news/pages fallback: no news article URLs discovered.");
    return [];
  }

  console.log("\nNews/article URLs found (static fallback):");
  console.log(articleURLs.map((u) => u.href));

  const settled = await Promise.allSettled(
    articleURLs.map(getArticleEventFromStaticPage)
  );
  const events = settled
    .filter(
      (result): result is PromiseFulfilledResult<GloryEvent | null> =>
        result.status === "fulfilled"
    )
    .map((result) => result.value)
    .filter((event): event is GloryEvent => event !== null)
    .filter((event) => isUpcoming(event, "Static news fallback"));

  if (!events.length) {
    console.log(
      "\nStatic news/pages fallback: articles found, but no upcoming events could be extracted."
    );
  }

  return dedupeEventsPreferCanonical(events);
}

/**
 * Extracts event details from a __NEXT_DATA__ JSON blob on an event detail
 * page.
 */
function extractEventFromNextData(
  data: Record<string, unknown>,
  url: URL
): GloryEvent | null {
  const pageProps = (
    (data?.props as Record<string, unknown>)?.pageProps as Record<
      string,
      unknown
    >
  );
  if (!pageProps) return null;

  // Try common key names for the event object
  const raw =
    pageProps?.event ??
    pageProps?.data ??
    (pageProps?.data as Record<string, unknown>)?.event ??
    pageProps;

  if (!raw || typeof raw !== "object") return null;
  const ev = raw as Record<string, unknown>;

  // Name
  const name = decode(
    String(ev?.name ?? ev?.title ?? ev?.eventName ?? "")
  ).trim();
  if (!name) return null;

  const dateCandidates: DateCandidate[] = [];
  for (const [field, rawDate] of Object.entries({
    date: ev?.date,
    startDate: ev?.startDate,
    startTime: ev?.startTime,
    datetime: ev?.datetime,
  })) {
    if (typeof rawDate === "string" || typeof rawDate === "number") {
      pushDateCandidate(dateCandidates, rawDate, `__NEXT_DATA__.${field}`, 60);
    }
  }
  const selectedDate = selectBestDateCandidate(dateCandidates);
  logDateCandidateSelection("__NEXT_DATA__", url, dateCandidates, selectedDate);
  if (!selectedDate) return null;

  // Location
  const venue = ev?.venue as Record<string, unknown> | undefined;
  const locationParts = [
    venue?.name ?? ev?.venueName,
    venue?.city ?? ev?.city,
    venue?.country ?? ev?.country,
  ]
    .filter(Boolean)
    .map((s) => decode(String(s)).trim());
  const location = locationParts.join(", ");

  // Fights
  const fights = extractFightsFromNextDataEvent(ev);

  return {
    name,
    url,
    date: String(Math.floor(selectedDate.timestampMs / 1000)),
    location,
    fights,
  };
}

/**
 * Tries several common shapes for fight card data inside an event JSON object.
 */
function extractFightsFromNextDataEvent(
  ev: Record<string, unknown>
): string[] {
  const candidates = [
    ev?.fightCard,
    ev?.fights,
    ev?.bouts,
    (ev?.data as Record<string, unknown>)?.fights,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || !candidate.length) continue;
    const lines: string[] = [];
    for (const fight of candidate) {
      const f = fight as Record<string, unknown>;
      const fighter1 =
        String(
          (f?.fighter1 as Record<string, unknown>)?.name ??
            (f?.redCorner as Record<string, unknown>)?.name ??
            f?.fighter1Name ??
            ""
        ).trim() || "TBD";
      const fighter2 =
        String(
          (f?.fighter2 as Record<string, unknown>)?.name ??
            (f?.blueCorner as Record<string, unknown>)?.name ??
            f?.fighter2Name ??
            ""
        ).trim() || "TBD";
      const weightClass = String(
        f?.weightClass ?? f?.division ?? f?.weight ?? ""
      ).trim();
      const wcStr = weightClass ? ` @${weightClass}` : "";
      lines.push(decode(`• ${fighter1} vs. ${fighter2}${wcStr}`));
    }
    if (lines.length) return lines;
  }

  return [];
}

/**
 * Falls back to HTML parsing when __NEXT_DATA__ extraction fails.
 */
function extractEventFromHTML(html: string, url: URL): GloryEvent {
  const root = parse(html);

  // Name — try common heading selectors
  const name = decode(
    root.querySelector("h1")?.innerText?.replace(/\s+/g, " ").trim() ??
      root.querySelector("title")?.textContent?.trim() ??
      url.pathname.split("/").pop() ??
      "Unknown Event"
  );

  const dateCandidates = extractDateCandidatesFromHTML(html);
  const selectedDate = selectBestDateCandidate(dateCandidates);
  logDateCandidateSelection("HTML", url, dateCandidates, selectedDate);

  // Location
  const locationEl =
    root.querySelector("[class*='venue']") ??
    root.querySelector("[class*='location']") ??
    root.querySelector("[class*='arena']");
  const location = decode(
    locationEl?.innerText?.replace(/\s+/g, " ").trim() ?? ""
  );

  // Fights — look for fighter name elements
  const fightEls = root.querySelectorAll(
    "[class*='fight'], [class*='bout'], [class*='matchup']"
  );
  const fights: string[] = [];
  for (const el of fightEls) {
    const text = el.innerText?.replace(/\s+/g, " ").trim();
    if (text) fights.push(decode(`• ${text}`));
  }

  if (!selectedDate) {
    throw new Error(
      `Failed to retrieve event details (no date) for: ${url.href}`
    );
  }

  return {
    name,
    url,
    date: String(Math.floor(selectedDate.timestampMs / 1000)),
    location,
    fights,
  };
}

function choosePreferredEvent(
  url: URL,
  htmlEvent: GloryEvent | null,
  nextDataEvent: GloryEvent | null
): GloryEvent | null {
  if (!htmlEvent && !nextDataEvent) return null;

  let preferredDateEvent: GloryEvent | null;
  if (htmlEvent && isUpcoming(htmlEvent)) {
    preferredDateEvent = htmlEvent;
  } else if (nextDataEvent && isUpcoming(nextDataEvent)) {
    preferredDateEvent = nextDataEvent;
  } else {
    preferredDateEvent = htmlEvent ?? nextDataEvent;
  }
  const fallbackEvent =
    preferredDateEvent === htmlEvent ? nextDataEvent : htmlEvent;
  const resolvedPreferredEvent = preferredDateEvent ?? fallbackEvent;
  if (!resolvedPreferredEvent) return null;

  if (
    htmlEvent &&
    nextDataEvent &&
    htmlEvent.date !== nextDataEvent.date
  ) {
    console.log(
      `Date source preference for ${url.href}: keeping ${
        resolvedPreferredEvent === htmlEvent ? "HTML" : "__NEXT_DATA__"
      } date ${resolvedPreferredEvent.date} over ${
        resolvedPreferredEvent === htmlEvent ? "__NEXT_DATA__" : "HTML"
      } date ${fallbackEvent?.date ?? "n/a"}`
    );
  }

  return {
    name:
      resolvedPreferredEvent.name ??
      fallbackEvent?.name ??
      url.pathname.split("/").pop() ??
      "Unknown Event",
    url,
    date: resolvedPreferredEvent.date,
    location: resolvedPreferredEvent.location || fallbackEvent?.location || "",
    fights:
      resolvedPreferredEvent.fights.length
        ? resolvedPreferredEvent.fights
        : fallbackEvent?.fights ?? [],
  };
}

// ---------------------------------------------------------------------------
// Browser-based fallback (Playwright)
// ---------------------------------------------------------------------------

/**
 * Uses a Playwright Page to collect event-detail URLs from the events listing
 * page after JavaScript has rendered the content.
 */
async function getEventURLsViaBrowser(page: Page): Promise<URL[]> {
  console.log("\nBrowser: navigating to events page…");
  await page.goto(EVENTS_PAGE_URL.href, {
    waitUntil: "networkidle",
    timeout: 60000,
  });

  const hrefs: string[] = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]")).map(
      (a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""
    );
  });

  const urls = dedupeURLs(
    hrefs
      .filter((h) => EVENT_PATH_PATTERN.test(h))
      .map((h) => new URL(`${BASE_URL}${h}`))
  );

  console.log("\nEvent URLs found (via browser):");
  console.log(urls.map((u) => u.href));
  return urls;
}

/**
 * Uses a Playwright Page to extract event details for a single event URL.
 * Tries `window.__NEXT_DATA__` (populated after JS execution) first, then
 * falls back to the fully-rendered HTML.
 */
async function getDetailsFromEventURLViaBrowser(
  page: Page,
  url: URL
): Promise<GloryEvent> {
  console.log(`\nBrowser: getting details from ${url.href}`);
  await page.goto(url.href, { waitUntil: "networkidle", timeout: 60000 });

  const html: string = await page.content();
  let htmlEvent: GloryEvent | null = null;
  try {
    htmlEvent = extractEventFromHTML(html, url);
  } catch (error) {
    console.error(`Browser HTML extraction failed for ${url.href}:`, error);
  }

  // Try __NEXT_DATA__ injected by Next.js after hydration
  const nextDataText: string | null = await page.evaluate(() => {
    const el = document.querySelector("#__NEXT_DATA__");
    return el?.textContent ?? null;
  });

  let nextDataEvent: GloryEvent | null = null;
  if (nextDataText) {
    try {
      const nextData = JSON.parse(nextDataText) as Record<string, unknown>;
      nextDataEvent = extractEventFromNextData(nextData, url);
    } catch {
      // ignore parse errors, fall through to HTML
    }
  }

  const event = choosePreferredEvent(url, htmlEvent, nextDataEvent);
  if (event) {
    return event;
  }

  throw new Error(`Failed to retrieve event details (no date) for: ${url.href}`);
}

/**
 * Launches a single Playwright Chromium browser, discovers event URLs from
 * the rendered events page, then fetches details for each event.  All pages
 * are visited within the same browser session for efficiency.
 */
async function getAllDetailedEventsViaBrowser(): Promise<GloryEvent[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // 1. Discover event URLs
    const urls = await getEventURLsViaBrowser(page);
    if (!urls.length) {
      throw new Error(
        "Browser fallback: events page loaded but no event URLs were found in the rendered DOM"
      );
    }

    // 2. Extract details for each URL (sequential to avoid overloading the site)
    const events: GloryEvent[] = [];
    for (const url of urls) {
      try {
        const event = await getDetailsFromEventURLViaBrowser(page, url);
        if (isUpcoming(event, "Browser extraction")) {
          events.push(event);
        } else {
          console.log(`  Skipping past event: ${url.href}`);
        }
      } catch (err) {
        console.error(`Browser: failed to get details for ${url.href}:`, err);
      }
    }

    if (!events.length) {
      throw new Error(
        "Browser fallback: event URLs found but no upcoming event details could be extracted"
      );
    }
    return events;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Public API — hybrid strategy
// ---------------------------------------------------------------------------

/**
 * Returns details of upcoming GLORY events.
 *
 * Strategy (Option C — hybrid):
 * 1. **Static `/en/events`**: scrape canonical event pages without browser rendering.
 * 2. **Static news/pages fallback**: scrape GLORY news articles and page links for
 *    future event announcements, preferring canonical event URLs when available.
 * 3. **Browser fallback (last resort)**: render pages via Playwright only after
 *    static strategies produce zero usable upcoming events.
 */
async function getAllDetailedEvents(): Promise<GloryEvent[]> {
  const diagnostics: string[] = [];

  console.log("\n[Strategy 1/3] Static `/en/events`");
  const staticURLs = await getStaticEventURLs();
  if (!staticURLs.length) {
    diagnostics.push("Static `/en/events`: no event URLs found.");
  } else {
    const events = await getUpcomingEventsFromURLs(staticURLs);
    if (events.length) {
      console.log(
        `\nStatic /en/events: found ${events.length} upcoming event(s).`
      );
      return dedupeEventsPreferCanonical(events);
    }
    diagnostics.push(
      "Static `/en/events`: event URLs found but all extracted events were past or invalid."
    );
  }

  console.log("\n[Strategy 2/3] Static news/pages fallback");
  const newsEvents = await getUpcomingEventsFromStaticNewsPages();
  if (newsEvents.length) {
    console.log(
      `\nStatic news/pages fallback: found ${newsEvents.length} upcoming event(s).`
    );
    return newsEvents;
  }
  diagnostics.push(
    "Static news/pages fallback: no usable upcoming events extracted from articles/pages."
  );

  console.log("\n[Strategy 3/3] Browser fallback (Playwright)");
  try {
    const browserEvents = await getAllDetailedEventsViaBrowser();
    return dedupeEventsPreferCanonical(browserEvents);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown browser fallback error";
    diagnostics.push(`Browser fallback failed: ${message}`);
  }

  throw new Error(
    `Failed to retrieve upcoming GLORY events. Strategy diagnostics:\n- ${diagnostics.join("\n- ")}`
  );
}

export { getAllDetailedEvents };
