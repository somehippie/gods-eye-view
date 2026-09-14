import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FIX_AGE_MS,
  normalizeAmtrakTrains,
  parseFixTime,
  runningTrains,
  trainLabel,
} from './amtrakFeed.js';

const NOW = Date.UTC(2026, 8, 10, 8, 0, 0);
const isoAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

/** One raw row in the shape the mirror actually publishes. */
const rawTrain = (over = {}) => ({
  trainID: '1-9',
  trainNum: '1',
  routeName: 'Sunset Limited',
  lat: 29.413544907950257,
  lon: -98.47775282440864,
  heading: 'S',
  velocity: 9.811448097229,
  trainState: 'Active',
  trainTimely: 'On Time',
  origCode: 'NOL',
  destCode: 'LAX',
  iconColor: '#2a893d',
  updatedAt: isoAgo(3),
  ...over,
});

test('the payload is an object of arrays, and every instance survives it', () => {
  // Measured: 59 objects across 45 train-number keys — one number can carry
  // several running instances, so flattening by key would lose trains.
  const trains = normalizeAmtrakTrains({
    1: [rawTrain(), rawTrain({ trainID: '1-10', updatedAt: isoAgo(1) })],
    3: [rawTrain({ trainID: '3-8', trainNum: '3', routeName: 'Southwest Chief' })],
  });
  assert.deepEqual(trains.map((t) => t.id), ['1-9', '1-10', '3-8']);
});

test('a bare object where an array was expected is still read', () => {
  // Defensive rather than observed: the measured payload always nests an array.
  assert.equal(normalizeAmtrakTrains({ 1: rawTrain() }).length, 1);
});

test('compass text becomes degrees, because the feed never sends degrees', () => {
  const headings = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const got = headings.map((h) => normalizeAmtrakTrains({ 1: [rawTrain({ heading: h })] })[0].heading);
  assert.deepEqual(got, [0, 45, 90, 135, 180, 225, 270, 315]);
});

test('an unreadable heading is null rather than NaN', () => {
  const [train] = normalizeAmtrakTrains({ 1: [rawTrain({ heading: 'sideways' })] });
  assert.equal(train.heading, null);
  assert.equal(train.headingText, 'sideways');
});

test('a row without an id or a position is never normalized', () => {
  const trains = normalizeAmtrakTrains({
    1: [
      rawTrain({ trainID: null }),
      rawTrain({ trainID: '2-1', lat: null }),
      rawTrain({ trainID: '3-1', lon: 'not a number' }),
      rawTrain({ trainID: '4-1' }),
    ],
  });
  assert.deepEqual(trains.map((t) => t.id), ['4-1']);
});

test('a position that is real-looking but impossible is dropped, including 0,0', () => {
  // The guard this module used to carry warned that a null lat "renders a train
  // in the Gulf of Guinea" — 0,0 — but only stopped null coercing to zero. Two
  // GENUINE zeros still passed it. coordinateField rejects the null island and
  // range-checks besides, so these four rows are all unrenderable.
  const trains = normalizeAmtrakTrains({
    1: [
      rawTrain({ trainID: 'nullisland-1', lat: 0, lon: 0 }),
      rawTrain({ trainID: 'lat-oob-1', lat: 91, lon: -98.4 }),
      rawTrain({ trainID: 'lon-oob-1', lat: 29.4, lon: 181 }),
      rawTrain({ trainID: 'good-1' }),
    ],
  });
  assert.deepEqual(trains.map((t) => t.id), ['good-1']);
});

test('a missing timestamp parses to null, never to NaN', () => {
  // A NaN here once reached a Math.max and reported epoch seconds as a fix age.
  assert.equal(parseFixTime(null), null);
  assert.equal(parseFixTime(''), null);
  assert.equal(parseFixTime('not a date'), null);
  assert.equal(parseFixTime('2026-09-10T03:50:45-04:00'), 1789026645000);
});

test('a Predeparture train is dropped, because its position was never observed', () => {
  // Measured twice: null updatedAt correlates EXACTLY with Predeparture, 9 of 9
  // both times, and zero nulls in any other state. Its coordinates are a
  // scheduled origin, so drawing it would put an un-observed dot on the map.
  const trains = normalizeAmtrakTrains({
    1: [
      rawTrain({ trainID: '1-1', trainState: 'Predeparture', updatedAt: null }),
      rawTrain({ trainID: '1-2' }),
    ],
  });
  assert.deepEqual(runningTrains(trains, NOW).map((t) => t.id), ['1-2']);
});

test('a Completed run is dropped even when its fix is recent', () => {
  const trains = normalizeAmtrakTrains({
    1: [rawTrain({ trainID: '1-1', trainState: 'Completed', updatedAt: isoAgo(1) })],
  });
  assert.deepEqual(runningTrains(trains, NOW), []);
});

test('a stale fix is dropped, and the threshold is a parameter', () => {
  const trains = normalizeAmtrakTrains({
    1: [
      rawTrain({ trainID: '1-1', updatedAt: isoAgo(5) }),
      rawTrain({ trainID: '1-2', updatedAt: isoAgo(45) }),
    ],
  });
  assert.deepEqual(runningTrains(trains, NOW).map((t) => t.id), ['1-1']);
  // Measured p99 fix age was 9.8 min, so 20 min is about twice the worst case.
  assert.equal(MAX_FIX_AGE_MS, 20 * 60_000);
  assert.equal(runningTrains(trains, NOW, 60 * 60_000).length, 2);
  assert.equal(runningTrains(trains, NOW, 60_000).length, 0);
});

test('runningTrains tolerates a missing or malformed payload', () => {
  assert.deepEqual(normalizeAmtrakTrains(null), []);
  assert.deepEqual(normalizeAmtrakTrains('nope'), []);
  assert.deepEqual(runningTrains(undefined, NOW), []);
  assert.deepEqual(runningTrains([null, undefined], NOW), []);
});

test('a train is labelled by its route, then its number', () => {
  assert.equal(trainLabel({ routeName: 'Sunset Limited', trainNumber: '1' }), 'Sunset Limited 1');
});

test('a label never repeats a part it already carries', () => {
  assert.equal(trainLabel({ routeName: 'Acela 2150', trainNumber: '2150' }), 'Acela 2150');
});

test('a train with nothing to say still gets a name', () => {
  assert.equal(trainLabel({}), 'Amtrak train');
  assert.equal(trainLabel(null), 'Amtrak train');
});
