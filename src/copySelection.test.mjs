import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSelectionForCopy } from './copySelection.js';

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

test('a record missing coordinates still copies its identity', () => {
  assert.equal(
    formatSelectionForCopy({ label: 'Bethel Island', layerName: 'Delta Levees', source: 'CA DWR' }),
    'Bethel Island · Delta Levees (CA DWR)',
  );
});
