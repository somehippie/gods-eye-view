/**
 * @module amtrakTrains
 * @description Live Amtrak train positions, nationwide.
 *
 * The counterpart to `transitVehicles.js`: that layer is seven Bay Area
 * operators from 511, this one is the national intercity network from a single
 * feed. Parsing lives in `amtrakFeed.js` so the proxy and the browser agree on
 * the wire format; this file is only rendering and selection.
 *
 * WHY THIS IS ONE FEED AND COMMUTER RAIL IS NOT: Amtrak publishes the whole
 * country in one place. The ~25-30 US commuter rail systems each publish their
 * own GTFS-Realtime feed with its own key, quota and id conventions, and there
 * is no national aggregator — measured 2026-09-10 against the Mobility Database
 * catalog: 176 US feeds carrying vehicle positions across 156 distinct
 * providers, 76 of them behind an API key. Adding them is 25-30 integrations,
 * not one.
 *
 * NO INTERPOLATION. A train is drawn where the feed last observed it and
 * nowhere else. Positions are not advanced along a route between polls, and
 * trains the feed has not observed at all are not drawn — see RENDERED_STATES
 * in amtrakFeed.js for why Predeparture is excluded.
 */

import * as Cesium from 'cesium';
import { registerEntityContext, selectEntityContext } from './contextStore.js';
import { normalizeAmtrakTrains, runningTrains, trainLabel } from './amtrakFeed.js';

/**
 * Client refresh cadence.
 *
 * The proxy owns the upstream cadence (300 s) and its cache, so this only
 * governs how quickly a new frame reaches the screen once fetched — every poll
 * inside the proxy's TTL is a same-origin cache hit and never reaches Amtraker.
 * 120 s means a new frame is on screen within two minutes of the proxy having
 * it, for about 2.5 local requests per upstream fetch.
 */
const POLL_MS = 120_000;
/** Endpoint installed by amtrakTrainsProxy in vite.config.js. */
const ENDPOINT = '/api/rail/amtrak';

/** Fallback when the feed omits a route colour. Measured: 0 of 59 did. */
const DEFAULT_COLOR = Cesium.Color.fromCssColorString('#9fb4c7');
const SELECTED_COLOR = Cesium.Color.fromCssColorString('#ffd479');

let _viewer = null;
let _collection = null;
let _labels = null;
let _clickHandler = null;
let _enabled = false;
/** @type {Map<string, {record: object, point: object}>} keyed by trainID. */
let _rendered = new Map();
let _selectedId = null;
let _count = 0;
let _lastUpdate = null;
let _loading = false;
let _error = null;

/** Cache parsed CSS colours — 25 distinct routes, re-resolved every poll otherwise. */
const _colorCache = new Map();

function routeColor(record) {
  const css = record?.color;
  if (!css) return DEFAULT_COLOR;
  let color = _colorCache.get(css);
  if (!color) {
    try {
      color = Cesium.Color.fromCssColorString(css);
    } catch {
      color = DEFAULT_COLOR;
    }
    // A malformed CSS string yields undefined rather than throwing.
    if (!color) color = DEFAULT_COLOR;
    _colorCache.set(css, color);
  }
  return color;
}

const colorFor = (record, selected) => (selected ? SELECTED_COLOR : routeColor(record));

/**
 * Publish the selected train into the shared context store.
 *
 * The properties carried are the ones that survive a poll, so a copied line
 * still names the same train a minute later. Speed and heading deliberately are
 * not among them — they change every fix, and a pasted line claiming 53 mph
 * would be wrong by the time it was read.
 *
 * @param {object} record
 * @returns {object|null}
 */
function registerSelectedContext(record) {
  if (!record?.id) return null;
  try {
    return registerEntityContext({ __amtrakId: record.id }, {
      id: `amtrak-${record.id}`,
      layerId: 'amtrak-trains',
      layerName: 'Amtrak',
      source: 'Amtrak via amtraker.com',
      label: trainLabel(record),
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        trainNumber: record.trainNumber,
        route: record.routeName,
        origin: record.originCode,
        destination: record.destinationCode,
        // Deliberately no `operator: 'Amtrak'`. That key IS in copySelection's
        // IDENTIFIER_KEYS, and layerName is already "Amtrak", so carrying it
        // would render "... · Amtrak · Amtrak (Amtrak via amtraker.com) · ...".
        status: record.timely,
      },
    });
  } catch (error) {
    console.warn('[Data:amtrak-trains] context register failed', error);
    return null;
  }
}

/** Repaint every point so exactly one shows as selected. */
function repaintSelection() {
  for (const [id, entry] of _rendered) {
    entry.point.color = colorFor(entry.record, id === _selectedId);
    entry.point.pixelSize = id === _selectedId ? 14 : 9;
  }
  if (!_labels) return;
  _labels.removeAll();
  const selected = _selectedId ? _rendered.get(_selectedId) : null;
  if (!selected) return;
  const record = selected.record;
  const board = [
    trainLabel(record),
    record.originCode && record.destinationCode
      ? `${record.originCode} → ${record.destinationCode}`
      : null,
    record.timely,
  ].filter(Boolean).join('\n');
  _labels.add({
    position: Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude),
    text: board,
    font: '12px monospace',
    fillColor: SELECTED_COLOR,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, -18),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });
}

function selectTrain(id) {
  const entry = _rendered.get(id);
  if (!entry) return;
  _selectedId = id;
  const context = registerSelectedContext(entry.record);
  if (context) selectEntityContext({ __gevContextId: `amtrak-${id}` });
  repaintSelection();
}

function clearSelection() {
  _selectedId = null;
  repaintSelection();
}

