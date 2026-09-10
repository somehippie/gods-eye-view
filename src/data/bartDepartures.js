/**
 * @module bartDepartures
 * @description BART station departure boards.
 *
 * Fifty fixed station points. Selecting one opens a departure board — the next
 * trains, their destination, minutes, platform, car count and line colour. The
 * parsing lives in `bartEtd.js` so the proxy and the browser agree on the wire
 * format; this file is rendering and selection.
 *
 * WHY THIS IS NOT A TRAIN LAYER. BART publishes no vehicle positions anywhere:
 * its GTFS-RT vehicle endpoint is a 404, its trip feed decodes to 90 entities
 * that are all TripUpdate and zero VehiclePosition, and 511's `agency=BA`
 * answers with a valid header and no entities. There is nothing to place on a
 * line, and inventing one by interpolating between stations would be a drawn
 * claim the data does not support. A departure is attributed to the station
 * that reported it and nowhere else.
 *
 * CLOSED STATIONS STAY ON THE MAP, drawn dimmed. BART omits a station from the
 * ETD feed entirely when it has no service — 44 of 50 reported at 00:49 PDT, 7
 * at 01:49, none overnight — so rendering only what the feed returned would
 * make most of the system vanish at 2 a.m. A station is geography; it does not
 * stop existing when the last train has gone.
 *
 * TRADEMARK: BART's licence forbids its trademarks and copyrighted materials in
 * association with the data, which is the logo and the system map. Neither
 * appears here. The word "BART" is used nominatively to say whose data this is,
 * and line colours come from the feed's own `hexcolor` field.
 */

import * as Cesium from 'cesium';
import { registerEntityContext, selectEntityContext } from './contextStore.js';
import {
  departureBoard,
  nextDepartureSummary,
  stationColor,
} from './bartEtd.js';
import {
  isCapabilityAvailable,
  markCapabilityUnavailable,
  recordCapabilitySuccess,
  recordTransientFailure,
} from '../capabilityGate.js';

/**
 * Client refresh cadence. The proxy owns the upstream cadence and its cache;
 * this is how quickly a new frame reaches the screen once fetched.
 */
const POLL_MS = 15_000;
/** Endpoint installed by bartDeparturesProxy in vite.config.js. */
const ENDPOINT = '/api/rail/bart';
/** Name this layer latches under in the capability gate. */
const CAPABILITY = 'BART departures';

/** Rows on the selected station's board. Most stations show far fewer. */
const MAX_BOARD_ROWS = 8;

/** A station with no departures — closed, or between trains. */
const DIMMED_COLOR = Cesium.Color.fromCssColorString('#5a6672');
const SELECTED_COLOR = Cesium.Color.fromCssColorString('#ffd479');
const BOARD_HEADER_COLOR = Cesium.Color.fromCssColorString('#e8eaed');

let _viewer = null;
let _collection = null;
let _labels = null;
let _clickHandler = null;
let _enabled = false;
/** @type {Map<string, {record: object, point: object}>} keyed by station code. */
let _rendered = new Map();
let _selectedId = null;
let _count = 0;
let _open = 0;
let _lastUpdate = null;
let _loading = false;
let _error = null;

/** 27 distinct line colours at most; re-resolved every poll otherwise. */
const _colorCache = new Map();

function cssColor(css, fallback) {
  if (!css) return fallback;
  let color = _colorCache.get(css);
  if (!color) {
    try {
      color = Cesium.Color.fromCssColorString(css);
    } catch {
      color = fallback;
    }
    if (!color) color = fallback;
    _colorCache.set(css, color);
  }
  return color;
}

const colorFor = (record, selected) => {
  if (selected) return SELECTED_COLOR;
  return cssColor(stationColor(record), DIMMED_COLOR);
};

/**
 * Publish the selected station into the shared context store.
 *
 * `nextDeparture` is carried deliberately even though it does not survive a
 * poll. Everywhere else in this app that rule keeps volatile values out of a
 * copied line, because a pasted "53 mph" is wrong by the time it is read. A
 * station is the opposite case: its identity is permanent, so the copied line
 * cannot become wrong about WHICH station it names, and the next departure is
 * the only thing about a station worth copying at the moment you copy it.
 *
 * @param {object} record
 * @returns {object|null}
 */
function registerSelectedContext(record) {
  if (!record?.code) return null;
  try {
    return registerEntityContext({ __bartId: record.code }, {
      id: `bart-${record.code}`,
      layerId: 'bart-departures',
      layerName: 'BART Departures',
      source: 'api.bart.gov',
      label: `${record.name} Station`,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        stationCode: record.code,
        nextDeparture: nextDepartureSummary(record),
        departures: record.departures.length,
      },
    });
  } catch (error) {
    console.warn('[Data:bart-departures] context register failed', error);
    return null;
  }
}

/**
 * Repaint points, and draw the selected station's board.
 *
 * The board is one label PER ROW rather than one label with newlines, because a
 * Cesium label carries a single fill colour — a combined label could not show
 * each line's own colour, which is the whole point of showing them.
 */
