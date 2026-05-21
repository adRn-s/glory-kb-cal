# glory-kb-cal

[Subscribe to this calendar to keep track of GLORY Kickboxing events](https://adRn-s.github.io/glory-kb-cal/)

Or subscribe manually from your calendar app using this URL:

`webcal://raw.githubusercontent.com/adRn-s/glory-kb-cal/ics/GLORY.ics`

## What is this?

A calendar feed that automatically adds GLORY Kickboxing events to your calendar app of choice as each event gets announced and updated over time.

This feed is not affiliated with GLORY Kickboxing.

## Why is it useful?

- **Always kept up to date**: events are added and card details are updated within a day of any changes posted on the GLORY website
- **Event times are accurate**: event times reflect your local timezone
- **Card details**: without leaving your calendar, you can see every (announced) fight on the card

## Info for nerds

**How does it work?**

- Using a GitHub Action, the GLORY Kickboxing website (`glorykickboxing.com`) is scraped several times each day, and the `GLORY.ics` file (from the URL above) is updated with any new information found
- The scraper uses a **hybrid strategy**:
  1. **Static `/en/events` (fast):** fetches the canonical events page without a browser, tries to parse embedded `__NEXT_DATA__`, and falls back to anchor-tag scanning.
  2. **Static news/pages fallback:** if `/en/events` yields no usable upcoming events, recent GLORY news/article pages are scanned for future event announcements and canonical event links.
  3. **Browser fallback (last resort):** only after both static strategies fail, a headless Chromium browser is launched via [Playwright](https://playwright.dev/). It renders the events page with JavaScript, then navigates to each event page to extract details.

- Event dates are chosen from the strongest parsed candidate on each page, preferring visible page date/time text and reliable `time`/timestamp attributes over brittle metadata.

**To run locally:**

- Clone this repo, run `npm install`, then `npx playwright install --with-deps chromium`, then `npm start`, and out spits your `GLORY.ics` file with all upcoming GLORY events

## Caveats

- The static path relies on `glorykickboxing.com` embedding event data in `__NEXT_DATA__` or in plain HTML anchor tags. If the site changes its framework or data structure, the scraper may fall back to the browser path automatically.
- The browser fallback path uses heuristic DOM selectors. If the site significantly redesigns its layout, the selectors may need updating.
- Fight card details are only listed when announced on the official GLORY event page.
- Forked from [clarencechaan/ufc-cal](https://github.com/clarencechaan/ufc-cal).
