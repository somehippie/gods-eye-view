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

// Derived, not copied. This used to be a hand-written duplicate of
// SPRITE_LAYER_ORDER, and because it only SEEDS the fixtures, a layer added to
// the real list but not to this one would have been silently left out of every
// case below — the test would keep passing while covering less. The expected
// sequences in each assertion stay hard-coded: those are the actual pin.
const ORDER = SPRITE_LAYER_ORDER;

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
    collections['transit-vehicles'],
  ]);

  restoreSpriteOrder({ scene: { primitives } });

  assert.deepEqual(primitives.calls, [
    'cctv', 'bikeshare', 'ais', 'transit-vehicles', 'military', 'flights',
  ]);
  assert.deepEqual(primitives.items.map((item) => item.id), [
    'cctv', 'bikeshare', 'ais', 'transit-vehicles', 'military', 'flights',
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

test('every registerSpriteCollection call site in src/ names a listed layer', async () => {
  // The all-at-once check. The per-call warning above only fires when the code
  // actually runs; this fails in CI the moment a new layer registers under an
  // id SPRITE_LAYER_ORDER does not know, which is how transit-vehicles managed
  // to call a dead ordering path from the day it was written.
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      // Test files deliberately register bogus ids to prove the warning fires.
      if (/\.test\.mjs$/.test(entry) || entry === 'spriteOrder.js') continue;
      if (/\.(js|mjs)$/.test(entry)) files.push(full);
    }
  }(srcRoot));

  const offenders = [];
  let callSites = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/registerSpriteCollection\(\s*'([^']+)'/g)) {
      callSites += 1;
      if (!SPRITE_LAYER_ORDER.includes(match[1])) offenders.push(`${file}: '${match[1]}'`);
    }
  }

  assert.ok(callSites >= 6, `expected to find the real call sites, saw ${callSites}`);
  assert.deepEqual(offenders, [], `sprite ids not in SPRITE_LAYER_ORDER: ${offenders.join(', ')}`);
});
