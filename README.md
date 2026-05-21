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
  1. **Static path (fast):** fetches `/en/events` and the homepage without a browser, tries to parse the embedded `__NEXT_DATA__` JSON that Next.js injects, and falls back to anchor-tag scanning. If at least one valid upcoming event is found, this path is used.
  2. **Browser fallback (robust):** if the static path yields zero upcoming events (e.g. because the page is fully client-rendered or gated), a headless Chromium browser is launched via [Playwright](https://playwright.dev/). It renders the events page with JavaScript, then navigates to each event page to extract details.

**To run locally:**

- Clone this repo, run `npm install`, then `npx playwright install --with-deps chromium`, then `npm start`, and out spits your `GLORY.ics` file with all upcoming GLORY events

## Caveats

- The static path relies on `glorykickboxing.com` embedding event data in `__NEXT_DATA__` or in plain HTML anchor tags. If the site changes its framework or data structure, the scraper may fall back to the browser path automatically.
- The browser fallback path uses heuristic DOM selectors. If the site significantly redesigns its layout, the selectors may need updating.
- Fight card details are only listed when announced on the official GLORY event page.
- Forked from [clarencechaan/ufc-cal](https://github.com/clarencechaan/ufc-cal).
