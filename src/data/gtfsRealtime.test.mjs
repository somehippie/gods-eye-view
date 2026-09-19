import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RAIL_AGENCIES,
  agencyOf,
  decodeVehiclePositions,
  railOnly,
  readMessage,
} from './gtfsRealtime.js';

// ---------------------------------------------------------------------------
// A minimal protobuf ENCODER, used only here.
//
// The decoder is worth testing against bytes built to the spec rather than
// against a captured fixture: a fixture proves it agrees with whatever 511 sent
// that afternoon, while these prove it agrees with GTFS-Realtime. The real
// captures are exercised separately.
// ---------------------------------------------------------------------------

const varint = (value) => {
  const out = [];
  let v = BigInt(value);
  do { const byte = Number(v & 0x7fn); v >>= 7n; out.push(v > 0n ? byte | 0x80 : byte); } while (v > 0n);
  return out;
};
const tag = (field, wire) => varint((BigInt(field) << 3n) | BigInt(wire));
const uint = (field, value) => [...tag(field, 0), ...varint(value)];
const bytes = (field, payload) => [...tag(field, 2), ...varint(payload.length), ...payload];
const text = (field, value) => bytes(field, [...Buffer.from(value, 'utf8')]);
const float = (field, value) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value);
  return [...tag(field, 5), ...b];
};

/** FeedHeader: 1=version 2=incrementality 3=timestamp */
const header = (ts) => bytes(1, [...text(1, '1.0'), ...uint(2, 0), ...uint(3, ts)]);
/** Position: 1=lat 2=lon 3=bearing 5=speed */
const position = ({ lat, lon, bearing, speed }) => bytes(2, [
  ...float(1, lat), ...float(2, lon),
  ...(bearing == null ? [] : float(3, bearing)),
  ...(speed == null ? [] : float(5, speed)),
]);
/** VehiclePosition inside a FeedEntity (#4). */
const vehicleEntity = (id, { trip = {}, pos, status, stopId, ts, vehicleId, label }) => bytes(2, [
  ...text(1, id),
  ...bytes(4, [
    ...bytes(1, [
      ...(trip.tripId == null ? [] : text(1, trip.tripId)),
      ...(trip.routeId == null ? [] : text(5, trip.routeId)),
    ]),
    ...position(pos),
    ...(status == null ? [] : uint(4, status)),
    ...(ts == null ? [] : uint(5, ts)),
    ...(stopId == null ? [] : text(7, stopId)),
    ...bytes(8, [...text(1, vehicleId), ...(label == null ? [] : text(2, label))]),
  ]),
]);
const feed = (ts, entities) => Buffer.from([...header(ts), ...entities.flat()]);

// ---------------------------------------------------------------------------

test('a vehicle decodes into the fields the map needs', () => {
  const buf = feed(1788998868, [vehicleEntity('42', {
    trip: { tripId: 'CT:144', routeId: 'CT:Local Weekday' },
    pos: { lat: 37.3736, lon: -122.0149, bearing: 315, speed: 21.5 },
    status: 2, stopId: 'CT:70211', ts: 1788998855, vehicleId: '144', label: 'CT144',
  })]);
  const { timestamp, entityCount, vehicles } = decodeVehiclePositions(buf);
  assert.equal(timestamp, 1788998868);
  assert.equal(entityCount, 1);
  assert.equal(vehicles.length, 1);
  const v = vehicles[0];
  assert.equal(v.agency, 'CT');
  assert.equal(v.vehicleId, '144');
  assert.equal(v.id, 'CT:144');
  assert.equal(v.label, 'CT144');
  // Agency prefixes are stripped off route/trip/stop so the ids match static GTFS.
  assert.equal(v.routeId, 'Local Weekday');
  assert.equal(v.tripId, '144');
  assert.equal(v.stopId, '70211');
  assert.equal(v.status, 'IN_TRANSIT_TO');
  assert.equal(v.timestamp, 1788998855);
  assert.ok(Math.abs(v.latitude - 37.3736) < 1e-4);
  assert.ok(Math.abs(v.longitude + 122.0149) < 1e-4);
  assert.ok(Math.abs(v.bearing - 315) < 1e-3);
});

