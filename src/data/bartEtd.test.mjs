import test from 'node:test';
import assert from 'node:assert/strict';
import {
  departureBoard,
  mergeStationDepartures,
  nextDepartureSummary,
  normalizeDepartures,
  normalizeStations,
  parseMinutes,
  stationColor,
} from './bartEtd.js';
import { formatSelectionForCopy } from '../copySelection.js';

const stnPayload = {
  root: {
    stations: {
      station: [
        { abbr: 'BAYF', name: 'Bay Fair', gtfs_latitude: '37.696924', gtfs_longitude: '-122.126514' },
        { abbr: 'COLM', name: 'Colma', gtfs_latitude: '37.684638', gtfs_longitude: '-122.466233' },
        { abbr: 'RICH', name: 'Richmond', gtfs_latitude: '37.936853', gtfs_longitude: '-122.353099' },
      ],
    },
  },
};

const estimate = (over = {}) => ({
  minutes: '4', platform: '1', direction: 'South', length: '6',
  color: 'ORANGE', hexcolor: '#ff9933', bikeflag: '1', delay: '0',
  cancelflag: '0', dynamicflag: '0', ...over,
});

const etdPayload = {
  root: {
    station: [{
      name: 'Bay Fair', abbr: 'BAYF',
      etd: [
        {
          destination: 'Berryessa', abbreviation: 'BERY', limited: '0',
          estimate: [estimate({ minutes: '27' }), estimate({ minutes: 'Leaving', delay: '162' })],
        },
        {
          destination: 'Dublin/Pleasanton', abbreviation: 'DUBL', limited: '0',
          estimate: [estimate({ minutes: '12', color: 'BLUE', hexcolor: '#0099cc', platform: '2' })],
        },
      ],
    }],
    // COLM and RICH are absent — that is how BART says "no service right now".
  },
};

test('a station list becomes map geography', () => {
  const stations = normalizeStations(stnPayload);
  assert.equal(stations.length, 3);
  assert.deepEqual(stations[0], {
    code: 'BAYF', name: 'Bay Fair', latitude: 37.696924, longitude: -122.126514,
  });
});

test('a station without a code, name or fix is not geography', () => {
  const stations = normalizeStations({ root: { stations: { station: [
    { abbr: '', name: 'Nameless', gtfs_latitude: '1', gtfs_longitude: '2' },
    { abbr: 'AAA', name: '', gtfs_latitude: '1', gtfs_longitude: '2' },
    { abbr: 'BBB', name: 'No fix', gtfs_latitude: '', gtfs_longitude: '2' },
    { abbr: 'CCC', name: 'Fine', gtfs_latitude: '3', gtfs_longitude: '4' },
  ] } } });
  assert.deepEqual(stations.map((s) => s.code), ['CCC']);
});

test('"Leaving" parses as zero minutes but stays distinguishable from "0 min"', () => {
  // A board reading "Leaving" and one reading "0 min" say different things to
  // someone standing on the platform.
  assert.deepEqual(parseMinutes('Leaving'), { minutes: 0, leaving: true });
  assert.deepEqual(parseMinutes('0'), { minutes: 0, leaving: false });
  assert.deepEqual(parseMinutes('27'), { minutes: 27, leaving: false });
});

test('a missing or nonsense estimate is dropped, not coerced to zero', () => {
  // Number(null) is 0, which would put a phantom train on the platform now.
  assert.equal(parseMinutes(null), null);
  assert.equal(parseMinutes(''), null);
  assert.equal(parseMinutes('soon'), null);
  assert.equal(parseMinutes('-3'), null);
});

test('departures sort soonest first, with Leaving ahead of every number', () => {
  const byStation = normalizeDepartures(etdPayload);
  const bayf = byStation.get('BAYF');
  assert.deepEqual(bayf.map((d) => (d.leaving ? 'Leaving' : d.minutes)), ['Leaving', 12, 27]);
});

test('delay is read as seconds, which is the unit BART sends', () => {
  const [leaving] = normalizeDepartures(etdPayload).get('BAYF');
  assert.equal(leaving.delaySeconds, 162);
  assert.equal(leaving.cars, 6);
  assert.equal(leaving.bikes, true);
  assert.equal(leaving.cancelled, false);
});

test('a station BART omitted still reaches the map, with no departures', () => {
  // BART omits a station from ETD entirely when it has no service: 44 of 50
  // reported at 00:49 PDT, 7 at 01:49, none overnight. Hiding them would erase
  // most of the system at 2am — a station is geography, not a vehicle.
  const merged = mergeStationDepartures(normalizeStations(stnPayload), normalizeDepartures(etdPayload));
  assert.equal(merged.length, 3);
  assert.equal(merged.find((s) => s.code === 'BAYF').departures.length, 3);
  assert.deepEqual(merged.find((s) => s.code === 'COLM').departures, []);
  assert.deepEqual(merged.find((s) => s.code === 'RICH').departures, []);
});

test('a station takes the colour of its soonest running departure', () => {
  const merged = mergeStationDepartures(normalizeStations(stnPayload), normalizeDepartures(etdPayload));
  assert.equal(stationColor(merged.find((s) => s.code === 'BAYF')), '#ff9933');
  // Nothing departing means no colour, which the renderer draws dimmed.
  assert.equal(stationColor(merged.find((s) => s.code === 'COLM')), null);
});

test('a cancelled run never lends the station its colour', () => {
  // Advertising a colour for a train that is not coming is worse than dimming.
  const cancelled = normalizeDepartures({ root: { station: [{
    abbr: 'BAYF',
    etd: [{
      destination: 'Berryessa', abbreviation: 'BERY',
      estimate: [
        estimate({ minutes: '2', cancelflag: '1', hexcolor: '#ff9933' }),
        estimate({ minutes: '9', hexcolor: '#0099cc' }),
      ],
    }],
  }] } });
  const station = { code: 'BAYF', departures: cancelled.get('BAYF') };
  assert.equal(stationColor(station), '#0099cc');
});

