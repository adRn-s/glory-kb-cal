import { parse } from "node-html-parser";
import { decode } from "html-entities";

const BASE_URL = "https://glorykickboxing.com";
const EVENTS_PAGE_URL = new URL(`${BASE_URL}/en/events`);

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
 * Returns an array of upcoming GLORY event URLs scraped from the events
 * listing page.
 */
async function getEventURLs(): Promise<URL[]> {
  try {
    const response = await fetch(EVENTS_PAGE_URL);
    const text = await response.text();

    // Try __NEXT_DATA__ first (Next.js SSR)
    const nextData = extractNextData(text);
    if (nextData) {
      const urls = extractEventURLsFromNextData(nextData);
      if (urls.length) {
        console.log("\nEvent URLs found (via __NEXT_DATA__):");
        console.log(urls.map((u) => u.href));
        return urls;
      }
    }

    // Fall back to HTML link extraction
    const root = parse(text);
    const anchors = root.querySelectorAll("a[href]");
    const urls = anchors
      .map((a) => {
        const href = a.getAttribute("href") ?? "";
        // Match paths like /en/events/glory-100 or /events/glory-100
        if (/^\/(en\/)?events\/[a-z0-9-]+$/.test(href)) {
          return new URL(`${BASE_URL}${href}`);
        }
        return null;
      })
      .filter((u): u is URL => u !== null);

    // Deduplicate
    const seen = new Set<string>();
    const unique = urls.filter((u) => {
      if (seen.has(u.href)) return false;
      seen.add(u.href);
      return true;
    });

    console.log("\nEvent URLs found (via HTML):");
    console.log(unique.map((u) => u.href));
    return unique;
  } catch (error) {
    console.error(error);
    throw new Error("Failed to retrieve event URLs");
  }
}

/**
 * Attempts to pull event slugs / URLs out of a __NEXT_DATA__ blob.
 */
function extractEventURLsFromNextData(data: Record<string, unknown>): URL[] {
  // Try several candidate paths for the events list
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

/**
 * Returns the fight card details of a GLORY event given its URL.
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

/**
 * Returns an array of details of upcoming GLORY events.
 */
async function getAllDetailedEvents(): Promise<GloryEvent[]> {
  try {
    const eventURLs = await getEventURLs();

    const detailedEvents = await Promise.all(
      eventURLs.map(getDetailsFromEventURL)
    );
    return detailedEvents;
  } catch (error) {
    console.error(error);
    throw new Error("Failed to retrieve all events");
  }
}

export { getAllDetailedEvents };