/** Escape deselects, matching every other selectable layer. */
function _onKeyDown(event) {
  if (event.key === 'Escape' && _selectedId) clearSelection();
}

function _installClickHandler(viewer) {
  if (_clickHandler) return;
  _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  _clickHandler.setInputAction((movement) => {
    if (!_enabled) return;
    const picked = viewer.scene.pick(movement.position);
    const id = picked?.id?.__amtrakId ?? picked?.primitive?.__amtrakId ?? null;
    if (id && _rendered.has(id)) selectTrain(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  document.addEventListener('keydown', _onKeyDown);
}

/**
 * Reconcile rendered points against a fresh set of trains.
 *
 * Points are reused by id rather than cleared and rebuilt, so a selected train
 * stays selected across a poll and Cesium is not churned every refresh.
 *
 * @param {Array<object>} trains
 */
function render(trains) {
  if (!_collection) return;
  const seen = new Set();
  for (const record of trains) {
    seen.add(record.id);
    const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude);
    const existing = _rendered.get(record.id);
    if (existing) {
      existing.record = record;
      existing.point.position = position;
      continue;
    }
    const point = _collection.add({
      position,
      pixelSize: 9,
      color: colorFor(record, false),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    point.__amtrakId = record.id;
    _rendered.set(record.id, { record, point });
  }
  for (const [id, entry] of [..._rendered]) {
    if (seen.has(id)) continue;
    _collection.remove(entry.point);
    _rendered.delete(id);
    if (_selectedId === id) _selectedId = null;
  }
  _count = _rendered.size;
  repaintSelection();
}

/**
 * ODC-By attribution, on screen, bottom-right, only while the layer is on.
 *
 * REQUIRED, not decorative. The Amtraker data is licensed ODC-By 1.0, and
 * api.amtraker.com/docs is specific about both the content and the placement:
 * users must be made aware the data originates from Amtraker, for an
 * interactive map the notice belongs in the bottom right corner, and it must
 * NOT be hidden in settings or an FAQ.
 *
 * That last clause is why this is a dedicated element rather than another
 * registerDataCredits entry. Those are added with showOnScreen=false and live
 * inside the collapsed "Data attribution" popover — appropriate for sources
 * whose licences allow it, and not compliant here.
 *
 * Bottom-LEFT is deliberately untouched: #cesium-credits carries the Google
 * Maps / 3D Tiles credit that Google's ToS requires be visible, and moving or
 * sharing it to satisfy a second licence would put the first at risk.
 *
 * Sits above the GEV MIC pill (right:36/bottom:36) rather than on top of it.
 */
const ATTRIBUTION_ID = 'amtrak-attribution';

function showAttribution() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(ATTRIBUTION_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = ATTRIBUTION_ID;
    el.innerHTML =
      'Train positions from '
      + '<a href="https://amtraker.com/" target="_blank" rel="noopener">Amtraker</a>'
      + ' · <a href="https://opendatacommons.org/licenses/by/1-0/" target="_blank" rel="noopener">ODC-By 1.0</a>';
    document.body.appendChild(el);
  }
  el.hidden = false;
}

function hideAttribution() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(ATTRIBUTION_ID);
  if (el) el.hidden = true;
}

function removeAttribution() {
  if (typeof document === 'undefined') return;
  document.getElementById(ATTRIBUTION_ID)?.remove();
}

const amtrakTrainsLayer = {
  id: 'amtrak-trains',
  name: 'Amtrak',
  icon: '\u{1F686}',
  source: 'amtraker.com',
  updateInterval: POLL_MS,

  init(viewer) {
    _viewer = viewer;
    _collection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    _labels = new Cesium.LabelCollection();
    viewer.scene.primitives.add(_collection);
    viewer.scene.primitives.add(_labels);
    _collection.show = false;
    _labels.show = false;
    _enabled = false;
    _rendered = new Map();
    _selectedId = null;
    _count = 0;
    _lastUpdate = null;
    _error = null;
    _installClickHandler(viewer);
  },

  enable() {
    _enabled = true;
    if (_collection) _collection.show = true;
    if (_labels) _labels.show = true;
    showAttribution();
    return this.update();
  },

  disable() {
    _enabled = false;
    if (_collection) _collection.show = false;
    if (_labels) _labels.show = false;
    hideAttribution();
    clearSelection();
  },

  async update() {
    if (!_enabled) return;
    _loading = true;
    try {
      const response = await fetch(ENDPOINT);
      if (!response.ok) throw new Error(`proxy HTTP ${response.status}`);
      const payload = await response.json();
      _error = null;
      _lastUpdate = Date.now();
      const trains = Array.isArray(payload.trains) ? payload.trains : [];
      render(runningTrains(trains, Date.now()));
    } catch (error) {
      _error = error?.message || String(error);
      console.warn('[Data:amtrak-trains] update failed', _error);
    } finally {
      _loading = false;
    }
  },

  getStats() {
    const stats = {
      count: _count,
      lastUpdate: _lastUpdate,
      loading: _loading,
    };
    if (_loading) stats.loadingLabel = 'reading Amtrak positions...';
    if (_error) stats.error = _error;
    return stats;
  },

  destroy(viewer) {
    const scene = (viewer || _viewer)?.scene;
    document.removeEventListener('keydown', _onKeyDown);
    removeAttribution();
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (_collection && scene) scene.primitives.remove(_collection);
    if (_labels && scene) scene.primitives.remove(_labels);
    _collection = null;
    _labels = null;
    _rendered = new Map();
    _selectedId = null;
    _viewer = null;
  },
};

export { normalizeAmtrakTrains, runningTrains, trainLabel };
export default amtrakTrainsLayer;
