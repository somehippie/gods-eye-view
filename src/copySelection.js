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
  ['operator', (value) => String(value)],
]);

const MAX_IDENTIFIERS = 3;

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
    // common in the OSM-derived sets and adds nothing to a search.
    if (!value || value.toLowerCase() === label.toLowerCase()) continue;
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
    button.title = text ? `Copy: ${text}` : '';
  };

  const onClick = async () => {
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

  button.addEventListener('click', onClick);
  const poll = window.setInterval(sync, POLL_MS);
  sync();

  return {
    destroy() {
      window.clearInterval(poll);
      window.clearTimeout(feedbackTimer);
      button.removeEventListener('click', onClick);
      button.remove();
    },
  };
}
