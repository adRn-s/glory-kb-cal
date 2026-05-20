import { getAllDetailedEvents } from "./scrape.js";
import * as fs from "fs";
import { createEvents, type DateArray, type EventAttributes } from "ics";

/**
 * Extracts the details of upcoming GLORY Kickboxing events, then creates an
 * ICS file named "GLORY.ics" in the current directory containing these events.
 */
async function createICS() {
  try {
    const events = await getAllDetailedEvents();
    if (!events?.length) throw new Error("No events retrieved");

    // Convert event details into the format required by the ICS generator
    const formattedEvents = events.map((event) =>
      formatEventForCalendar(event)
    );

    console.log("\nDetailed events:");
    console.log(formattedEvents);

    // Create GLORY.ics
    const eventsData = createEvents(formattedEvents).value;
    if (eventsData) fs.writeFileSync("GLORY.ics", eventsData);
  } catch (error) {
    console.error(error);
  }
}

function formatEventForCalendar(event: GloryEvent): EventAttributes {
  const date = new Date(parseInt(event.date) * 1000);
  const start: DateArray = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  ];
  const duration: { hours: number } = { hours: 3 };
  const title = event.name;
  let description = "";

  // List all announced fights
  if (event.fights.length) {
    description += `${event.fights.join("\n")}\n\n`;
  }

  description += `${event.url}`;

  // Get current date and time to communicate to the user how up-to-date
  // the event details are
  const dateTimestr = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  description += `\n\nAccurate as of ${dateTimestr}`;

  const location = event.location;
  const uid = event.url.href;

  const calendarEvent: EventAttributes = {
    start,
    duration,
    title,
    description,
    location,
    uid,
    calName: "GLORY Kickboxing",
  };

  return calendarEvent;
}

createICS();