test('the id is agency-scoped, because bare vehicle ids collide across operators', () => {
  // Measured on the live combined feed: 2,043 vehicles, only 1,926 distinct
  // bare ids. Keying on the bare id teleports a dot between two agencies.
  const buf = feed(1, [
    vehicleEntity('a', { trip: { routeId: 'CT:1' }, pos: { lat: 37.4, lon: -122.1 }, vehicleId: '1394' }),
    vehicleEntity('b', { trip: { routeId: '3D:371' }, pos: { lat: 38.0, lon: -121.8 }, vehicleId: '1394' }),
  ]);
  const { vehicles } = decodeVehiclePositions(buf);
  assert.deepEqual(vehicles.map((v) => v.id), ['CT:1394', '3D:1394']);
  assert.equal(new Set(vehicles.map((v) => v.id)).size, 2);
});

test('a single-agency feed carries no prefixes, so the caller supplies the agency', () => {
  const buf = feed(1, [vehicleEntity('a', {
    trip: { tripId: '144', routeId: 'Local Weekday' },
    pos: { lat: 37.4, lon: -122.1 }, vehicleId: '144',
  })]);
  assert.equal(decodeVehiclePositions(buf).vehicles[0].agency, null);
  const scoped = decodeVehiclePositions(buf, { fallbackAgency: 'CT' }).vehicles[0];
  assert.equal(scoped.agency, 'CT');
  assert.equal(scoped.id, 'CT:144');
});

test('agencyOf prefers a real prefix over the fallback', () => {
  assert.equal(agencyOf({ routeId: 'SB:SEA', tripId: null }, 'RG'), 'SB');
  assert.equal(agencyOf({ routeId: null, tripId: 'AM:543' }, 'RG'), 'AM');
  assert.equal(agencyOf({ routeId: null, tripId: null }, 'CT'), 'CT');
  assert.equal(agencyOf({ routeId: null, tripId: null }), null);
});

test('an empty feed is data, not an error — this is exactly what BART returns', () => {
  // api.bart.gov and 511 both answer 200 with a 15-byte header and no
  // entities. Throwing here would turn "BART publishes no positions" into a
  // layer-wide failure.
  const buf = feed(1788997510, []);
  assert.equal(buf.length, 15);
  const decoded = decodeVehiclePositions(buf);
  assert.deepEqual(decoded.vehicles, []);
  assert.equal(decoded.entityCount, 0);
  assert.equal(decoded.timestamp, 1788997510);
});

test('entities that are not vehicle positions are skipped, not mistaken for them', () => {
  // A TripUpdate lives at FeedEntity #3 — the shape BART's feed is made of.
  const tripUpdateOnly = bytes(2, [...text(1, 'tu'), ...bytes(3, [...bytes(1, [...text(1, '101162610')])])]);
  const buf = feed(1, [
    tripUpdateOnly,
    vehicleEntity('v', { trip: { routeId: 'CE:ACE' }, pos: { lat: 37.7, lon: -121.5 }, vehicleId: '3111' }),
  ]);
  const { entityCount, vehicles } = decodeVehiclePositions(buf);
  assert.equal(entityCount, 2);
  assert.deepEqual(vehicles.map((v) => v.id), ['CE:3111']);
});

test('a vehicle with no usable fix is dropped rather than drawn at null island', () => {
  const buf = feed(1, [
    vehicleEntity('z', { trip: { routeId: 'CT:1' }, pos: { lat: 0, lon: 0 }, vehicleId: 'zero' }),
    vehicleEntity('ok', { trip: { routeId: 'CT:1' }, pos: { lat: 37.4, lon: -122.1 }, vehicleId: 'fine' }),
  ]);
  assert.deepEqual(decodeVehiclePositions(buf).vehicles.map((v) => v.vehicleId), ['fine']);
});

test('optional telemetry is absent rather than zero when the operator omits it', () => {
  // Caltrain publishes position and timestamp but no bearing, speed or status.
  // Defaulting those to 0 would point every train due north at a standstill.
  const buf = feed(1, [vehicleEntity('a', {
    trip: { routeId: 'CT:Local Weekday' }, pos: { lat: 37.4, lon: -122.1 }, vehicleId: '144',
  })]);
  const v = decodeVehiclePositions(buf).vehicles[0];
  assert.equal(v.bearing, null);
  assert.equal(v.speed, null);
  assert.equal(v.status, null);
  assert.equal(v.stopId, null);
});

