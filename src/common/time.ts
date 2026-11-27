// India has no daylight saving, so IST is a fixed +05:30 offset.
// All "per day" rules (1 consultation per profile per day, horoscopes) and the
// hourly slot grid use IST wall-clock time.
export const IST_OFFSET_MS = 330 * 60_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Hour of day (0-23) in IST. */
export function istHour(ms: number) {
  return new Date(ms + IST_OFFSET_MS).getUTCHours();
}

/** IST calendar day as YYYY-MM-DD. */
export function istDay(ms: number) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** [start, end) of the IST day containing `ms`, as UTC epoch ms. */
export function istDayRange(ms: number): [number, number] {
  const local = ms + IST_OFFSET_MS;
  const start = local - (local % DAY) - IST_OFFSET_MS;
  return [start, start + DAY];
}

/** Start of the IST hour block containing `ms`. IST is on a whole-hour + 30 min offset. */
export function istHourStart(ms: number) {
  const local = ms + IST_OFFSET_MS;
  return local - (local % HOUR) - IST_OFFSET_MS;
}
