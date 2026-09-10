/**
 * @module amtrakFeed
 * @description Normalize Amtrak train positions into the shape the map renders.
 *
 * Pure — no Cesium, no DOM, no network. The proxy in `vite.config.js` imports
 * it server-side and `amtrakTrains.js` imports it client-side, so the wire
 * format is parsed in exactly one place.
 *
 * WHY A COMMUNITY MIRROR AND NOT AMTRAK DIRECTLY: Amtrak's own
 * `maps.amtrak.com/services/MapDataService/trains/getTrainsData` answers 200
 * with ~492 KB of base64 AES ciphertext, not JSON (measured 2026-09-10). The
 * decryption key lives in community projects, but defeating an obfuscation
 * layer Amtrak deliberately added is a different posture from reading a
 * published API, and it breaks on every key rotation. So this reads the
 * decrypted mirror, which serves plain JSON with no auth.
 *
 * MEASURED SHAPE (2026-09-10, n=59 trains):
 *   - The payload is an OBJECT keyed by train number, each value an ARRAY, so
 *     one number can carry several running instances. 59 objects, 59 distinct
 *     `trainID` — the id is `<number>-<instance>` and is what survives a poll.
 *   - `heading` is 8-point compass TEXT ("N", "SW"), never degrees.
 *   - `velocity` is mph: p50 45.4, max 106.3.
 *   - `iconColor` is a per-route hex string; 27 distinct across 54 trains.
 *   - `updatedAt` is null for exactly the `Predeparture` trains and for no
 *     others (9 of 9, twice). See PREDEPARTURE below.
 *   - Fix age for everything else: p50 2.7 min, p99 9.8 min, max 9.8 min.
 */

import { directionToHeading } from './directionText.js';

/**
 * A fix older than this is dropped as a train nobody is updating any more.
 *
 * Measured p99 and max fix age were both 9.8 minutes, so 20 minutes is about
 * twice the worst case actually observed. Tight enough to clear dead rows,
 * loose enough that a train with one slow ping does not blink off the map.
 * Exported as a parameter, not baked into the call, so a caller can say what
 * it means by stale.
 */
export const MAX_FIX_AGE_MS = 20 * 60_000;

/**
 * States worth drawing.
 *
 * `Completed` is a finished run still present in the payload — it is not going
 * anywhere and does not belong on a live map.
 *
 * `Predeparture` is excluded for a stronger reason than staleness: those rows
 * carry coordinates but `updatedAt` is null, and the correlation is exact
 * (9 of 9 null timestamps were Predeparture, twice, with zero nulls in any
 * other state). A position with no observation time is a scheduled origin, not
 * a fix. Drawing it would put an un-observed dot on the map, which is the same
 * thing as an interpolated position.
 */
export const RENDERED_STATES = Object.freeze(['Active']);

const text = (value) => {
  const out = String(value ?? '').trim();
  return out && out.toLowerCase() !== 'null' ? out : null;
};

/**
 * Number, or null.
 *
 * The `typeof` guard is load-bearing: `Number(null)` and `Number('')` are both
 * 0, and 0 is a perfectly finite latitude. Without it a row with a null `lat`
 * renders a train in the Gulf of Guinea instead of being dropped.
 */
const finite = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

/**
 * Parse the feed's timestamp into epoch milliseconds.
 *
 * Returns null rather than NaN for a missing or unparseable value. An earlier
 * throwaway measurement in this project let NaN through into a `Math.max` and
 * reported epoch seconds as a fix age; null forces every caller to decide.
 *
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export function parseFixTime(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Flatten and normalize the mirror's object-of-arrays payload.
 *
 * @param {object} payload Raw JSON body.
 * @returns {Array<object>} Normalized train records, unfiltered.
 */
export function normalizeAmtrakTrains(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const out = [];
  for (const group of Object.values(payload)) {
    // Defensive: the measured payload always nests an array here, but a single
    // -train response arriving bare would otherwise be silently dropped.
    for (const train of Array.isArray(group) ? group : [group]) {
      if (!train || typeof train !== 'object') continue;
      const id = text(train.trainID);
      const latitude = finite(train.lat);
      const longitude = finite(train.lon);
      if (!id || latitude === null || longitude === null) continue;
      const headingText = text(train.heading);
      out.push({
        id,
        trainNumber: text(train.trainNum) ?? text(train.trainNumRaw),
        routeName: text(train.routeName),
        latitude,
        longitude,
        headingText,
        // The feed says "SW", never 225. allowBare=true because this is a
        // dedicated direction field, not free-form text with street names in it.
        heading: Number.isFinite(directionToHeading(headingText, true))
          ? directionToHeading(headingText, true)
          : null,
        speed: finite(train.velocity),
        state: text(train.trainState),
        timely: text(train.trainTimely),
        originCode: text(train.origCode),
        originName: text(train.origName),
        destinationCode: text(train.destCode),
        destinationName: text(train.destName),
        color: text(train.iconColor),
        timestamp: parseFixTime(train.updatedAt),
      });
    }
  }
  return out;
}

/**
 * Keep the trains that are actually running and actually observed.
 *
 * Unlike the 511 layer, a record with NO timestamp is DROPPED here rather than
 * kept. That is not an inconsistency: there, a missing timestamp meant an
 * operator that never sends one and keeping it was the only way not to empty
 * those agencies. Here it means Predeparture — a known state with a known
 * meaning — and the row's coordinates are a schedule, not an observation.
 *
 * @param {Array<object>} trains
 * @param {number} nowMs
 * @param {number} [maxAgeMs]
 * @param {Array<string>} [states]
 * @returns {Array<object>}
 */
export function runningTrains(trains, nowMs, maxAgeMs = MAX_FIX_AGE_MS, states = RENDERED_STATES) {
  const allowed = new Set(states);
  const out = [];
  for (const train of trains || []) {
    if (!train?.id) continue;
    if (!allowed.has(train.state)) continue;
    if (train.timestamp === null) continue;
    if (nowMs - train.timestamp > maxAgeMs) continue;
    out.push(train);
  }
  return out;
}

/**
 * Human label for a train.
 *
 * Route first, then the number, because "Sunset Limited 1" reads as a train and
 * "1" does not. Never repeats a part the route name already carries — several
 * Amtrak services have a number in the route name.
 *
 * @param {object} record
 * @returns {string}
 */
export function trainLabel(record) {
  const parts = [];
  const push = (value) => {
    const item = text(value);
    if (!item) return;
    // Token RUNS, not whole strings: several Amtrak services carry the number
    // inside the route name ("Acela 2150"), and a whole-string comparison would
    // append it right back onto a label that already ends with it. Same failure
    // copySelection.js hit with multi-word operators; the fix is the same shape,
    // kept local so a data module does not depend on a UI one.
    const haystack = parts.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
    const needle = item.toLowerCase().split(/\s+/).filter(Boolean);
    if (needle.length && needle.length <= haystack.length) {
      for (let start = 0; start <= haystack.length - needle.length; start += 1) {
        if (needle.every((token, offset) => haystack[start + offset] === token)) return;
      }
    }
    parts.push(item);
  };
  push(record?.routeName);
  push(record?.trainNumber);
  return parts.join(' ') || 'Amtrak train';
}
