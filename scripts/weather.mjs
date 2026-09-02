#!/usr/bin/env node
// weather.mjs

import { spawn } from 'child_process';

const LATITUDE = 43.753223;
const LONGITUDE = -116.38249;

const url = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&daily=temperature_2m_max,temperature_2m_min,uv_index_max,rain_sum,showers_sum,snowfall_sum,wind_speed_10m_max,precipitation_sum,precipitation_hours,apparent_temperature_max,apparent_temperature_min&hourly=precipitation,precipitation_probability,temperature_2m,apparent_temperature,uv_index,snowfall,rain,showers,wind_speed_10m&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,rain,showers,snowfall&timezone=America%2FDenver&forecast_days=1&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch`;


/*
 * Find all contiguous periods where the hourly value is
 * greater than or equal to minvalue.
 *
 * Example:
 *
 *   [0, 0, 5, 7, 8, 2, 0, 6, 7, 0]
 *
 *   hourly_find(array, 5)
 *
 *   returns two periods:
 *     02:00-04:00
 *     07:00-08:00
 *
 * max_value is the maximum value across each period.
 */
function hourly_find(dayarray, minvalue) {
  const periods = [];

  let hour_start = null;
  let max_value = 0;

  for (let i = 0; i < dayarray.length; ++i) {
    const value = Number(dayarray[i] ?? 0);

    if (value >= minvalue) {
      if (hour_start === null) {
        hour_start = i;
        max_value = value;
      } else {
        max_value = Math.max(max_value, value);
      }
    } else if (hour_start !== null) {
      periods.push({
        hour_start,
        hour_end: i - 1,
        max_value
      });

      hour_start = null;
      max_value = 0;
    }
  }

  // Condition continues through the final hour.
  if (hour_start !== null) {
    periods.push({
      hour_start,
      hour_end: dayarray.length - 1,
      max_value
    });
  }

  return {
    found: periods.length > 0,
    periods
  };
}


/*
 * Return the strongest value in a range of hours.
 */
function hourly_max(dayarray, startHour = 0, endHour = 23) {
  let max = null;
  let maxHour = null;

  for (let i = startHour; i <= endHour && i < dayarray.length; ++i) {
    const value = Number(dayarray[i]);

    if (Number.isNaN(value)) {
      continue;
    }

    if (max === null || value > max) {
      max = value;
      maxHour = i;
    }
  }

  return {
    value: max,
    hour: maxHour
  };
}


/*
 * Return the minimum value in a range of hours.
 */
function hourly_min(dayarray, startHour = 0, endHour = 23) {
  let min = null;
  let minHour = null;

  for (let i = startHour; i <= endHour && i < dayarray.length; ++i) {
    const value = Number(dayarray[i]);

    if (Number.isNaN(value)) {
      continue;
    }

    if (min === null || value < min) {
      min = value;
      minHour = i;
    }
  }

  return {
    value: min,
    hour: minHour
  };
}


/*
 * Convert an hour number into something suitable for
 * a human-readable board message.
 */
function hourText(hour) {
  if (hour === null || hour === undefined) {
    return "";
  }

  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;

  return `${hour - 12} PM`;
}


/*
 * Convert a period into human-readable text.
 */
function periodText(period) {
  if (period.hour_start === period.hour_end) {
    return hourText(period.hour_start);
  }

  return `${hourText(period.hour_start)}-${hourText(period.hour_end)}`;
}


/*
 * WEATHER RULE BOOK
 *
 * This function knows about weather semantics.
 *
 * It does NOT know anything about Splitflap, HomeSeer,
 * APIs, or how messages are ultimately displayed.
 *
 * It simply returns recommendations.
 */
function weather_rule_book(data) {
  const messages = [];

  const hourly = data.hourly;
  const daily = data.daily;

  /*
   * ---------------------------------------------------------
   * TEMPERATURE / CLOTHING
   * ---------------------------------------------------------
   */

  const morningMin = hourly_min(
    hourly.temperature_2m,
    6,
    10
  );

  const afternoonMax = hourly_max(
    hourly.temperature_2m,
    12,
    18
  );

  if (morningMin.value !== null && afternoonMax.value !== null) {

    const temperatureSwing =
      afternoonMax.value - morningMin.value;

    if (morningMin.value < 55) {
      messages.push({
        priority: 40,
        text: `JACKET THIS MORNING`
      });
    } else if (morningMin.value < 65) {
      messages.push({
        priority: 30,
        text: `LIGHT LAYER IN MORNING`
      });
    }

    /*
     * A large swing is more useful than simply saying
     * "wear a jacket" when the afternoon will be hot.
     */
    if (temperatureSwing >= 25) {
      messages.push({
        priority: 50,
        text: `LAYERS: ${Math.round(morningMin.value)}° → ${Math.round(afternoonMax.value)}°`
      });
    }

    if (afternoonMax.value >= 90) {
      messages.push({
        priority: 60,
        text: `HOT THIS AFTERNOON`
      });
    }
  }


  /*
   * ---------------------------------------------------------
   * RAIN
   * ---------------------------------------------------------
   */

  const rain = hourly_find(
    hourly.precipitation_probability,
    40
  );

  if (rain.found) {
    for (const period of rain.periods) {
      messages.push({
        priority: 70,
        text: `RAIN ${periodText(period)}`
      });
    }
  }


  /*
   * ---------------------------------------------------------
   * SNOW
   * ---------------------------------------------------------
   */

  const snow = hourly_find(
    hourly.snowfall,
    0.01
  );

  if (snow.found) {
    for (const period of snow.periods) {
      messages.push({
        priority: 90,
        text: `SNOW ${periodText(period)}`
      });
    }
  }


  /*
   * ---------------------------------------------------------
   * UV
   * ---------------------------------------------------------
   */

  const uv = hourly_find(
    hourly.uv_index,
    3
  );

  if (uv.found) {

    const strongestUV = hourly_max(
      hourly.uv_index,
      0,
      23
    );

    if (strongestUV.value >= 6) {
      messages.push({
        priority: 60,
        text: `STRONG UV ${periodText(uv.periods[0])}`
      });

      messages.push({
        priority: 50,
        text: `SUNSCREEN RECOMMENDED`
      });
    } else {
      messages.push({
        priority: 30,
        text: `SUNSCREEN ${periodText(uv.periods[0])}`
      });
    }
  }


  /*
   * ---------------------------------------------------------
   * WIND
   * ---------------------------------------------------------
   */

  const wind = hourly_find(
    hourly.wind_speed_10m,
    20
  );

  if (wind.found) {
    for (const period of wind.periods) {
      messages.push({
        priority: 60,
        text: `WINDY ${periodText(period)}`
      });
    }
  }


  /*
   * ---------------------------------------------------------
   * DAILY SUMMARY - Only if not enough messages
   * ---------------------------------------------------------
   */

  if ((messages.length < 6) && (daily.temperature_2m_max?.length)) {

    const maxTemp =
      daily.temperature_2m_max[0];

    const minTemp =
      daily.temperature_2m_min[0];

    messages.push({
      priority: 5,
      text: `TODAY'S: ${minTemp}°-${maxTemp}°`
    });
  }


  /*
   * Highest priority recommendations first.
   */
  messages.sort(
    (a, b) => b.priority - a.priority
  );

  return messages;
}


