#!/usr/bin/env node

import { CalDAVClient } from "ts-caldav";
import { exec, execSync, spawn } from 'child_process';
import nodeIcal from 'node-ical';

const BASE_URL = "https://p104-caldav.icloud.com/";

function dayRange(offset) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function dateOf(value) {
  return value instanceof Date ? value : new Date(value);
}

function timeOf(value) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: 'America/Boise'
  }).format(dateOf(value));
}

/*
 * ts-caldav currently returns incorrect UTC Dates for some
 * timezone-aware events.
 *
 * Fetch the event's original ICS and let node-ical interpret
 * the TZID/VTIMEZONE information correctly.
 *
 * Returns corrected start/end Dates, or the original values
 * if the correction cannot safely be made.
 */
async function correctEventTimes(event, username, password, debugMode) {
  // All-day events don't need timezone conversion.
  if (event.wholeDay) {
    return {
      start: event.start,
      end: event.end
    };
  }

  // Without an event URL there is nothing we can safely re-parse.
  if (!event.href) {
    return {
      start: event.start,
      end: event.end
    };
  }

  try {
    const icsUrl = new URL(event.href, BASE_URL).toString();

    const response = await fetch(icsUrl, {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${username}:${password}`).toString("base64"),
      },
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    const rawICS = await response.text();
    const parsedICS = nodeIcal.parseICS(rawICS);

    /*
     * Find the VEVENT corresponding to the event returned
     * by ts-caldav.
     */
    for (const key of Object.keys(parsedICS)) {
      const parsedEvent = parsedICS[key];

      if (
        parsedEvent.type !== "VEVENT" ||
        parsedEvent.uid !== event.uid
      ) {
        continue;
      }

      /*
       * Recurring event.
       *
       * ts-caldav has already identified the occurrence, but
       * its UTC conversion can be wrong for timezone-aware
       * recurring events when DST is involved.
       *
       * The raw ICS contains the recurrence rule and TZID.
       * Let node-ical expand it and find the occurrence that
       * falls on the same local calendar date as the ts-caldav
       * occurrence.
       */
      if (parsedEvent.rrule) {
        const occurrenceStart = new Date(
          event.start.getTime() - 24 * 60 * 60 * 1000
        );

        const occurrenceEnd = new Date(
          event.end.getTime() + 24 * 60 * 60 * 1000
        );

        const occurrences = nodeIcal.expandRecurringEvent(
          parsedEvent,
          {
            from: occurrenceStart,
            to: occurrenceEnd
          }
        );

        if (debugMode) {
          console.log("\nRecurring event expansion:");
          console.dir(occurrences, { depth: null });
        }

        /*
         * Determine the local calendar date represented by
         * the ts-caldav occurrence.
         *
         * We intentionally use the event's TZID here rather
         * than UTC, because the UTC value may be precisely
         * what ts-caldav got wrong.
         */
        const eventTimeZone =
          event.startTzid || "America/Boise";

        const targetDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: eventTimeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).format(event.start);

        const occurrence = occurrences.find(item => {
          if (!(item.start instanceof Date)) {
            return false;
          }

          const occurrenceDate = new Intl.DateTimeFormat("en-CA", {
            timeZone: eventTimeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
          }).format(item.start);

          return occurrenceDate === targetDate;
        });

        if (occurrence) {
          if (debugMode) {
            console.log("\nMatched recurring occurrence:");
            console.dir(
              {
                summary: occurrence.summary,
                start: occurrence.start,
                startISO:
                  occurrence.start instanceof Date
                    ? occurrence.start.toISOString()
                    : null,
                end: occurrence.end,
                endISO:
                  occurrence.end instanceof Date
                    ? occurrence.end.toISOString()
                    : null
              },
              { depth: null }
            );
          }

          return {
            start: occurrence.start,
            end:
              occurrence.end instanceof Date
                ? occurrence.end
                : event.end
          };
        }

        /*
         * If node-ical cannot resolve the occurrence, retain
         * the ts-caldav result rather than dropping the event.
         */
        if (debugMode) {
          console.log(
            `Could not match recurring occurrence for "${event.summary}". ` +
            `Using ts-caldav dates.`
          );
        }

        return {
          start: event.start,
          end: event.end
        };
      }

      /*
       * Non-recurring event:
       *
       * node-ical gives us the timezone-correct Date based on
       * the TZID/VTIMEZONE in the original ICS.
       */
      if (parsedEvent.start instanceof Date) {
        return {
          start: parsedEvent.start,
          end:
            parsedEvent.end instanceof Date
              ? parsedEvent.end
              : event.end
        };
      }
    }

    if (debugMode) {
      console.log(
        `Could not find matching VEVENT for "${event.summary}". ` +
        `Using ts-caldav dates.`
      );
    }

  } catch (error) {
    /*
     * Don't allow a timezone parsing problem to prevent the
     * calendar from being published to the board.
     */
    if (debugMode) {
      console.log(
        `Could not correct timezone for "${event.summary}". ` +
        `Using ts-caldav dates.`
      );
      console.log(error?.message || error);
    }
  }

  return {
    start: event.start,
    end: event.end
  };
}

async function main() {
  const username = process.env.ICLOUD_CALDAV_USER;
  const password = process.env.ICLOUD_CALDAV_PASSWORD;
  const calendarName = process.env.ICLOUD_CALENDAR?.trim();

  if (!username) throw new Error("ICLOUD_CALDAV_USER is not set.");
  if (!password) throw new Error("ICLOUD_CALDAV_PASSWORD is not set.");

  const args = process.argv.slice(2);
  let offset = 0;
  let debugMode = 0;

  // usage: node caldav.mjs <offset from today> <debug mode>

  if (args[1] !== undefined) {
    const parsedValue = Number.parseInt(args[1], 10);
    const isInteger =
      !Number.isNaN(parsedValue) && String(parsedValue) === args[1];

    if (isInteger) {
      debugMode = parsedValue;

      if (debugMode) {
        console.log(`Running in debug mode`);
      }
    }
  }

  if (args[0] !== undefined) {
    const parsedValue = Number.parseInt(args[0], 10);
    const isInteger =
      !Number.isNaN(parsedValue) && String(parsedValue) === args[0];

    if (isInteger) {
      offset = parsedValue;

      if (debugMode) {
        console.log(
          `Query iCloud calendar with day offset ${offset}`
        );
      }
    }
  }

  if (debugMode) {
    console.log("Connecting to iCloud CalDAV...");
  }

  const client = await CalDAVClient.create({
    baseUrl: BASE_URL,
    auth: { type: "basic", username, password },
    requestTimeout: 10000,
  });

  if (debugMode) {
    console.log("Connected.\n");
  }

  const calendars = await client.getCalendars();

  if (debugMode) {
    console.log("Calendars:");

    for (const calendar of calendars) {
      console.log(
        `  - ${calendar.displayName || "(unnamed)"}`
      );
      console.log(`    URL: ${calendar.url}`);
    }
  }

  if (!calendarName) {
    console.log("\nSet ICLOUD_CALENDAR to select a calendar.");
    return;
  }

  const calendar = calendars.find(
    c =>
      String(c.displayName || "").trim().toLowerCase() ===
      calendarName.toLowerCase()
  );

  if (!calendar) {
    throw new Error(
      `Calendar "${calendarName}" was not found.`
    );
  }

  const { start, end } = dayRange(offset);

  if (debugMode) {
    console.log(
      `\nSelected calendar: ${calendar.displayName}`
    );
    console.log("Fetching day's events...");
  }

  const events = await client.getEvents(calendar.url, {
    start,
    end,
    all: false,
    expand: true,
  });

  const weekday = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday"
  ];

	const dayevents = events
	  .filter(
		e =>
		  dateOf(e.start) < end &&
		  dateOf(e.end) > start
	  );
	
	const correctedEvents = [];
	
	for (const event of dayevents) {
		if (debugMode) {
		  console.log("\nEVENT DETAILS:");
		  console.dir({
			summary: event.summary,
			uid: event.uid,
			start: event.start,
			startISO: event.start?.toISOString(),
			end: event.end,
			endISO: event.end?.toISOString(),
			startTzid: event.startTzid,
			endTzid: event.endTzid,
			wholeDay: event.wholeDay,
			recurrenceRule: event.recurrenceRule,
			href: event.href
		  }, { depth: null });
		}

	  const correctedTimes = await correctEventTimes(
		event,
		username,
		password,
		debugMode
	  );
	
	  correctedEvents.push({
		event,
		start: correctedTimes.start,
		end: correctedTimes.end
	  });
	}
	
	if (debugMode) {
	  console.log("\nSORT ORDER BEFORE SORT:");
	
	  for (const item of correctedEvents) {
		console.log(
		  item.event.summary,
		  item.start.toISOString(),
		  "=>",
		  timeOf(item.start)
		);
	  }
	}

	correctedEvents.sort(
	  (a, b) => dateOf(a.start) - dateOf(b.start)
	);
	
	let message = `\n${correctedEvents.length} events `;
	
	if (offset) {
	  message += `on ${weekday[start.getDay()]}`;
	} else {
	  message += `today`;
	}
	
	message += `\n`;
	
	if (!correctedEvents.length) {
	  message += "  (none)";
	} else {
	  for (const item of correctedEvents) {
		const event = item.event;
	
		const title = String(
		  event.summary ||
		  event.title ||
		  "(untitled event)"
		).trim();
	
		const allDay = Boolean(
		  event.wholeDay ?? event.allDay
		);
	
		message += (
		  allDay
			? `ALL DAY ${title}\n`
			: `${timeOf(item.start)} ${title}${
				item.end
				  ? ` → ${timeOf(item.end)}`
				  : ""
			  }\n`
		);
	  }
	}
  if (debugMode) {
    console.log(`\n${message}`);
  } else {
    spawn(`/opt/calendar/messages.sh`, [
      `events${offset}`,
      message
    ]);
  }
}

main().catch(error => {
  console.error("\nCalDAV connection failed.");
  console.error(error?.message || error);

  if (error?.status) {
    console.error(`HTTP status: ${error.status}`);
  }

  process.exitCode = 1;
});
