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
function isUpcoming(event: GloryEvent): boolean {
  const ts = parseInt(event.date, 10);
  if (isNaN(ts)) return false;
  return ts * 1000 > Date.now();
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
  const now = Date.now();
  const results: number[] = [];

  const isoMatches =
    text.match(/\b20\d{2}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?Z?)?\b/g) ??
    [];
  for (const raw of isoMatches) {
    const parsed = Date.parse(raw);
    if (!isNaN(parsed) && parsed > now) results.push(parsed);
  }

  const monthDayYear =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*20\d{2})?\b/gi;
  const nowDate = new Date();
  let match: RegExpExecArray | null;
  while ((match = monthDayYear.exec(text)) !== null) {
    const raw = match[0];
    const hasYear = /20\d{2}/.test(raw);
    if (hasYear) {
      const parsed = Date.parse(raw);
      if (!isNaN(parsed) && parsed > now) results.push(parsed);
      continue;
    }

    const thisYearParsed = Date.parse(`${raw}, ${nowDate.getUTCFullYear()}`);
    if (!isNaN(thisYearParsed) && thisYearParsed > now) {
      results.push(thisYearParsed);
      continue;
    }
    const nextYearParsed = Date.parse(
      `${raw}, ${nowDate.getUTCFullYear() + 1}`
    );
    if (!isNaN(nextYearParsed) && nextYearParsed > now) {
      results.push(nextYearParsed);
    }
  }

  return results;
}

function extractUpcomingDateFromArticleText(text: string): string {
  const candidates = getFutureTimestampCandidates(text);
  if (!candidates.length) return "";
  const soonest = Math.min(...candidates);
  return String(Math.floor(soonest / 1000));
}

function extractEventNameFromArticle(title: string, text: string): string {
  const eventMatch = (title + "\n" + text).match(
    /\b(?:GLORY|COLLISION)\s+\d{1,3}(?:[-\s][A-Za-z0-9]+){0,6}\b/i
  );
  if (eventMatch?.[0]) {
    return decode(eventMatch[0].replace(/\s+/g, " ").trim());
  }
  return decode(title.replace(/\s+/g, " ").trim()) || "GLORY Event";
}

function extractLocationFromArticleText(text: string): string {
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

    // Try __NEXT_DATA__ first
    const nextData = extractNextData(text);
    if (nextData) {
      const event = extractEventFromNextData(nextData, url);
      if (event) return event;
    }

    // Fall back to HTML parsing
    return extractEventFromHTML(text, url);
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
    .filter(isUpcoming);
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
    .filter(isUpcoming);

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

  // Date — accept ISO string, unix timestamp string, or number
  const rawDate = ev?.date ?? ev?.startDate ?? ev?.startTime ?? ev?.datetime;
  let date = "";
  if (typeof rawDate === "number") {
    date = String(rawDate);
  } else if (typeof rawDate === "string") {
    // If it looks like an ISO date, convert to unix timestamp
    const parsed = Date.parse(rawDate);
    if (!isNaN(parsed)) {
      date = String(Math.floor(parsed / 1000));
    } else {
      date = rawDate;
    }
  }
  if (!date) return null;

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

  return { name, url, date, location, fights };
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

  // Date — look for time elements or data-timestamp attributes
  const timeEl =
    root.querySelector("time[datetime]") ??
    root.querySelector("[data-timestamp]");
  let date = "";
  if (timeEl) {
    const dt =
      timeEl.getAttribute("datetime") ??
      timeEl.getAttribute("data-timestamp") ??
      "";
    const parsed = Date.parse(dt);
    if (!isNaN(parsed)) {
      date = String(Math.floor(parsed / 1000));
    } else {
      date = dt;
    }
  }
  if (!date) {
    // Last resort: scrape page for ISO date patterns
    const match = html.match(
      /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/
    );
    if (match?.[1]) {
      const parsed = Date.parse(match[1]);
      if (!isNaN(parsed)) date = String(Math.floor(parsed / 1000));
    }
  }

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

  if (!date) {
    throw new Error(
      `Failed to retrieve event details (no date) for: ${url.href}`
    );
  }

  return { name, url, date, location, fights };
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

  // Try __NEXT_DATA__ injected by Next.js after hydration
  const nextDataText: string | null = await page.evaluate(() => {
    const el = document.querySelector("#__NEXT_DATA__");
    return el?.textContent ?? null;
  });

  if (nextDataText) {
    try {
      const nextData = JSON.parse(nextDataText) as Record<string, unknown>;
      const event = extractEventFromNextData(nextData, url);
      if (event) return event;
    } catch {
      // ignore parse errors, fall through to HTML
    }
  }

  // Fall back to the fully-rendered HTML
  const html: string = await page.content();
  return extractEventFromHTML(html, url);
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
        "Browser fallback: no event URLs found on the events page"
      );
    }

    // 2. Extract details for each URL (sequential to avoid overloading the site)
    const events: GloryEvent[] = [];
    for (const url of urls) {
      try {
        const event = await getDetailsFromEventURLViaBrowser(page, url);
        if (isUpcoming(event)) {
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
