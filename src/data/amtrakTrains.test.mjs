import test from 'node:test';
import assert from 'node:assert/strict';
import amtrakTrainsLayer from './amtrakTrains.js';
import { normalizeAmtrakTrains, runningTrains, trainLabel } from './amtrakFeed.js';
import { formatSelectionForCopy } from '../copySelection.js';
import { normalizeLayerLoading } from '../loadingFeedback.js';

test('the layer reports through getStats, which is the name the manager calls', () => {
  // getStatus() was silently never read on the rail layer and its count
  // chip sat at "—" forever. Asserting the absence keeps the rename from
  // coming back by habit.
  assert.equal(typeof amtrakTrainsLayer.getStats, 'function');
  assert.equal(amtrakTrainsLayer.getStatus, undefined);
  const stats = amtrakTrainsLayer.getStats();
  assert.equal(typeof stats.count, 'number');
  assert.ok('lastUpdate' in stats && 'loading' in stats);
});

test('the layer needs no key, so it never reports KEY REQUIRED', () => {
  // Unlike the 511 layer there is no token, so an empty layer is an empty
  // layer — it must not render as unconfigured or as degraded.
  const stats = amtrakTrainsLayer.getStats();
  assert.equal(stats.keyRequired, undefined);
  const normalized = normalizeLayerLoading({
    id: 'amtrak-trains', name: 'Amtrak', enabled: true, lifecycleState: 'enabled', stats,
  });
  assert.equal(normalized.keyRequired, false);
  assert.equal(normalized.degraded, false);
  assert.equal(normalized.error, null);
});

test('the layer id matches the one the registry and context records use', () => {
  assert.equal(amtrakTrainsLayer.id, 'amtrak-trains');
});

test('a selected train copies as an identifiable line with no repeated operator', () => {
  // The layer deliberately omits `operator: 'Amtrak'` from its context
  // properties: `operator` IS in copySelection's IDENTIFIER_KEYS and layerName
  // is already "Amtrak", so carrying it renders Amtrak twice.
  const [train] = runningTrains(normalizeAmtrakTrains({
    1: [{
      trainID: '1-9', trainNum: '1', routeName: 'Sunset Limited',
      lat: 29.413544, lon: -98.477752, heading: 'S', velocity: 53,
      trainState: 'Active', trainTimely: 'On Time',
      origCode: 'NOL', destCode: 'LAX', iconColor: '#2a893d',
      updatedAt: new Date().toISOString(),
    }],
  }), Date.now());

  const line = formatSelectionForCopy({
    id: `amtrak-${train.id}`,
    layerId: 'amtrak-trains',
    layerName: 'Amtrak',
    source: 'Amtrak via amtraker.com',
    label: trainLabel(train),
    latitude: train.latitude,
    longitude: train.longitude,
    properties: {
      trainNumber: train.trainNumber,
      route: train.routeName,
      origin: train.originCode,
      destination: train.destinationCode,
      status: train.timely,
    },
  });

  assert.equal(line, 'Sunset Limited 1 · Amtrak (Amtrak via amtraker.com) · 29.41354, -98.47775');
  assert.equal(line.match(/Amtrak/g).length, 2, 'layer name and source, not a third copy');
});
