/**
 * @module copySelection
 * @description A single always-available "copy details" affordance for whatever
 * is currently selected or tracked.
 *
 * Every readout in this app paints to canvas (worldOverlayDraw's fillText), and
 * the Viewer is built with `infoBox: false` / `selectionIndicator: false`, so
 * nothing on screen is selectable text. This reads the structured record the
 * canvas card was built FROM, not the pixels.
 *
 * POLLING, NOT EVENTS: `selectTrackedSubjectContext` deliberately does not
 * dispatch `gev:entity-selected` (see contextStore.js), and
 * `gev:awareness-subject-selected` is emitted only by the two aircraft layers —
 * satellites emit neither. An event-driven button would silently miss a tracked
 * satellite, which is the case this exists for, so this polls one Map lookup on
 * a slow timer instead.
 *
 * Ctrl+C (Cmd+C) fires the same copy without the trip to the corner, but only
 * when there is nothing native to copy — see shouldHandleCopyHotkey.
 */

import { getSelectedEntityContext } from './data/contextStore.js';

const POLL_MS = 500;
const COPIED_FEEDBACK_MS = 1200;

/**
 * Identifier fields worth carrying into a web search, in priority order.
 * Names alone are ambiguous — "COSMOS 2221" is the reason this module exists —
 * so the catalog number or callsign leads.
 */
const IDENTIFIER_KEYS = Object.freeze([
  ['noradId', (value) => `NORAD ${value}`],
  ['icao24', (value) => `ICAO24 ${value}`],
  ['callsign', (value) => String(value)],
  ['registration', (value) => String(value)],
  ['mmsi', (value) => `MMSI ${value}`],
  ['imo', (value) => `IMO ${value}`],
  ['national_id', (value) => `NID ${value}`],
  ['vehicleId', (value) => `VEH ${value}`],
  ['tripId', (value) => `Trip ${value}`],
  ['operator', (value) => String(value)],
]);

/**
 * Does the label already say this, as a whole word?
 *
 * A transit label is built from the line and the fleet number ("Caltrain Local
 * Weekday 144"), so the vehicle id it came from would otherwise be appended
 * right back onto it. Token equality, not substring: MMSI 123 must still
 * survive a label that happens to contain "1234".
 *
 * @param {string} label
 * @param {string} value
 * @returns {boolean}
 */
function labelAlreadySays(label, value) {
  const needle = value.toLowerCase();
  return label.toLowerCase().split(/\s+/).includes(needle);
}

const MAX_IDENTIFIERS = 3;

/**
 * Anything that owns the caret and handles its own copy. `select` is included
 * because it takes focus and Ctrl+C over a listbox is the browser's business.
 */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable], [role="textbox"]';

/**
 * Decide whether a keydown is a copy-the-selection hotkey we may take over.
 *
 * Pure so the whole modifier/guard matrix is testable without a DOM. It does
 * NOT know whether a selection exists — the caller checks that first, so that
 * with nothing selected we never reach preventDefault and Ctrl+C stays native.
 *
 * @param {KeyboardEvent|object|null} event
 * @param {object} [context]
 * @param {Element|null} [context.activeElement] `document.activeElement`.
 * @param {string} [context.selectionText] `window.getSelection().toString()`.
 * @returns {boolean}
 */