async function fetchWeather() {

  try {

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `HTTP error! Status: ${response.status}`
      );
    }

    const data = await response.json();

/* Not needed for now - current weather
    const current = data.current;

    console.log(
      `--- Current Weather (${LATITUDE}, ${LONGITUDE}) ---`
    );

    console.log(
      `Time:        ${current.time}`
    );

    console.log(
      `Temperature: ${current.temperature_2m}°F`
    );

    console.log(
      `Feels like:  ${current.apparent_temperature}°F`
    );

    console.log(
      `Humidity:    ${current.relative_humidity_2m}%`
    );

    console.log(
      `Wind Speed:  ${current.wind_speed_10m} mph`
    );
*/

    /*
     * Run the rulebook.
     */
    const messages = weather_rule_book(data);
    
    // debug - show raw object
    //console.dir(messages);

	let boardMessage = `WHAT TO DO?\n`;
    console.log("\n--- WEATHER RECOMMENDATIONS ---");

	messages.sort((x, y) => y.priority - x.priority)
 		.forEach(item => {
    		console.log(`[Priority ${item.priority}] ${item.text}`);
    		boardMessage += `${item.text}\n`;
    	});

	//const sortedMessages = Object.values(messages).sort((x, y) => x.priority - y.priority);


    //for (const message of sortedMessages) {
    //  console.log(
	//    `[${message.priority}] ${message.text}`
    //  );
    //}


    return boardMessage;


  } catch (error) {

    console.error(
      'Failed to fetch weather data:',
      error.message
    );
  }
}


async function main() {

  const messages = await fetchWeather();

  spawn(`/opt/commands/messages.sh`, [
      "whattodo",
      messages
    ]);
}

main().catch(error => {

  console.error("\nFetch weather failed.");

  console.error(
    error?.message || error
  );

  if (error?.status) {
    console.error(
      `Status: ${error.status}`
    );
  }

  process.exitCode = 1;

});