test('rail filtering drops the buses and names what it keeps', () => {
  const vehicles = [
    { agency: 'CT', vehicleId: '144' }, { agency: 'AC', vehicleId: '6111' },
    { agency: 'AM', vehicleId: '2102' }, { agency: 'SF', vehicleId: '1' },
    { agency: null, vehicleId: 'x' },
  ];
  const kept = railOnly(vehicles);
  assert.deepEqual(kept.map((v) => [v.agency, v.agencyName]), [
    ['CT', 'Caltrain'],
    ['AM', 'Capitol Corridor'],
  ]);
});

test('ferries are dropped, because AIS already draws every one of those boats', () => {
  // SF Bay Ferry's 15 vehicle ids are the boats' names, and all of them also
  // broadcast AIS. Carrying them here drew each boat twice, since nothing
  // dedupes between this layer and the AIS one.
  const ferries = [
    { agency: 'SB', vehicleId: 'Carina' },
    { agency: 'GF', vehicleId: 'x' },
    { agency: 'TF', vehicleId: 'y' },
  ];
  assert.deepEqual(railOnly(ferries), []);
  for (const id of ['SB', 'GF', 'TF']) assert.equal(RAIL_AGENCIES[id], undefined);
});

test('BART is deliberately not in the rail cohort, because it has no positions', () => {
  assert.equal(RAIL_AGENCIES.BA, undefined);
  assert.deepEqual(railOnly([{ agency: 'BA', vehicleId: 'x' }]), []);
});

test('a truncated payload is rejected instead of yielding invented fields', () => {
  const buf = feed(1, [vehicleEntity('a', {
    trip: { routeId: 'CT:1' }, pos: { lat: 37.4, lon: -122.1 }, vehicleId: '144',
  })]);
  assert.throws(() => decodeVehiclePositions(buf.subarray(0, buf.length - 3)), RangeError);
  // Wire types 3 and 4 are the deprecated groups; we cannot skip past them.
  assert.throws(() => readMessage(Uint8Array.from([...tag(1, 3)])), RangeError);
});

// ---------------------------------------------------------------------------
// Real captures. The synthetic cases above pin the decoder to the spec; these
// pin it to what 511 actually sends, which is not the same thing — Caltrain
// omits bearing, speed, status and stop_id entirely, and a decoder that
// defaulted those to 0 would point every train due north at a dead stop.
// ---------------------------------------------------------------------------

const fixture = (name) => fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name),
);

test('a real Caltrain capture decodes, and its absent telemetry stays absent', () => {
  const { timestamp, entityCount, vehicles } = decodeVehiclePositions(
    fixture('gtfs-rt-caltrain-vehicles.pb'),
    { fallbackAgency: 'CT' },
  );
  assert.equal(timestamp, 1789000795);
  assert.equal(entityCount, 16);
  assert.equal(vehicles.length, 16);
  // Single-agency feed: nothing is prefixed, so every id comes from the fallback.
  assert.ok(vehicles.every((v) => v.id.startsWith('CT:')));
  assert.equal(new Set(vehicles.map((v) => v.id)).size, 16);
  const first = vehicles[0];
  assert.equal(first.id, 'CT:146');
  assert.equal(first.routeId, 'Local Weekday');
  assert.equal(first.bearing, null);
  assert.equal(first.speed, null);
  assert.equal(first.status, null);
  assert.ok(Number.isFinite(first.timestamp));
  // Every train is inside the Bay Area, which catches a lat/lon swap or a
  // float misread far more reliably than an exact-coordinate assertion.
  assert.ok(vehicles.every((v) => v.latitude > 36 && v.latitude < 39.5));
  assert.ok(vehicles.every((v) => v.longitude > -123.5 && v.longitude < -120.5));
});

test('a real Capitol Corridor capture carries the telemetry Caltrain omits', () => {
  const { vehicles } = decodeVehiclePositions(
    fixture('gtfs-rt-capitol-corridor-vehicles.pb'),
    { fallbackAgency: 'AM' },
  );
  assert.equal(vehicles.length, 7);
  const withBearing = vehicles.filter((v) => Number.isFinite(v.bearing));
  assert.ok(withBearing.length > 0, 'expected at least one bearing');
  const sample = vehicles.find((v) => v.id === 'AM:6965');
  assert.equal(sample.routeId, 'CC');
  assert.equal(sample.status, 'INCOMING_AT');
  assert.ok(Number.isFinite(sample.speed));
  assert.equal(sample.stopId, '74422');
  assert.deepEqual(railOnly(vehicles).map((v) => v.agencyName)[0], 'Capitol Corridor');
});
