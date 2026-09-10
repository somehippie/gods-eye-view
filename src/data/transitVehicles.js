/**
 * @module transitVehicles
 * @description Live Bay Area rail and ferry positions from 511.org.
 *
 * WHY RAIL AND FERRY AND NOT BUSES: the regional feed carries ~2,000 vehicles
 * at rush hour and ~1,960 of them are buses, which cover the Bay in a solid
 * mat of dots. The 40-odd trains and boats read the way the ADS-B and AIS
 * layers do — sparse, fast, going somewhere — which is the character this map
 * is for. The proxy filters before the wire, so the client never sees a bus.
 *
 * WHY BART IS NOT HERE: BART publishes no vehicle positions. Not on
 * api.bart.gov (`gtfsrt/vehiclepositions.aspx` is a 404; the trip-update feed
 * decodes to 90 entities, all TripUpdate, zero VehiclePosition) and not via
 * 511 (`agency=BA` answers 200 with a 15-byte header and no entities). BART
 * belongs to a station-departures layer built on its ETD endpoint, which is a
 * different thing from this.
 *
 * IDENTITY: a vehicle is keyed by `agency:vehicleId`, never by the bare vehicle
 * id. Measured on the live combined feed, 2,043 vehicles carried only 1,926
 * distinct bare ids, and matching on those teleported dots between agencies at
 * up to 4,785 km/h across a 99-second gap. Agency-scoped, the same comparison
 * gives a p99 of 97 km/h. See gtfsRealtime.js.
 */

import * as Cesium from 'cesium';
import { registerEntityContext, selectEntityContext } from './contextStore.js';
import { registerSpriteCollection, restoreSpriteOrder } from './spriteOrder.js';

/** Client refresh cadence. The proxy owns the upstream cadence and its cache. */
const POLL_MS = 30_000;
/** Endpoint installed by transitVehiclesProxy in vite.config.js. */
const ENDPOINT = '/api/transit/vehicles';

/**
 * A vehicle whose own timestamp is older than this is dropped.
 *
 * Measured freshness on the live feed: median 13 s behind the feed clock, p95
 * 30 s, hard max 30 s. Anything past ten minutes is a vehicle the operator
 * stopped updating — an out-of-service train left parked on the map.
 */
const MAX_FIX_AGE_MS = 10 * 60_000;

const RAIL_COLOR = Cesium.Color.fromCssColorString('#62b5ff');
const FERRY_COLOR = Cesium.Color.fromCssColorString('#5fe0c0');
const SELECTED_COLOR = Cesium.Color.fromCssColorString('#ffd479');

let _viewer = null;
let _collection = null;
let _labels = null;
let _clickHandler = null;
let _enabled = false;
/** @type {Map<string, {record: object, point: object}>} keyed by `agency:vehicleId`. */
let _rendered = new Map();
let _selectedId = null;
let _count = 0;
let _lastUpdate = null;
let _loading = false;
let _error = null;
let _hasKey = true;

/**
 * Human label for a vehicle.
 *
 * Route first, because "Caltrain 507" means less to a reader than the line it
 * is running. Falls back through the ids the operator did populate — Caltrain
 * sends a bare vehicle id and no label, SF Bay Ferry sends the boat's name.
 *
 * @param {object} record
 * @returns {string}
 */
export function vehicleLabel(record) {
  const parts = [];
  // SMART's agency name, route id and vehicle id can all be the literal string
  // "SMART"; without this the label reads "SMART SMART SMART".
  const push = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return;
    if (parts.some((part) => part.toLowerCase() === text.toLowerCase())) return;
    parts.push(text);
  };
  push(record.agencyName);
  push(record.routeId);
  push(record.label || record.vehicleId);
  return parts.join(' ') || 'Transit vehicle';
}

/**
 * Drop vehicles whose fix is too old to be believed.
 *
 * Pure and exported so the staleness rule is testable without a viewer.
 *
 * @param {Array<object>} vehicles
 * @param {number} nowMs
 * @param {number} [maxAgeMs]
 * @returns {Array<object>}
 */
export function freshVehicles(vehicles, nowMs, maxAgeMs = MAX_FIX_AGE_MS) {
  const out = [];
  for (const vehicle of vehicles || []) {
    if (!vehicle?.id) continue;
    if (!Number.isFinite(vehicle.latitude) || !Number.isFinite(vehicle.longitude)) continue;
    // A vehicle with no timestamp at all is kept: the operator never sends one
    // (SMART and LAVTA do this), and dropping it would empty those agencies.
    if (Number.isFinite(vehicle.timestamp)) {
      if (nowMs - vehicle.timestamp * 1000 > maxAgeMs) continue;
    }
    out.push(vehicle);
  }
  return out;
}

