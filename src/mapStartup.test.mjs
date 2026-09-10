import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPhotorealisticTileset,
  selectMapStartupRoute,
} from './mapStartup.js';

function fakeCesium(outcomes = []) {
  const calls = [];
  return {
    calls,
    Ion: { defaultAccessToken: undefined },
    GoogleMaps: { defaultApiKey: undefined },
    async createGooglePhotorealistic3DTileset(options) {
      calls.push({
        options,
        googleKey: this.GoogleMaps.defaultApiKey,
        ionToken: this.Ion.defaultAccessToken,
      });
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

test('map startup route reflects the best configured provider', () => {
  assert.equal(selectMapStartupRoute({ googleApiKey: 'google', cesiumToken: 'ion' }), 'google-direct');
  assert.equal(selectMapStartupRoute({ cesiumToken: 'ion' }), 'google-ion');
  assert.equal(selectMapStartupRoute(), 'osm');
});

test('no credentials skip photoreal loading and preserve keyless startup', async () => {
  const Cesium = fakeCesium();
  const result = await loadPhotorealisticTileset(Cesium);
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(Cesium.calls.length, 0);
});

test('a direct Google key is preferred', async () => {
  const tileset = { id: 'direct' };
  const Cesium = fakeCesium([tileset]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-direct');
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
});

test('an ion-only setup loads the hosted Google 3D asset', async () => {
  const tileset = { id: 'ion' };
  const Cesium = fakeCesium([tileset]);
  const result = await loadPhotorealisticTileset(Cesium, { cesiumToken: 'ion-secret' });
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-ion');
  assert.equal(Cesium.calls.length, 1);
  assert.equal(Cesium.calls[0].googleKey, undefined);
  assert.equal(Cesium.calls[0].ionToken, 'ion-secret');
  assert.equal(Cesium.Ion.defaultAccessToken, 'ion-secret');
});

test('a failed direct request retries through ion before falling back', async () => {
  const tileset = { id: 'ion-fallback' };
  const Cesium = fakeCesium([new Error('direct denied'), tileset]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, tileset);
  assert.equal(result.route, 'google-ion');
  assert.equal(result.errors.length, 1);
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
  assert.equal(Cesium.calls[1].googleKey, undefined);
  assert.equal(Cesium.calls.length, 2);
});

test('a failed direct-only request does not consume an implicit Cesium token', async () => {
  const Cesium = fakeCesium([new Error('direct denied')]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
  });
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(result.errors.length, 1);
  assert.equal(Cesium.calls.length, 1);
  assert.equal(Cesium.calls[0].googleKey, 'google-secret');
  assert.equal(Cesium.GoogleMaps.defaultApiKey, undefined);
});

test('failed direct and ion requests preserve the keyless OSM fallback', async () => {
  const Cesium = fakeCesium([new Error('direct denied'), new Error('ion denied')]);
  const result = await loadPhotorealisticTileset(Cesium, {
    googleApiKey: 'google-secret',
    cesiumToken: 'ion-secret',
  });
  assert.equal(result.tileset, null);
  assert.equal(result.route, 'osm');
  assert.equal(result.errors.length, 2);
  assert.equal(Cesium.calls.length, 2);
  assert.equal(Cesium.GoogleMaps.defaultApiKey, undefined);
});

test('tilesetOptions reach the tileset constructor, not just the call site', async () => {
  // THE MERGE GUARD. This fork caps the Google 3D Tiles cache because the host
  // Chrome terminates the GPU process on VRAM exhaustion instead of degrading.
  // Upstream v0.1.1 moved the constructor call inside this helper for keyless
  // boot, and the helper passed NO second argument — so taking that refactor
  // verbatim silently restored Cesium's 1536 MB + 1024 MB default. The symptom
  // is a GPU-process kill, which reads as a crash rather than a lost merge hunk.
  let received;
  const CesiumStub = {
    Ion: { defaultAccessToken: null },
    GoogleMaps: { defaultApiKey: null },
    createGooglePhotorealistic3DTileset: async (_primary, options) => {
      received = options;
      return { id: 'tileset' };
    },
  };
  const result = await loadPhotorealisticTileset(CesiumStub, {
    googleApiKey: 'key',
    tilesetOptions: { cacheBytes: 512 * 1024 * 1024, maximumCacheOverflowBytes: 256 * 1024 * 1024 },
  });
  assert.equal(result.route, 'google-direct');
  assert.equal(received.cacheBytes, 512 * 1024 * 1024);
  assert.equal(received.maximumCacheOverflowBytes, 256 * 1024 * 1024);
});

test('omitting tilesetOptions still calls the constructor cleanly', async () => {
  // Upstream's own callers pass nothing; the default must not be undefined,
  // which Cesium would treat differently from an empty options object.
  let received = 'never called';
  const CesiumStub = {
    Ion: { defaultAccessToken: null },
    GoogleMaps: { defaultApiKey: null },
    createGooglePhotorealistic3DTileset: async (_primary, options) => {
      received = options;
      return { id: 'tileset' };
    },
  };
  await loadPhotorealisticTileset(CesiumStub, { googleApiKey: 'key' });
  assert.deepEqual(received, {});
});
