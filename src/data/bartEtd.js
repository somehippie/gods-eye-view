/**
 * @module bartEtd
 * @description Normalize BART's Estimated Time of Departure feed into station
 * records the map can render.
 *
 * Pure — no Cesium, no DOM, no network. The proxy in `vite.config.js` imports
 * it server-side and `bartDepartures.js` imports it client-side, so the wire
 * format is parsed in exactly one place.
 *
 * WHY DEPARTURES AND NOT TRAINS: BART publishes no vehicle positions anywhere.
 * `api.bart.gov/gtfsrt/vehiclepositions.aspx` is a 404, its live trip feed
 * decodes to 90 entities that are all TripUpdate and zero VehiclePosition, and
 * 511's `agency=BA` answers 200 with a valid header and no entities. BART's
 * real-time data is arrival estimates, so the honest rendering is a
 * station-departures board — never an interpolated train somewhere on a line.
 *
 * MEASURED SHAPE (2026-09-10):
 *   - 50 stations from `stn.aspx?cmd=stns`, each with `gtfs_latitude` /
 *     `gtfs_longitude`. That list is separate from the ETD feed.
 *   - A station with no service is OMITTED FROM THE ETD FEED ENTIRELY rather
 *     than present with an empty list. At 00:49 PDT 44 of 50 reported; at
 *     01:49 only 7 did. Overnight it will be none. Station geography therefore
 *     comes from the station list and departures are merged onto it, so a
 *     closed station stays on the map instead of vanishing.
 *   - `minutes` is the string "Leaving" or a numeric string — never a number.
 *   - `length` is the car count, observed 5, 6, 9, 10.
 *   - `delay` is SECONDS, not minutes. Observed up to 162.
 *   - `hexcolor` is the line colour and is what this uses. BART's licence
 *     forbids its trademarks and copyrighted materials, which is the logo and
 *     the system map; a colour value out of the data feed is neither.
 */

/** "Leaving" sorts ahead of every numeric estimate. */
const LEAVING_MINUTES = 0;

/**
 * Build a BART API URL.
 *
 * Lives here, beside the parser, rather than inside the proxy closure, so it is
 * reachable from a unit test. It exists at all because `etd.aspx` REQUIRES an
 * `orig` parameter — omitting it answers **400** with
 * `{"error":{"text":"Invalid orig"}}` rather than defaulting to anything — and
 * a first version of this proxy dropped it. That shipped past 21 green tests,
 * because every one of them exercised the normalizer and none built a URL.
 *
 * @param {string} endpoint e.g. `etd.aspx`.
 * @param {string} cmd e.g. `etd`.
 * @param {string} apiKey
 * @param {Record<string, string>} [params] Endpoint-specific parameters.
 * @returns {URL}
 */
export function bartUrlFor(endpoint, cmd, apiKey, params = {}) {
  const url = new URL(`https://api.bart.gov/api/${endpoint}`);
  url.searchParams.set('cmd', cmd);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('json', 'y');
  return url;
}

const text = (value) => {
  const out = String(value ?? '').trim();
  return out && out.toLowerCase() !== 'null' ? out : null;
};

/**
 * Number, or null.
 *
 * `Number(null)`, `Number('')` and `Number('   ')` are all 0, and 0 is both a
 * finite latitude and a plausible car count. Guarding the type first is the
 * only way a blank field fails instead of silently becoming zero — a blank
 * `gtfs_latitude` would otherwise place a station in the Gulf of Guinea.
 *
 * @param {*} value
 * @returns {number|null}
 */
const numeric = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

/**
 * Integer, or null. Same guard as `numeric`, so a missing car count does not
 * become a zero-car train.
 * @param {*} value
 * @returns {number|null}
 */
const integer = (value) => {
  const num = numeric(value);
  return num !== null && Number.isInteger(num) ? num : null;
};

/** BART returns a bare object where a single-element array would be expected. */
const asArray = (value) => {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
};

/**
 * Parse BART's `minutes` field.
 *
 * It is a string in every case, and one of its values is the word "Leaving".
 * `leaving` is kept alongside the number rather than collapsed into it, because
 * a board reading "0 min" and one reading "Leaving" say different things to
 * someone standing on the platform.
 *
 * @param {*} value
 * @returns {{minutes: number, leaving: boolean}|null}
 */
export function parseMinutes(value) {
  const raw = text(value);
  if (!raw) return null;
  if (raw.toLowerCase() === 'leaving') return { minutes: LEAVING_MINUTES, leaving: true };
  const num = integer(raw);
  return num === null || num < 0 ? null : { minutes: num, leaving: false };
}

/**
 * Normalize the station list into map geography.
 * @param {object} payload Raw `stn.aspx?cmd=stns` body.
 * @returns {Array<{code: string, name: string, latitude: number, longitude: number}>}
 */
