import test from 'node:test';
import assert from 'node:assert/strict';
import bartDeparturesLayer from './bartDepartures.js';
import { normalizeLayerLoading } from '../loadingFeedback.js';
import { _resetCapabilityGateForTest, isCapabilityAvailable } from '../capabilityGate.js';

test('the layer reports through getStats, which is the name the manager calls', () => {
  assert.equal(typeof bartDeparturesLayer.getStats, 'function');
  assert.equal(bartDeparturesLayer.getStatus, undefined);
  const stats = bartDeparturesLayer.getStats();
  assert.equal(typeof stats.count, 'number');
  assert.ok('lastUpdate' in stats && 'loading' in stats);
});

test('the layer needs no key, so it never reports KEY REQUIRED', () => {
  // BART_API_KEY is preferred but optional — the proxy falls back to BART's
  // published public key, so an unconfigured install is a working install.
  const stats = bartDeparturesLayer.getStats();
  assert.equal(stats.keyRequired, undefined);
  const normalized = normalizeLayerLoading({
    id: 'bart-departures', name: 'BART Departures', enabled: true, lifecycleState: 'enabled', stats,
  });
  assert.equal(normalized.keyRequired, false);
  assert.equal(normalized.degraded, false);
  assert.equal(normalized.error, null);
});

test('the layer id matches the one the registry and context records use', () => {
  assert.equal(bartDeparturesLayer.id, 'bart-departures');
});

test('the layer icon is not a BART trademark', () => {
  // BART's licence forbids its trademarks and copyrighted materials in
  // association with the data. A generic station glyph is neither.
  assert.equal(bartDeparturesLayer.icon, '\u{1F689}');
});

test('a disabled layer does not poll, so a hidden layer costs nothing upstream', async () => {
  _resetCapabilityGateForTest();
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; throw new Error('should not be called'); };
  try {
    await bartDeparturesLayer.update();
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the capability gate is consulted, so a latched layer stops asking', async () => {
  // The contract the user asked for: one message, then silence. Once latched,
  // update() must not reach the network at all.
  _resetCapabilityGateForTest();
  const { markCapabilityUnavailable } = await import('../capabilityGate.js');
  markCapabilityUnavailable('BART departures', 'HTTP 503', 'set BART_API_KEY');
  assert.equal(isCapabilityAvailable('BART departures'), false);

  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; throw new Error('should not be called'); };
  try {
    // enable() calls update(); the gate must short-circuit before fetch.
    await bartDeparturesLayer.enable();
    assert.equal(fetched, 0, 'latched capability must not reach the network');
  } finally {
    globalThis.fetch = realFetch;
    bartDeparturesLayer.disable();
    _resetCapabilityGateForTest();
  }
});
