/**
 * @module fieldGuards
 * @description Read a field off an EXTERNAL payload without letting a blank
 * become a zero.
 *
 * THE ANTIPATTERN THIS EXISTS TO REPLACE, by name so it is greppable:
 *
 *     Number.isFinite(Number(row.lat)) ? Number(row.lat) : null
 *
 * That reads as validation and is not. `Number(null)`, `Number('')`,
 * `Number('   ')`, `Number([])` and `Number(false)` are **all 0**, and 0 is a
 * perfectly finite latitude, a plausible car count and a believable speed. The
 * finite check passes, the blank field becomes a real-looking value, and the
 * defect is invisible because the number it produces is in range.
 *
 * It bit three separate parsers in one session:
 *
 *   - `amtrakFeed.js` — a null `lat` passed the finite check; the train would
 *     have rendered in the Gulf of Guinea.
 *   - `bartEtd.js` — a blank `gtfs_latitude` did the same to a station.
 *   - `bartEtd.js` again — a missing `length` would have become a zero-car
 *     train.
 *
 * The fix is not vigilance. It is checking the TYPE before coercing, so a value
 * that was never a number fails instead of arriving as one.
 *
 * Use these in any parser reading a payload from off the machine. For values
 * this app itself computed, plain `Number()` is fine — the hazard is external
 * data, where a field can be absent, blank, or the string "null".
 */

/**
 * Number, or null.
 *
 * Rejects anything that is not already a number or a non-blank string, so a
 * null, an empty string, whitespace, an array or a boolean cannot arrive as 0.
 *
 * @param {*} value Raw field from an external payload.
 * @returns {number|null}
 */
export function numericField(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Integer, or null. Same type guard, then rejects fractions.
 * @param {*} value Raw field from an external payload.
 * @returns {number|null}
 */
export function integerField(value) {
  const num = numericField(value);
  return num !== null && Number.isInteger(num) ? num : null;
}

/**
 * Trimmed non-empty string, or null.
 *
 * Also rejects the literal string "null", which several of these feeds send in
 * place of an absent value — BART and the 511 operators both do it.
 *
 * @param {*} value Raw field from an external payload.
 * @returns {string|null}
 */
export function textField(value) {
  const out = String(value ?? '').trim();
  return out && out.toLowerCase() !== 'null' ? out : null;
}

/**
 * A latitude/longitude pair, or null if either is unusable.
 *
 * Range is checked as well as type: every bug above produced a *finite*
 * coordinate, so finiteness alone was never the missing check. A 0/0 pair is
 * additionally rejected — it is Null Island, which in practice means "two
 * fields were blank" far more often than it means a buoy in the Gulf of Guinea.
 *
 * @param {*} latitude
 * @param {*} longitude
 * @returns {{latitude: number, longitude: number}|null}
 */
export function coordinateField(latitude, longitude) {
  const lat = numericField(latitude);
  const lon = numericField(longitude);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { latitude: lat, longitude: lon };
}
