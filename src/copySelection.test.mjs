import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSelectionForCopy, shouldHandleCopyHotkey } from './copySelection.js';

// The satellite case this exists for: the name alone is ambiguous across the
// catalog, so the NORAD id has to survive into the copied line.
test('a tracked satellite copies its catalog number alongside the name', () => {
  assert.equal(
    formatSelectionForCopy({
      label: 'COSMOS 2221',
      layerName: 'Satellites',
      source: 'CelesTrak',
      latitude: 37.5485,
      longitude: -121.9886,
      properties: { name: 'COSMOS 2221', operator: '', noradId: '22236' },
    }),
    'COSMOS 2221 · NORAD 22236 · Satellites (CelesTrak) · 37.54850, -121.98860',
  );
});

test('an operator that merely repeats the name is not duplicated', () => {
  const line = formatSelectionForCopy({
    label: 'Amazon Web Services',
    layerName: 'Datacenters',
    source: 'Local',
    latitude: 37.4,
    longitude: -121.9,
    properties: { operator: 'Amazon Web Services' },
  });
  assert.equal(line, 'Amazon Web Services · Datacenters (Local) · 37.40000, -121.90000');
  assert.equal(line.match(/Amazon Web Services/g).length, 1);
});

test('identifiers are capped so the line stays a usable search query', () => {
  const line = formatSelectionForCopy({
    label: 'Test Contact',
    layerName: 'Flights',
    source: 'OpenSky',
    latitude: 0,
    longitude: 0,
    properties: {
      noradId: '1', icao24: '2', callsign: '3', registration: '4', mmsi: '5',
    },
  });
  assert.equal(line, 'Test Contact · NORAD 1 · ICAO24 2 · 3 · Flights (OpenSky) · 0.00000, 0.00000');
});

test('a record without a label copies nothing rather than a bare coordinate', () => {
  assert.equal(formatSelectionForCopy({ layerName: 'Dams', latitude: 1, longitude: 2 }), '');
  assert.equal(formatSelectionForCopy(null), '');
});

test('a train copies the trip that pins the run, not the label back to itself', () => {
  // The transit label is built from operator + line + fleet number, so the
  // vehicle id and operator are already in it. The trip id is the part that
  // identifies THIS run and is the only one worth appending.
  assert.equal(
    formatSelectionForCopy({
      label: 'Caltrain Local Weekday 144',
      layerName: 'Rail',
      source: '511.org',
      latitude: 37.3736,
      longitude: -122.0149,
      properties: { vehicleId: '144', tripId: '1234', operator: 'Caltrain' },
    }),
    'Caltrain Local Weekday 144 · Trip 1234 · Rail (511.org) · 37.37360, -122.01490',
  );
});

test('a multi-word operator already in the label is not repeated after it', () => {
  // Caught in the browser: "Capitol Corridor CC 6965 · Trip 544 · Capitol
  // Corridor · ...". Single-token matching could not see the two-word operator.
  assert.equal(
    formatSelectionForCopy({
      label: 'Capitol Corridor CC 6965',
      layerName: 'Rail',
      source: '511.org',
      latitude: 37.65254,
      longitude: -122.08412,
      properties: { vehicleId: '6965', tripId: '544', operator: 'Capitol Corridor' },
    }),
    'Capitol Corridor CC 6965 · Trip 544 · Rail (511.org) · 37.65254, -122.08412',
  );
});

test('token dedup does not swallow an identifier that is merely a substring', () => {
  // "123" must survive a label containing "1234" — the guard is whole-word.
  const line = formatSelectionForCopy({
    label: 'Ship 1234',
    layerName: 'Live AIS Vessels',
    source: 'AISStream',
    latitude: 37.8,
    longitude: -122.4,
    properties: { mmsi: '123' },
  });
  assert.equal(line, 'Ship 1234 · MMSI 123 · Live AIS Vessels (AISStream) · 37.80000, -122.40000');
});

test('a record missing coordinates still copies its identity', () => {
  assert.equal(
    formatSelectionForCopy({ label: 'Bethel Island', layerName: 'Delta Levees', source: 'CA DWR' }),
    'Bethel Island · Delta Levees (CA DWR)',
  );
});

// ---------------------------------------------------------------------------
// Ctrl+C hotkey guards. The button already works; the hotkey is only safe if it
// stands down in every case where the browser had something of its own to copy.
// ---------------------------------------------------------------------------

/** A keydown landing on inert page chrome — the Cesium canvas, the body. */
const onCanvas = (overrides = {}) => ({
  key: 'c',
  ctrlKey: true,
  target: { isContentEditable: false, closest: () => null },
  ...overrides,
});

/** A node that reports itself inside a form control, as the search box would. */
const inField = { isContentEditable: false, closest: () => ({ tagName: 'INPUT' }) };

test('Ctrl+C over the map is claimed as the copy hotkey', () => {
  assert.equal(shouldHandleCopyHotkey(onCanvas()), true);
  // Uppercase arrives when Caps Lock is on; the shortcut is the same key.
  assert.equal(shouldHandleCopyHotkey(onCanvas({ key: 'C' })), true);
});

test('Cmd+C is claimed too, but never Ctrl+Cmd+C', () => {
  assert.equal(shouldHandleCopyHotkey(onCanvas({ ctrlKey: false, metaKey: true })), true);
  assert.equal(shouldHandleCopyHotkey(onCanvas({ ctrlKey: true, metaKey: true })), false);
});

test('a modified C belongs to the browser or another tool, not to us', () => {
  // Ctrl+Shift+C is the devtools element picker.
  assert.equal(shouldHandleCopyHotkey(onCanvas({ shiftKey: true })), false);
  assert.equal(shouldHandleCopyHotkey(onCanvas({ altKey: true })), false);
  // Bare C is the cockpit toggle in ui.js — taking it would break that.
  assert.equal(shouldHandleCopyHotkey(onCanvas({ ctrlKey: false })), false);
  assert.equal(shouldHandleCopyHotkey(onCanvas({ key: 'v' })), false);
});

test('a real text selection anywhere on the page keeps native copy', () => {
  assert.equal(shouldHandleCopyHotkey(onCanvas(), { selectionText: 'Fremont' }), false);
  // A collapsed caret stringifies to whitespace, which is not a selection.
  assert.equal(shouldHandleCopyHotkey(onCanvas(), { selectionText: '   ' }), true);
  assert.equal(shouldHandleCopyHotkey(onCanvas(), { selectionText: '' }), true);
});

test('the caret being in a field is checked independently of the selection', () => {
  // A caret sitting in the search box reports no selection at all, so this is
  // the case the selectionText check cannot see and the focus check must catch.
  assert.equal(shouldHandleCopyHotkey(onCanvas({ target: inField }), { selectionText: '' }), false);
  assert.equal(
    shouldHandleCopyHotkey(onCanvas(), { activeElement: inField, selectionText: '' }),
    false,
  );
  assert.equal(
    shouldHandleCopyHotkey(onCanvas({
      target: { isContentEditable: true, closest: () => null },
    })),
    false,
  );
});

test('an already-handled, repeating, or composing keydown is left alone', () => {
  assert.equal(shouldHandleCopyHotkey(onCanvas({ defaultPrevented: true })), false);
  // Held Ctrl+C would otherwise re-flash COPIED for as long as the key is down.
  assert.equal(shouldHandleCopyHotkey(onCanvas({ repeat: true })), false);
  assert.equal(shouldHandleCopyHotkey(onCanvas({ isComposing: true })), false);
  assert.equal(shouldHandleCopyHotkey(null), false);
});
