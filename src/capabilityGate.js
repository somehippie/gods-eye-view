/**
 * @module capabilityGate
 * @description Latches server capabilities that are absent by CONFIGURATION
 * rather than broken by circumstance, so the client stops asking.
 *
 * Both HUD enrichment paths poll on camera/position updates. When the feature
 * behind one is simply not configured, every poll produced a failed request and
 * a console line for a feature the operator deliberately left off. The fix is to
 * stop making the request, not to hide the log.
 *
 * The distinction that matters: 401/403/501/503 means "this will not work until
 * the server or the provider account is reconfigured", while 429, 502, a
 * timeout or a network blip means "try again later". Only the former latches;
 * everything transient keeps its existing retry behaviour.
 *
 * State is module-scoped and therefore per page load. Adding a key and
 * reloading — or restarting the dev server, which reloads — re-enables the
 * feature with nothing to reset. `window.__gevCapabilities` exposes the live
 * Map for inspection, and clearing it re-arms every latch without a reload,
 * which is the escape hatch when a 403 turns out to have been a key
 * restriction still propagating.
 */

/** @type {Map<string, {detail: string, remedy: string, at: string}>} */
const _unavailable = new Map();

const GLOBAL_KEY = '__gevCapabilities';

// Published on first import so the Map can be inspected before anything has
// failed. Guarded because the unit runner has no DOM.
if (typeof window !== 'undefined' && window) {
  window[GLOBAL_KEY] = _unavailable;
}

/**
 * Does this status mean "not configured" rather than "try again"?
 * @param {number} status HTTP status from the proxy.
 * @returns {boolean}
 */
export function isUnconfiguredStatus(status) {
  return status === 401 || status === 403 || status === 501 || status === 503;
}

/**
 * @param {string} name Capability name.
 * @returns {boolean} False once the capability has been latched off.
 */
export function isCapabilityAvailable(name) {
  return !_unavailable.has(name);
}

/**
 * Latch a capability off for this page load. Logs once, never repeats.
 *
 * @param {string} name Human-readable capability name.
 * @param {string} detail What was observed, e.g. `HTTP 503`.
 * @param {string} remedy What the operator must actually do — the fixes differ
 *   per capability (an env var versus enabling an API on a provider account),
 *   so the message has to name the specific one.
 * @returns {boolean} True on the first call for this capability.
 */
export function markCapabilityUnavailable(name, detail, remedy) {
  if (_unavailable.has(name)) return false;
  _unavailable.set(name, { detail, remedy, at: new Date().toISOString() });
  console.info(
    `[GEV] ${name} is not configured (${detail}). Disabled for this session — `
    + `to enable: ${remedy}. Inspect window.__gevCapabilities; `
    + 'clear it to retry without reloading.',
  );
  return true;
}

export function _resetCapabilityGateForTest() {
  _unavailable.clear();
}
