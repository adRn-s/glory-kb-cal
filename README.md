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
- The scraper parses the embedded `__NEXT_DATA__` JSON that Next.js injects into each page, and falls back to HTML parsing if needed

**To run locally:**

- Clone this repo, run the commands `npm install`, then `npm start`, and out spits your `GLORY.ics` file with all upcoming GLORY events

## Caveats

- The scraper relies on `glorykickboxing.com` using Next.js and embedding event data in `__NEXT_DATA__`. If the site changes its framework or data structure, the scraper may need updating.
- Fight card details are only listed when announced on the official GLORY event page.
- Forked from [clarencechaan/ufc-cal](https://github.com/clarencechaan/ufc-cal).
