/**
 * Bottom-to-top order for near-plane-clamped contact sprite collections.
 *
 * `transit-vehicles` sits above `ais` because a train carrying its line —
 * "Capitol Corridor CC 2102" — is a more useful thing to read and click than a
 * generic AIS contact. There is no longer any overlap to trade off: the transit
 * layer is rail-only, so nothing in it shares water with a vessel.
 */
export const SPRITE_LAYER_ORDER = Object.freeze([
  'cctv',
  'firms',
  'bikeshare',
  'ais',
  'transit-vehicles',
  'military',
  'flights',
]);

/** @type {Map<string, Object>} */
const _collections = new Map();

/** Ids already warned about, so an enable path cannot spam the console. */
const _warned = new Set();

/**
 * Complain once about a sprite id this module cannot act on.
 *
 * Both entry points below used to accept an unlisted id and quietly do
 * nothing, which reads at the call site as if ordering were handled. That has
 * now cost this project three separate silent misses of the same shape — a
 * layer reporting stats under a name the manager never calls, and these two.
 * An unlisted id is a mistake every time: either the layer belongs in
 * SPRITE_LAYER_ORDER, or it should not be calling these at all.
 *
 * @param {string} layerId
 * @param {string} where Function name, so the message points at the call.
 * @returns {void}
 */
function warnUnordered(layerId, where) {
  const key = `${where}:${layerId}`;
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(
    `[spriteOrder] ${where}('${layerId}') does nothing: '${layerId}' is not in `
    + `SPRITE_LAYER_ORDER (${SPRITE_LAYER_ORDER.join(', ')}). Add it at the `
    + 'intended depth, or drop the call so the layer stops implying an ordering '
    + 'guarantee it does not have.',
  );
}

/** Test seam: forget which ids have already been warned about. */
export function _resetSpriteOrderWarnings() {
  _warned.clear();
}

/**
 * Register the current primitive collection for a sprite layer.
 * @param {string} layerId - Stable sprite-order layer key.
 * @param {Object} collection - Cesium billboard/point primitive collection.
 * @returns {void}
 */
export function registerSpriteCollection(layerId, collection) {
  if (!layerId || !collection) return;
  // Still stored, so unregisterSpriteCollection stays symmetric — but said out
  // loud, because restoreSpriteOrder will never touch it.
  if (!SPRITE_LAYER_ORDER.includes(layerId)) warnUnordered(layerId, 'registerSpriteCollection');
  _collections.set(layerId, collection);
}

/**
 * Remove a registered collection (primarily useful to lifecycle tests).
 * @param {string} layerId - Stable sprite-order layer key.
 * @param {Object} [collection] - Optional identity guard against stale teardown.
 * @returns {void}
 */
export function unregisterSpriteCollection(layerId, collection) {
  if (collection && _collections.get(layerId) !== collection) return;
  _collections.delete(layerId);
}

/**
 * Reassert deterministic sprite stacking after any layer enable/init.
 * Cesium's stable translucent sort otherwise preserves first-enable primitive
 * order. Raising bottom-to-top makes flights the final/top collection.
 * @param {Cesium.Viewer|Object} viewer - Active viewer.
 * @returns {void}
 */
export function restoreSpriteOrder(viewer) {
  if (!viewer || viewer.isDestroyed?.()) return;
  const scene = viewer.scene;
  const primitives = scene?.primitives;
  if (!primitives || scene.isDestroyed?.() || primitives.isDestroyed?.()) return;

  for (const layerId of SPRITE_LAYER_ORDER) {
    const collection = _collections.get(layerId);
    if (!collection || collection.isDestroyed?.()) continue;
    if (primitives.contains?.(collection) === false) continue;
    primitives.raiseToTop(collection);
  }
}

/**
 * Explicit layer-enable wiring seam. Production callers use the shared
 * restorer by default; tests inject a spy to pin each enable path without
 * constructing a WebGL viewer.
 * @param {string} layerId - Sprite layer whose enable path is restoring order.
 * @param {Cesium.Viewer|Object} viewer - Active viewer.
 * @param {(viewer: Object) => void} [restore=restoreSpriteOrder] - Test seam.
 * @returns {void}
 */
export function restoreSpriteOrderOnEnable(
  layerId,
  viewer,
  restore = restoreSpriteOrder,
) {
  if (!SPRITE_LAYER_ORDER.includes(layerId)) {
    warnUnordered(layerId, 'restoreSpriteOrderOnEnable');
    return;
  }
  if (typeof restore !== 'function') return;
  restore(viewer);
}