test('the board carries each row its own colour, so lines stay distinguishable', () => {
  // One Cesium label has one fill colour, so a combined multi-line label could
  // not show per-line colours — the renderer needs rows, not a blob of text.
  const merged = mergeStationDepartures(normalizeStations(stnPayload), normalizeDepartures(etdPayload));
  const rows = departureBoard(merged.find((s) => s.code === 'BAYF'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.hexColor), ['#ff9933', '#0099cc', '#ff9933']);
  assert.match(rows[0].text, /^Leaving\s+Berryessa \(plat 1, 6 car, \+3m late\)$/);
  assert.match(rows[1].text, /^12 min\s+Dublin\/Pleasanton \(plat 2, 6 car\)$/);
});

test('the board is capped, so a busy station cannot run off the screen', () => {
  const many = Array.from({ length: 20 }, (_, i) => estimate({ minutes: String(i + 1) }));
  const departures = normalizeDepartures({ root: { station: [{
    abbr: 'BAYF', etd: [{ destination: 'Berryessa', abbreviation: 'BERY', estimate: many }],
  }] } });
  const station = { code: 'BAYF', departures: departures.get('BAYF') };
  assert.equal(departureBoard(station).length, 8);
  assert.equal(departureBoard(station, 3).length, 3);
});

test('a closed station renders an empty board rather than throwing', () => {
  assert.deepEqual(departureBoard({ code: 'COLM', departures: [] }), []);
  assert.deepEqual(departureBoard(null), []);
  assert.equal(nextDepartureSummary({ departures: [] }), null);
  assert.equal(stationColor(null), null);
});

test('BART returns a bare object where a single-element array is expected', () => {
  // Defensive: their XML-to-JSON conversion arrays these consistently in the
  // measured ALL-station payload, but a single-station query need not.
  const byStation = normalizeDepartures({ root: { station: {
    abbr: 'BAYF',
    etd: { destination: 'Berryessa', abbreviation: 'BERY', estimate: estimate({ minutes: '5' }) },
  } } });
  assert.equal(byStation.get('BAYF').length, 1);
  assert.equal(byStation.get('BAYF')[0].minutes, 5);
});

test('the copy button identifies a station, and says when the next train goes', () => {
  const merged = mergeStationDepartures(normalizeStations(stnPayload), normalizeDepartures(etdPayload));
  const station = merged.find((s) => s.code === 'BAYF');
  const line = formatSelectionForCopy({
    id: `bart-${station.code}`,
    layerId: 'bart-departures',
    layerName: 'BART Departures',
    source: 'api.bart.gov',
    label: `${station.name} Station`,
    latitude: station.latitude,
    longitude: station.longitude,
    properties: {
      stationCode: station.code,
      nextDeparture: nextDepartureSummary(station),
      departures: station.departures.length,
    },
  });
  assert.equal(
    line,
    'Bay Fair Station · Berryessa Leaving · Station BAYF · '
    + 'BART Departures (api.bart.gov) · 37.69692, -122.12651',
  );
});

test('a closed station still copies as an identifiable place', () => {
  const merged = mergeStationDepartures(normalizeStations(stnPayload), normalizeDepartures(etdPayload));
  const station = merged.find((s) => s.code === 'COLM');
  const line = formatSelectionForCopy({
    id: `bart-${station.code}`,
    layerId: 'bart-departures',
    layerName: 'BART Departures',
    source: 'api.bart.gov',
    label: `${station.name} Station`,
    latitude: station.latitude,
    longitude: station.longitude,
    properties: {
      stationCode: station.code,
      nextDeparture: nextDepartureSummary(station),
      departures: 0,
    },
  });
  // No departure segment, and no empty separator where it would have been.
  assert.equal(
    line,
    'Colma Station · Station COLM · BART Departures (api.bart.gov) · 37.68464, -122.46623',
  );
});

test('the ETD url carries orig, without which BART answers 400', async () => {
  // THIS IS THE TEST THAT WAS MISSING. A first version of the proxy built the
  // ETD url with only cmd/key/json. Every normalizer test still passed and the
  // layer was dead end to end: BART answers 400 "Invalid orig" rather than
  // defaulting. Verified against the live API before writing this.
  const { bartUrlFor } = await import('./bartEtd.js');
  const etd = bartUrlFor('etd.aspx', 'etd', 'KEY', { orig: 'ALL' });
  assert.equal(etd.searchParams.get('orig'), 'ALL');
  assert.equal(etd.searchParams.get('cmd'), 'etd');
  assert.equal(etd.searchParams.get('json'), 'y');
  assert.equal(etd.origin + etd.pathname, 'https://api.bart.gov/api/etd.aspx');
});

test('the station url needs no orig, and does not invent one', async () => {
  const { bartUrlFor } = await import('./bartEtd.js');
  const stns = bartUrlFor('stn.aspx', 'stns', 'KEY');
  assert.equal(stns.searchParams.get('orig'), null);
  assert.equal(stns.searchParams.get('cmd'), 'stns');
});

test('the key is never interpolated into the path, only the query', async () => {
  const { bartUrlFor } = await import('./bartEtd.js');
  const url = bartUrlFor('etd.aspx', 'etd', 'MW9S-E7SL-26DU-VV8V', { orig: 'ALL' });
  assert.equal(url.pathname, '/api/etd.aspx');
  assert.equal(url.searchParams.get('key'), 'MW9S-E7SL-26DU-VV8V');
});