export function shouldHandleCopyHotkey(event, { activeElement = null, selectionText = '' } = {}) {
  if (!event || event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (String(event.key ?? '').toLowerCase() !== 'c') return false;
  // Exactly one of Ctrl/Cmd, so Ctrl+C on Windows and Cmd+C on macOS both land
  // while Ctrl+Cmd+C — a copy on neither platform — does not.
  if (Boolean(event.ctrlKey) === Boolean(event.metaKey)) return false;
  // Ctrl+Shift+C is the devtools element picker and Ctrl+Alt+C belongs to other
  // tools; firing on either would be a copy the user never asked for. AltGr on
  // a Windows layout also reports ctrl+alt, and must not count as a hotkey.
  if (event.shiftKey || event.altKey) return false;
  // Real selected text always wins — native copy is what the user meant.
  if (String(selectionText ?? '').trim()) return false;
  // The focus check is separate from the selection check, and neither subsumes
  // the other. Chrome 145 does report a drag-selection inside <input> through
  // window.getSelection() (measured), but a bare caret in the search box
  // reports '' — and Ctrl+C there is still the text field's, not ours. WebKit
  // has historically reported '' for input selections at all, so leaning on
  // selectionText alone would also be one engine change away from wrong.
  for (const node of [event.target, activeElement]) {
    if (!node) continue;
    if (node.isContentEditable) return false;
    if (node.closest?.(EDITABLE_SELECTOR)) return false;
  }
  return true;
}

const clean = (value) => {
  const text = String(value ?? '').trim();
  return text && text.toLowerCase() !== 'null' ? text : '';
};

/**
 * Render one context record as a plain-text line suited to a search box.
 *
 * Deliberately terse: a search query degrades as it grows, so this is the
 * label, at most three identifiers, the owning layer, and the position — not a
 * property dump.
 *
 * @param {object|null} record Context-store record.
 * @returns {string} Pasteable text, or '' when there is nothing to copy.
 */
export function formatSelectionForCopy(record) {
  if (!record) return '';
  const label = clean(record.label);
  if (!label) return '';
  const properties = record.properties || {};

  const identifiers = [];
  for (const [key, format] of IDENTIFIER_KEYS) {
    if (identifiers.length >= MAX_IDENTIFIERS) break;
    const value = clean(properties[key]);
    // Skip a value that merely repeats the label — `operator === name` is
    // common in the OSM-derived sets, and a transit label already carries the
    // fleet number. Neither adds anything to a search.
    if (!value || value.toLowerCase() === label.toLowerCase()) continue;
    if (labelAlreadySays(label, value)) continue;
    identifiers.push(format(value));
  }

  const origin = clean(record.layerName);
  const source = clean(record.source);
  const provenance = origin && source ? `${origin} (${source})` : origin || source;

  const latitude = Number(record.latitude);
  const longitude = Number(record.longitude);
  const position = Number.isFinite(latitude) && Number.isFinite(longitude)
    ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
    : '';

  return [label, ...identifiers, provenance, position].filter(Boolean).join(' · ');
}

/**
 * Mount the copy button and keep it in step with the current selection.
 * @param {object} [deps]
 * @param {object} [deps.dataManager] Used to reject records whose layer is off.
 * @returns {{destroy: Function}} Teardown handle.
 */
export function initCopySelection({ dataManager } = {}) {
  const button = document.createElement('button');
  button.id = 'copy-selection-btn';
  button.type = 'button';
  button.hidden = true;
  button.textContent = 'COPY DETAILS';
  document.body.appendChild(button);

  let currentText = '';
  let feedbackTimer = null;

  const sync = () => {
    const record = getSelectedEntityContext({ dataManager });
    const text = formatSelectionForCopy(record);
    if (text === currentText) return;
    currentText = text;
    button.hidden = !text;
    // The full line goes in the tooltip so the button face stays fixed-width
    // and never reflows the corner as selections change.
    button.title = text ? `Copy (Ctrl+C): ${text}` : '';
  };

  const runCopy = async () => {
    if (!currentText) return;
    try {
      await navigator.clipboard.writeText(currentText);
      button.textContent = 'COPIED';
    } catch {
      // Clipboard access can be refused (permissions, insecure origin). Say so
      // rather than appearing to succeed.
      button.textContent = 'COPY FAILED';
    }
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => {
      button.textContent = 'COPY DETAILS';
    }, COPIED_FEEDBACK_MS);
  };

  // The hotkey routes through runCopy so the COPIED / COPY FAILED flash in the
  // corner is identical either way — that flash is the only confirmation the
  // keyboard path gets, since there is no button press to feel.
  const onKeyDown = (event) => {
    if (!currentText) return;
    if (!shouldHandleCopyHotkey(event, {
      activeElement: document.activeElement,
      selectionText: window.getSelection?.()?.toString() ?? '',
    })) return;
    event.preventDefault();
    runCopy();
  };

  button.addEventListener('click', runCopy);
  document.addEventListener('keydown', onKeyDown);
  const poll = window.setInterval(sync, POLL_MS);
  sync();

  return {
    destroy() {
      window.clearInterval(poll);
      window.clearTimeout(feedbackTimer);
      button.removeEventListener('click', runCopy);
      document.removeEventListener('keydown', onKeyDown);
      button.remove();
    },
  };
}
