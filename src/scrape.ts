import { parse } from "node-html-parser";
import { decode } from "html-entities";
import type { Page } from "playwright";

const BASE_URL = "https://glorykickboxing.com";
const EVENTS_PAGE_URL = new URL(`${BASE_URL}/en/events`);
const HOME_URL = new URL(BASE_URL);

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
  const root = parse(html);
  const anchors = root.querySelectorAll("a[href]");
  return anchors
    .map((a) => {
      const href = a.getAttribute("href") ?? "";
      // Match paths like /en/events/glory-100 or /events/glory-100
      if (/^\/(en\/)?events\/[a-z0-9-]+$/.test(href)) {
        return new URL(`${BASE_URL}${href}`);
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
 * Collects upcoming event URLs using purely static HTTP fetches.
 * Tries the events listing page first, then the homepage as a secondary
 * source.  Returns a deduplicated list (may be empty if both fail).
 */
async function getStaticEventURLs(): Promise<URL[]> {
  const [eventsPageURLs, homeURLs] = await Promise.all([
    getStaticEventURLsFromPage(EVENTS_PAGE_URL),
    getStaticEventURLsFromPage(HOME_URL),
  ]);

  const combined = dedupeURLs([...eventsPageURLs, ...homeURLs]);
  if (combined.length) {
    console.log("\nEvent URLs found (via static HTML):");
    console.log(combined.map((u) => u.href));
  }
  return combined;
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

  const pattern = /^\/(en\/)?events\/[a-z0-9-]+$/;
  const urls = dedupeURLs(
    hrefs
      .filter((h) => pattern.test(h))
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
 * 1. **Static path**: fetch `/en/events` and the homepage without a browser,
 *    try `__NEXT_DATA__` JSON first then anchor-tag scanning.  If at least
 *    one valid upcoming event is found this way, return immediately.
 * 2. **Browser fallback**: if static extraction yields zero usable upcoming
 *    events, launch a headless Chromium browser via Playwright, render the
 *    events page with JavaScript, and extract event URLs and details from the
 *    live DOM.
 */
async function getAllDetailedEvents(): Promise<GloryEvent[]> {
  // --- Static path ---
  const staticURLs = await getStaticEventURLs();

  if (staticURLs.length > 0) {
    const settled = await Promise.allSettled(
      staticURLs.map(getDetailsFromEventURL)
    );
    const events: GloryEvent[] = settled
      .filter(
        (r): r is PromiseFulfilledResult<GloryEvent> =>
          r.status === "fulfilled"
      )
      .map((r) => r.value)
      .filter(isUpcoming);

    if (events.length > 0) {
      console.log(`\nStatic path: found ${events.length} upcoming event(s).`);
      return events;
    }
    console.log(
      "\nStatic path: URLs found but no upcoming events extracted. Falling back to browser…"
    );
  } else {
    console.log(
      "\nStatic path: no event URLs found. Falling back to browser…"
    );
  }

  // --- Browser fallback ---
  return getAllDetailedEventsViaBrowser();
}

export { getAllDetailedEvents };

