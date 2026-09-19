import test from 'node:test';
import assert from 'node:assert/strict';
import transitVehiclesLayer, { freshVehicles, vehicleLabel } from './transitVehicles.js';
import { normalizeLayerLoading } from '../loadingFeedback.js';

const NOW = 1788998868000;
const at = (secondsAgo) => Math.floor(NOW / 1000) - secondsAgo;

test('a vehicle is labelled by its line, not by its fleet number', () => {
  assert.equal(
    vehicleLabel({ agencyName: 'Caltrain', routeId: 'Local Weekday', vehicleId: '144' }),
    'Caltrain Local Weekday 144',
  );
  assert.equal(
    vehicleLabel({ agencyName: 'Capitol Corridor', routeId: 'CC', label: '2102', vehicleId: '2102' }),
    'Capitol Corridor CC 2102',
  );
});

test('a label never repeats a part it already carries', () => {
  assert.equal(
    vehicleLabel({ agencyName: 'SMART', routeId: 'SMART', vehicleId: 'SMART' }),
    'SMART',
  );
});

test('a vehicle with nothing to say still gets a name rather than an empty label', () => {
  assert.equal(vehicleLabel({}), 'Transit vehicle');
});

test('a stale fix is dropped so parked stock does not haunt the map', () => {
  const vehicles = [
    { id: 'CT:144', latitude: 37.4, longitude: -122.1, timestamp: at(20) },
    { id: 'CT:145', latitude: 37.5, longitude: -122.2, timestamp: at(30 * 60) },
  ];
  assert.deepEqual(freshVehicles(vehicles, NOW).map((v) => v.id), ['CT:144']);
});

test('a vehicle with no timestamp is kept, because some operators never send one', () => {
  // SMART and LAVTA publish position without a per-vehicle timestamp. Treating
  // a missing timestamp as infinitely old would silently empty those agencies.
  const vehicles = [{ id: 'SA:SMRT0101', latitude: 38.06, longitude: -122.53, timestamp: null }];
  assert.equal(freshVehicles(vehicles, NOW).length, 1);
});

test('a vehicle without an id or a fix is never rendered', () => {
  const vehicles = [
    { id: null, latitude: 37.4, longitude: -122.1, timestamp: at(5) },
    { id: 'CT:1', latitude: Number.NaN, longitude: -122.1, timestamp: at(5) },
    { id: 'CT:2', latitude: 37.4, longitude: undefined, timestamp: at(5) },
    { id: 'CT:3', latitude: 37.4, longitude: -122.1, timestamp: at(5) },
  ];
  assert.deepEqual(freshVehicles(vehicles, NOW).map((v) => v.id), ['CT:3']);
});

test('freshVehicles tolerates a missing or malformed payload', () => {
  assert.deepEqual(freshVehicles(undefined, NOW), []);
  assert.deepEqual(freshVehicles([null, undefined], NOW), []);
});

test('the staleness threshold is a parameter, not a magic constant', () => {
  const vehicles = [{ id: 'CT:1', latitude: 37.4, longitude: -122.1, timestamp: at(120) }];
  assert.equal(freshVehicles(vehicles, NOW, 60_000).length, 0);
  assert.equal(freshVehicles(vehicles, NOW, 300_000).length, 1);
});

test('the layer reports through getStats, which is the name the manager calls', () => {
  // getStatus() was silently never read: DataLayerManager calls getStats(), so
  // the count chip would have sat at "—" forever.
  assert.equal(typeof transitVehiclesLayer.getStats, 'function');
  assert.equal(transitVehiclesLayer.getStatus, undefined);
  const stats = transitVehiclesLayer.getStats();
  assert.equal(typeof stats.count, 'number');
  assert.ok('lastUpdate' in stats && 'loading' in stats);
});

test('a missing token reads as KEY REQUIRED, not as a failed layer', () => {
  const asLayer = (stats) => ({
    id: 'transit-vehicles', name: 'Rail & Ferry', enabled: true, lifecycleState: 'enabled', stats,
  });
  // What the layer used to report: an ordinary error, which reads as degraded.
  const asError = normalizeLayerLoading(asLayer({ count: 0, error: 'no_key' }));
  assert.equal(asError.keyRequired, false);
  assert.equal(asError.degraded, true);
  // What it reports now.
  const asKeyless = normalizeLayerLoading(asLayer({ count: 0, keyRequired: true }));
  assert.equal(asKeyless.keyRequired, true);
  assert.equal(asKeyless.degraded, false);
  assert.equal(asKeyless.error, null);
});