const colorFor = (record, selected) => {
  if (selected) return SELECTED_COLOR;
  return record.mode === 'ferry' ? FERRY_COLOR : RAIL_COLOR;
};

/**
 * Publish the selected vehicle into the shared context store.
 *
 * This is what makes a train answerable to the copy button and to voice: the
 * fields below are the ones that survive a poll, so a copied line still
 * identifies the same vehicle a minute later.
 *
 * @param {object} record
 * @returns {object|null}
 */
function registerSelectedContext(record) {
  if (!record?.id) return null;
  try {
    return registerEntityContext({ __transitId: record.id }, {
      id: `transit-${record.id}`,
      layerId: 'transit-vehicles',
      layerName: 'Rail & Ferry',
      source: '511.org',
      label: vehicleLabel(record),
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        vehicleId: record.vehicleId,
        routeId: record.routeId,
        tripId: record.tripId,
        operator: record.agencyName,
        mode: record.mode,
        status: record.status,
        speed: record.speed,
        bearing: record.bearing,
      },
    });
  } catch (error) {
    console.warn('[Data:transit-vehicles] context register failed', error);
    return null;
  }
}

/** Repaint every point so exactly one shows as selected. */
function repaintSelection() {
  for (const [id, entry] of _rendered) {
    entry.point.color = colorFor(entry.record, id === _selectedId);
    entry.point.pixelSize = id === _selectedId ? 14 : 9;
  }
  if (_labels) {
    _labels.removeAll();
    const selected = _selectedId ? _rendered.get(_selectedId) : null;
    if (selected) {
      _labels.add({
        position: Cesium.Cartesian3.fromDegrees(selected.record.longitude, selected.record.latitude),
        text: vehicleLabel(selected.record),
        font: '12px monospace',
        fillColor: SELECTED_COLOR,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
  }
}

function selectVehicle(id) {
  const entry = _rendered.get(id);
  if (!entry) return;
  _selectedId = id;
  const context = registerSelectedContext(entry.record);
  if (context) selectEntityContext({ __gevContextId: `transit-${id}` });
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
    const id = picked?.id?.__transitId ?? picked?.primitive?.__transitId ?? null;
    if (id && _rendered.has(id)) selectVehicle(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  document.addEventListener('keydown', _onKeyDown);
}

/**
 * Reconcile the rendered points against a fresh set of vehicles.
 *
 * Points are reused by id rather than cleared and rebuilt, so a selected train
 * stays selected across a poll and Cesium is not asked to churn primitives
 * every 30 seconds.
 *
 * @param {Array<object>} vehicles
 */
function render(vehicles) {
  if (!_collection) return;
  const seen = new Set();
  for (const record of vehicles) {
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
    point.__transitId = record.id;
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

const transitVehiclesLayer = {
  id: 'transit-vehicles',
  name: 'Rail & Ferry',
  icon: '🚆',
  source: '511.org',
  updateInterval: POLL_MS,

  init(viewer) {
    _viewer = viewer;
    _collection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    _labels = new Cesium.LabelCollection();
    viewer.scene.primitives.add(_collection);
    viewer.scene.primitives.add(_labels);
    registerSpriteCollection('transit-vehicles', _collection);
    _collection.show = false;
    _labels.show = false;
    _enabled = false;
    _rendered = new Map();
    _selectedId = null;
    _count = 0;
    _lastUpdate = null;
    _error = null;
    _installClickHandler(viewer);
    restoreSpriteOrder(viewer);
  },

  enable(viewer) {
    _enabled = true;
    if (_collection) _collection.show = true;
    if (_labels) _labels.show = true;
    restoreSpriteOrder(viewer || _viewer);
    return this.update();
  },

  disable() {
    _enabled = false;
    if (_collection) _collection.show = false;
    if (_labels) _labels.show = false;
    clearSelection();
  },

  async update() {
    if (!_enabled) return;
    _loading = true;
    try {
      const response = await fetch(ENDPOINT);
      if (response.status === 503) {
        // No token configured. Degrade quietly like every other keyed layer.
        _hasKey = false;
        _error = 'no_key';
        render([]);
        return;
      }
      if (!response.ok) throw new Error(`proxy HTTP ${response.status}`);
      const payload = await response.json();
      _hasKey = true;
      _error = null;
      _lastUpdate = Date.now();
      render(freshVehicles(payload.vehicles, Date.now()));
    } catch (error) {
      _error = error?.message || String(error);
      console.warn('[Data:transit-vehicles] update failed', _error);
    } finally {
      _loading = false;
    }
  },

  getStatus() {
    return {
      count: _count,
      loading: _loading,
      error: _error,
      lastUpdate: _lastUpdate,
      hasKey: _hasKey,
    };
  },

  destroy(viewer) {
    const scene = (viewer || _viewer)?.scene;
    document.removeEventListener('keydown', _onKeyDown);
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

export default transitVehiclesLayer;