export function normalizeStations(payload) {
  const rows = asArray(payload?.root?.stations?.station);
  const out = [];
  for (const row of rows) {
    const code = text(row?.abbr);
    const name = text(row?.name);
    const latitude = numeric(row?.gtfs_latitude);
    const longitude = numeric(row?.gtfs_longitude);
    if (!code || !name) continue;
    if (latitude === null || longitude === null) continue;
    out.push({ code, name, latitude, longitude });
  }
  return out;
}

/**
 * Normalize the ETD feed into departures keyed by station code.
 * @param {object} payload Raw `etd.aspx?cmd=etd&orig=ALL` body.
 * @returns {Map<string, Array<object>>}
 */
export function normalizeDepartures(payload) {
  const byStation = new Map();
  for (const station of asArray(payload?.root?.station)) {
    const code = text(station?.abbr);
    if (!code) continue;
    const departures = [];
    for (const group of asArray(station?.etd)) {
      const destination = text(group?.destination);
      const destinationCode = text(group?.abbreviation);
      for (const estimate of asArray(group?.estimate)) {
        const parsed = parseMinutes(estimate?.minutes);
        if (!parsed) continue;
        departures.push({
          destination,
          destinationCode,
          minutes: parsed.minutes,
          leaving: parsed.leaving,
          platform: text(estimate?.platform),
          direction: text(estimate?.direction),
          cars: integer(estimate?.length),
          line: text(estimate?.color),
          hexColor: text(estimate?.hexcolor),
          // BART reports delay in SECONDS. Naming it so no caller reads minutes.
          delaySeconds: integer(estimate?.delay) ?? 0,
          cancelled: text(estimate?.cancelflag) === '1',
          bikes: text(estimate?.bikeflag) === '1',
        });
      }
    }
    departures.sort((a, b) => a.minutes - b.minutes);
    byStation.set(code, departures);
  }
  return byStation;
}

/**
 * Merge departures onto the full station list.
 *
 * Every station in the list comes back, including those the ETD feed omitted —
 * that omission is how BART says "no service right now", and a station is
 * geography that does not stop existing when the system closes.
 *
 * @param {Array<object>} stations From normalizeStations.
 * @param {Map<string, Array<object>>} departures From normalizeDepartures.
 * @returns {Array<object>} Station records with a `departures` array.
 */
export function mergeStationDepartures(stations, departures) {
  return (stations || []).map((station) => ({
    ...station,
    departures: departures?.get(station.code) ?? [],
  }));
}

/**
 * Colour for a station dot: the line of its soonest departure.
 *
 * Null when nothing is departing, which the renderer draws dimmed. Cancelled
 * runs are skipped — a cancelled train's colour would advertise service that is
 * not coming.
 *
 * @param {object} station
 * @returns {string|null} CSS hex colour, or null.
 */
export function stationColor(station) {
  for (const departure of station?.departures ?? []) {
    if (departure.cancelled) continue;
    if (departure.hexColor) return departure.hexColor;
  }
  return null;
}

/**
 * Rows for the on-screen departure board, soonest first.
 *
 * Returns structured rows rather than formatted text so the renderer can colour
 * each line individually — one Cesium label carries a single fill colour, so a
 * multi-line board in one label could not show per-line colours.
 *
 * @param {object} station
 * @param {number} [maxRows]
 * @returns {Array<{text: string, hexColor: string|null}>}
 */
export function departureBoard(station, maxRows = 8) {
  const rows = [];
  for (const departure of station?.departures ?? []) {
    if (rows.length >= maxRows) break;
    const when = departure.leaving ? 'Leaving' : `${departure.minutes} min`;
    const parts = [when.padEnd(8), departure.destination || departure.destinationCode || '—'];
    const tail = [];
    if (departure.platform) tail.push(`plat ${departure.platform}`);
    if (departure.cars) tail.push(`${departure.cars} car`);
    if (departure.cancelled) tail.push('CANCELLED');
    else if (departure.delaySeconds >= 60) tail.push(`+${Math.round(departure.delaySeconds / 60)}m late`);
    if (tail.length) parts.push(`(${tail.join(', ')})`);
    rows.push({ text: parts.join(' '), hexColor: departure.hexColor });
  }
  return rows;
}

/**
 * One-line summary of the next departure, for the copy button.
 * @param {object} station
 * @returns {string|null}
 */
export function nextDepartureSummary(station) {
  const next = (station?.departures ?? []).find((departure) => !departure.cancelled);
  if (!next) return null;
  const when = next.leaving ? 'Leaving' : `${next.minutes} min`;
  const destination = next.destination || next.destinationCode;
  return destination ? `${destination} ${when}` : when;
}