function repaintSelection() {
  for (const [code, entry] of _rendered) {
    const selected = code === _selectedId;
    entry.point.color = colorFor(entry.record, selected);
    entry.point.pixelSize = selected ? 13 : (entry.record.departures.length ? 9 : 6);
  }
  if (!_labels) return;
  _labels.removeAll();
  const selected = _selectedId ? _rendered.get(_selectedId) : null;
  if (!selected) return;
  const record = selected.record;
  const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude);
  const common = {
    position,
    font: '12px monospace',
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
  const rows = departureBoard(record, MAX_BOARD_ROWS);
  // Header sits above the rows; each row steps down 14px from it.
  _labels.add({
    ...common,
    text: `${record.name} Station`,
    fillColor: BOARD_HEADER_COLOR,
    pixelOffset: new Cesium.Cartesian2(12, -18 - rows.length * 14),
  });
  rows.forEach((row, index) => {
    _labels.add({
      ...common,
      text: row.text,
      fillColor: cssColor(row.hexColor, DIMMED_COLOR),
      pixelOffset: new Cesium.Cartesian2(12, -18 - (rows.length - 1 - index) * 14),
    });
  });
  if (!rows.length) {
    _labels.add({
      ...common,
      text: 'no departures',
      fillColor: DIMMED_COLOR,
      pixelOffset: new Cesium.Cartesian2(12, -18),
    });
  }
}

function selectStation(code) {
  const entry = _rendered.get(code);
  if (!entry) return;
  _selectedId = code;
  const context = registerSelectedContext(entry.record);
  if (context) selectEntityContext({ __gevContextId: `bart-${code}` });
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
    const code = picked?.id?.__bartId ?? picked?.primitive?.__bartId ?? null;
    if (code && _rendered.has(code)) selectStation(code);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  document.addEventListener('keydown', _onKeyDown);
}

/**
 * Reconcile rendered points against a fresh set of stations.
 *
 * Points are reused by station code. Station geography is effectively static,
 * so after the first frame this only updates each record and repaints.
 *
 * @param {Array<object>} stations
 */
function render(stations) {
  if (!_collection) return;
  const seen = new Set();
  for (const record of stations) {
    if (!record?.code) continue;
    if (!Number.isFinite(record.latitude) || !Number.isFinite(record.longitude)) continue;
    seen.add(record.code);
    const existing = _rendered.get(record.code);
    if (existing) {
      existing.record = record;
      continue;
    }
    const point = _collection.add({
      position: Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude),
      pixelSize: 9,
      color: colorFor(record, false),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    point.__bartId = record.code;
    _rendered.set(record.code, { record, point });
  }
  for (const [code, entry] of [..._rendered]) {
    if (seen.has(code)) continue;
    _collection.remove(entry.point);
    _rendered.delete(code);
    if (_selectedId === code) _selectedId = null;
  }
  _count = _rendered.size;
  _open = [..._rendered.values()].filter((entry) => entry.record.departures.length > 0).length;
  repaintSelection();
}

const bartDeparturesLayer = {
  id: 'bart-departures',
  name: 'BART Departures',
  icon: '\u{1F689}',
  source: 'api.bart.gov',
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
    _open = 0;
    _lastUpdate = null;
    _error = null;
    _installClickHandler(viewer);
  },

  enable() {
    _enabled = true;
    if (_collection) _collection.show = true;
    if (_labels) _labels.show = true;
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
    // Latched off: the upstream is gone or misconfigured and has already said
    // so once. Stop asking — that is the whole contract of the gate.
    if (!isCapabilityAvailable(CAPABILITY)) return;
    _loading = true;
    try {
      const response = await fetch(ENDPOINT);
      if (!response.ok) {
        const remedy = 'set BART_API_KEY in .env, or check api.bart.gov is reachable';
        if (response.status === 403 || response.status === 503) {
          // Configuration, not weather. One message, then silence.
          markCapabilityUnavailable(CAPABILITY, `HTTP ${response.status}`, remedy);
        } else {
          // Transient — until it is not. Latches after five in a row, so a
          // retired endpoint stops logging instead of warning on every poll.
          recordTransientFailure(CAPABILITY, `HTTP ${response.status}`, remedy);
        }
        throw new Error(`proxy HTTP ${response.status}`);
      }
      const payload = await response.json();
      recordCapabilitySuccess(CAPABILITY);
      _error = null;
      _lastUpdate = Date.now();
      render(Array.isArray(payload.stations) ? payload.stations : []);
    } catch (error) {
      _error = error?.message || String(error);
      if (isCapabilityAvailable(CAPABILITY)) {
        console.warn('[Data:bart-departures] update failed', _error);
      }
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
    if (_loading) stats.loadingLabel = 'reading BART departure boards...';
    // Stations are static; what varies is how many are running trains, which is
    // the number worth surfacing next to a count that never moves.
    if (_count) stats.detail = `${_open}/${_count} with departures`;
    if (_error) stats.error = _error;
    return stats;
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

export default bartDeparturesLayer;
