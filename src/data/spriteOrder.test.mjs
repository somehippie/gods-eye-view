import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPRITE_LAYER_ORDER,
  _resetSpriteOrderWarnings,
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
  unregisterSpriteCollection,
} from './spriteOrder.js';
import flightsLayer from './flights.js';
import aisLiveVesselsLayer from './aisLiveVessels.js';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';

const ORDER = ['cctv', 'firms', 'bikeshare', 'ais', 'military', 'flights'];

function makePrimitives(initial = []) {
  return {
    items: [...initial],
    calls: [],
    contains(collection) { return this.items.includes(collection); },
    raiseToTop(collection) {
      this.calls.push(collection.id);
      const index = this.items.indexOf(collection);
      if (index >= 0) this.items.splice(index, 1);
      this.items.push(collection);
    },
  };
}

function makeCollection(id, destroyed = false) {
  return { id, isDestroyed: () => destroyed };
}

test('restoreSpriteOrder raises live collections bottom-to-top and skips destroyed entries', () => {
  const collections = Object.fromEntries(ORDER.map((id) => [id, makeCollection(id)]));
  const destroyedFirms = makeCollection('firms', true);
  for (const id of ORDER) {
    registerSpriteCollection(id, id === 'firms' ? destroyedFirms : collections[id]);
  }
  const primitives = makePrimitives([
    collections.flights,
    collections.ais,
    collections.cctv,
    collections.bikeshare,
    collections.military,
  ]);

  restoreSpriteOrder({ scene: { primitives } });

  assert.deepEqual(primitives.calls, ['cctv', 'bikeshare', 'ais', 'military', 'flights']);
  assert.deepEqual(primitives.items.map((item) => item.id), [
    'cctv', 'bikeshare', 'ais', 'military', 'flights',
  ]);

  for (const id of ORDER) unregisterSpriteCollection(id);
});

test('late CCTV registration still restores flights above the ambient collection', () => {
  const flights = makeCollection('flights');
  const cctv = makeCollection('cctv');
  const primitives = makePrimitives([flights]);
  const viewer = { scene: { primitives } };

  registerSpriteCollection('flights', flights);
  restoreSpriteOrder(viewer);
  primitives.items.push(cctv); // CCTV enabled after flights: it starts on top.
  registerSpriteCollection('cctv', cctv);
  primitives.calls.length = 0;

  restoreSpriteOrder(viewer);

  assert.deepEqual(primitives.calls, ['cctv', 'flights']);
  assert.deepEqual(primitives.items.map((item) => item.id), ['cctv', 'flights']);

  unregisterSpriteCollection('cctv', cctv);
  unregisterSpriteCollection('flights', flights);
});

test('restoreSpriteOrder is inert for destroyed viewers and primitive collections', () => {
  const flights = makeCollection('flights');
  const primitives = makePrimitives([flights]);
  registerSpriteCollection('flights', flights);

  restoreSpriteOrder({ isDestroyed: () => true, scene: { primitives } });
  restoreSpriteOrder({ scene: { primitives: { ...primitives, isDestroyed: () => true } } });

  assert.deepEqual(primitives.calls, []);
  unregisterSpriteCollection('flights', flights);
});

test('restoreSpriteOrder never raises a registered collection absent from scene primitives', () => {
  const flights = makeCollection('flights');
  const primitives = makePrimitives([]);
  registerSpriteCollection('flights', flights);

  restoreSpriteOrder({ scene: { primitives } });

  assert.deepEqual(primitives.calls, []);
  assert.deepEqual(primitives.items, []);
  unregisterSpriteCollection('flights', flights);
});

test('flights, AIS, and FIRMS enable paths are wired through the shared sprite restorer', () => {
  const viewer = { id: 'viewer' };
  const calls = [];
  const restoreSpy = (value) => calls.push(value);
  for (const layerId of ['flights', 'ais', 'firms']) {
    restoreSpriteOrderOnEnable(layerId, viewer, restoreSpy);
  }
  assert.deepEqual(calls, [viewer, viewer, viewer]);

  const firmsLayer = createFirmsHeatmapLayer({ id: 'firms', name: 'FIRMS' });
  assert.match(flightsLayer.enable.toString(), /restoreSpriteOrderOnEnable\('flights', viewer\)/);
  assert.match(aisLiveVesselsLayer.enable.toString(), /restoreSpriteOrderOnEnable\('ais', activeViewer\)/);
  assert.match(firmsLayer.enable.toString(), /restoreSpriteOrderOnEnable\('firms', viewer\)/);
  assert.match(
    createFirmsHeatmapLayer.toString(),
    /registerSpriteCollection\('firms', _billboards\);\s*restoreSpriteOrder\(_viewer\);/,
    'lazy FIRMS registration must restore order immediately',
  );
});

// ---------------------------------------------------------------------------
// An id this module cannot act on is a mistake, and must say so.
//
// Both entry points used to take an unlisted id and quietly do nothing. That
// is the same silent-registry-miss shape that already cost this project a
// count chip stuck at "—" for a layer reporting stats under a name the manager
// never calls, and it hid a dead ordering call in transitVehicles.js.
// ---------------------------------------------------------------------------

/** Capture console.warn for the duration of one call. */
function captureWarnings(run) {
  const warnings = [];
  const real = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try { run(); } finally { console.warn = real; }
  return warnings;
}

test('registering a collection under an unlisted id says so instead of no-opping', () => {
  _resetSpriteOrderWarnings();
  const collection = { id: 'ghost' };
  const warnings = captureWarnings(() => registerSpriteCollection('not-a-sprite-layer', collection));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /registerSpriteCollection\('not-a-sprite-layer'\) does nothing/);
  // The message has to name the remedy, not just the symptom.
  assert.match(warnings[0], /SPRITE_LAYER_ORDER/);
  assert.match(warnings[0], /drop the call/);
  unregisterSpriteCollection('not-a-sprite-layer', collection);
});

test('an unlisted enable path warns too — the third instance of the same miss', () => {
  _resetSpriteOrderWarnings();
  let restored = 0;
  const warnings = captureWarnings(() => {
    restoreSpriteOrderOnEnable('not-a-sprite-layer', {}, () => { restored += 1; });
  });
  assert.equal(restored, 0, 'an unlisted id must still not reorder anything');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /restoreSpriteOrderOnEnable\('not-a-sprite-layer'\)/);
});

test('the warning fires once per site, so an enable loop cannot spam the console', () => {
  _resetSpriteOrderWarnings();
  const warnings = captureWarnings(() => {
    for (let i = 0; i < 5; i += 1) restoreSpriteOrderOnEnable('not-a-sprite-layer', {}, () => {});
  });
  assert.equal(warnings.length, 1);
});

test('a listed id stays silent and still reorders', () => {
  _resetSpriteOrderWarnings();
  let restored = 0;
  const warnings = captureWarnings(() => {
    for (const layerId of SPRITE_LAYER_ORDER) {
      restoreSpriteOrderOnEnable(layerId, {}, () => { restored += 1; });
    }
  });
  assert.deepEqual(warnings, []);
  assert.equal(restored, SPRITE_LAYER_ORDER.length);
});
