#!/usr/bin/env node
/**
 * Build the three California water-infrastructure datasets bundled under
 * src/data/local_data/ from their official public sources.
 *
 *   dams            → src/data/local_data/dams/dams.geojsonl
 *   delta levees    → src/data/local_data/delta_levees/delta_levees.geojsonl
 *   delta waterways → src/data/local_data/delta_waterways/delta_waterways.geojsonl
 *
 * SOURCES AND LICENSES
 *
 *   Dams:      California DWR — Division of Safety of Dams,
 *              "i17 California Jurisdictional Dams"
 *              https://data.cnra.ca.gov/dataset/i17-california-jurisdictional-dams
 *              License: CC BY 4.0 (CKAN metadata `license_id: "cc-by"` at
 *              https://data.cnra.ca.gov/api/3/action/package_show?id=i17-california-jurisdictional-dams)
 *
 *   Levees:    California DWR, "i17 Delta Levees Centerlines 2017"
 *              https://data.cnra.ca.gov/dataset/i17-delta-levees-centerlines-2017
 *              License: CC BY 4.0 (same CKAN evidence)
 *
 *   Waterways: U.S. Geological Survey, National Hydrography Dataset (NHD),
 *              Flowline - Large Scale (MapServer layer 6)
 *              https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer
 *              License: public domain (CKAN `license_id: "other-pd"` on
 *              https://data.ca.gov/dataset/national-hydrography-data-nhd-and-3dhp)
 *
 * All three sources publish GeoJSON in CRS84 / WGS84, so no reprojection is
 * needed and this script has no GDAL dependency.
 *
 * NOTE: the gis.water.ca.gov ArcGIS endpoints that appear in search results for
 * these datasets are down (HTTP 500, "Service not started"). The
 * gis.data.cnra.ca.gov Hub download API used here is the working path.
 *
 * TRANSFORM (deterministic)
 *
 *   1. Douglas-Peucker simplification of line geometry, tolerance 1e-5 deg
 *      (~1 m). The levee source averages 1,932 vertices per feature (960k
 *      total); at this tolerance it drops to ~39k with no visible change.
 *   2. Coordinates rounded to 6 decimals (~0.1 m).
 *   3. The display name is normalised onto `properties.name` — the label
 *      resolver in src/data/localGeojson.js checks `props.name` first.
 *   4. Waterways are DISSOLVED by GNIS name: 2,968 raw segments are grouped
 *      into 199 named channels. On its own the dissolve only shrinks the FILE —
 *      Cesium re-splits every MultiLineString part back into its own entity, so
 *      the renderer still saw 2,968. Step 5 is what actually reduces that.
 *      Levees are NOT dissolved — their segments carry distinct Reach and
 *      Levee_Condition values a dissolve would discard.
 *   5. Parts that share an EXACT endpoint are stitched into the longest runs
 *      possible (see stitchParts). Cesium expands every MultiLineString part
 *      into its own entity, so part count — not feature count — is what the
 *      renderer pays for. Loss-free: only duplicated join vertices are removed.
 *   6. Internal/editor metadata is dropped (OBJECTID, record-edit stamps,
 *      shape-length columns). See PRIVACY below for owner names.
 *   7. Features sorted by name for a stable diff.
 *
 * PRIVACY
 *
 *   DSOD publishes `Owner_Name` verbatim. For `Owner_Type` of "Individual
 *   owner" it has already redacted the value upstream to "Private Entity", but
 *   for "Private trusts and estates" it has not — those records carry the names
 *   of private individuals bound to property coordinates. This build replaces
 *   `Owner_Name` with a generic owner-type label for BOTH of those types.
 *   Agencies, districts, utilities, companies and associations keep their real
 *   owner names. Upstream DSOD retains the full values; the bundled file
 *   deliberately diverges from source. See dams/README.md.
 *
 * USAGE
 *
 *   node scripts/build-ca-water-layers.mjs          # download live sources
 *   node scripts/build-ca-water-layers.mjs raw/     # rebuild from saved raw files
 *                                                   # (dams.geojson, levees.geojson, flow*.geojson)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'src', 'data', 'local_data');

const DAMS_URL = 'https://gis.data.cnra.ca.gov/api/download/v1/items/9e02a3a4c90b4e1ba70257cc9cdf0a3b/geojson?layers=0';
const LEVEES_URL = 'https://gis.data.cnra.ca.gov/api/download/v1/items/5751344af237414082c89b19d40f2c4c/geojson?layers=0';
const NHD_LAYER = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query';
/** Legal-Delta-ish envelope: Carquinez east to Stockton, Suisun north to the Sacramento DWSC. */
const DELTA_BBOX = '-122.0,37.75,-121.2,38.6';
const NHD_PAGE = 2000;

const TOLERANCE = 1e-5; // degrees, ~1 m
const DECIMALS = 6;

/** Owner types whose `Owner_Name` names private individuals — replaced, not published. */
const OWNER_NAME_REDACTIONS = new Map([
  ['Individual owner', 'Private individual (name withheld)'],
  ['Private trusts and estates', 'Private trust or estate (name withheld)'],
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * NHD's ArcGIS endpoint intermittently answers a rapid second page with an HTML
 * error document instead of JSON (observed: both offsets return 200 when fetched
 * a few seconds apart). Retry with exponential backoff, and treat a non-JSON
 * content-type as a retryable failure rather than letting JSON.parse throw a
 * misleading SyntaxError.
 */
async function fetchJsonWithRetry(url, { attempts = 5, baseDelayMs = 1500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      if (!/json/i.test(type)) throw new Error(`non-JSON response (${type.split(';')[0] || 'unknown'})`);
      return await response.json();
    } catch (error) {
      lastError = error;
      process.stderr.write(`  retry ${attempt + 1}/${attempts}: ${error.message}\n`);
    }
  }
  throw new Error(`Gave up after ${attempts} attempts: ${lastError?.message}`);
}

/** Perpendicular distance from p to segment a-b (degrees, planar — fine at this scale). */
function segDist(p, a, b) {
  let [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx || dy) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x -= x2; y -= y2;
    } else if (t > 0) {
      x -= x1 + dx * t; y -= y1 + dy * t;
    } else {
      x -= x1; y -= y1;
    }
  } else {
    x -= x1; y -= y1;
  }
  return Math.sqrt(x * x + y * y);
}

/** Douglas-Peucker line simplification. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  let maxIndex = 0;
  let maxDist = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segDist(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) {
      maxIndex = i;
      maxDist = d;
    }
  }
  if (maxDist > tolerance) {
    return simplify(points.slice(0, maxIndex + 1), tolerance).slice(0, -1)
      .concat(simplify(points.slice(maxIndex), tolerance));
  }
  return [points[0], points[points.length - 1]];
}

const round = (coord) => [Number(coord[0].toFixed(DECIMALS)), Number(coord[1].toFixed(DECIMALS))];

/** Simplify + round every part of a (Multi)LineString; drops parts that collapse below 2 points. */
function simplifyLineParts(geometry) {
  const parts = geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates];
  return parts.map((part) => simplify(part, TOLERANCE).map(round)).filter((part) => part.length >= 2);
}

/**
 * Endpoint key for stitching. Coordinates have already been rounded to
 * DECIMALS by `round()`, so comparing the rounded text is comparing the stored
 * values themselves — an EXACT match, not a proximity test. No tolerance is
 * applied and no vertex is moved, invented, or interpolated: two parts are
 * chained only when one literally ends on the coordinate the other starts from.
 */
const endpointKey = (coord) => `${coord[0].toFixed(DECIMALS)},${coord[1].toFixed(DECIMALS)}`;

/**
 * Chain parts that share an exact endpoint into the longest runs possible.
 *
 * NHD splits a named channel at every confluence, so "Old River" arrives as 46
 * fragments that meet end to end. Cesium's GeoJsonDataSource expands every
 * MultiLineString part into its OWN entity (processMultiLineString ->
 * createLineString per part), so those fragments cost 46 entities, 46 stems and
 * 46 duplicate labels — dissolving by name alone does not change that, because
 * the part count is what the renderer sees.
 *
 * Stitching is loss-free: the only vertices removed are the duplicated shared
 * endpoints where two parts join. A part that connects to nothing is returned
 * unchanged.
 *
 * @param {number[][][]} parts Coordinate arrays for one named feature.
 * @returns {number[][][]} Chained coordinate arrays.
 */
function stitchParts(parts) {
  const pool = parts.map((part) => part.slice());
  const chains = [];
  while (pool.length) {
    let chain = pool.pop();
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < pool.length; i++) {
        const part = pool[i];
        const head = endpointKey(chain[0]);
        const tail = endpointKey(chain[chain.length - 1]);
        if (tail === endpointKey(part[0])) {
          chain = chain.concat(part.slice(1));
        } else if (tail === endpointKey(part[part.length - 1])) {
          chain = chain.concat(part.slice().reverse().slice(1));
        } else if (head === endpointKey(part[part.length - 1])) {
          chain = part.slice(0, -1).concat(chain);
        } else if (head === endpointKey(part[0])) {
          chain = part.slice().reverse().slice(0, -1).concat(chain);
        } else {
          continue;
        }
        pool.splice(i, 1);
        extended = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

const lineGeometry = (parts) => (parts.length === 1
  ? { type: 'LineString', coordinates: parts[0] }
  : { type: 'MultiLineString', coordinates: parts });

const clean = (value) => {
  const text = String(value ?? '').trim();
  return text && text.toLowerCase() !== 'null' ? text : null;
};

function writeJsonl(dir, file, lines) {
  fs.mkdirSync(path.join(DATA, dir), { recursive: true });
  const target = path.join(DATA, dir, file);
  fs.writeFileSync(target, lines.join('\n'));
  const bytes = fs.statSync(target).size;
  console.log(`  wrote ${dir}/${file}: ${lines.length} features, ${(bytes / 1048576).toFixed(2)} MB`);
  return { features: lines.length, bytes };
}

/** DSOD jurisdictional dams — Point geometry, owner names redacted per PRIVACY above. */
function buildDams(raw) {
  const out = [];
  let redacted = 0;
  for (const feature of raw.features || []) {
    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) continue;
    const p = feature.properties || {};
    const ownerType = clean(p.Owner_Type);
    const redaction = ownerType ? OWNER_NAME_REDACTIONS.get(ownerType) : null;
    if (redaction) redacted++;
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: round(coords) },
      properties: {
        name: clean(p.Dam_Name) || 'Unnamed dam',
        owner: redaction || clean(p.Owner_Name),
        owner_type: ownerType,
        dam_type: clean(p.Dam_Type),
        year_built: clean(p.Year_Built),
        height_ft: p.Dam_Height_feet ?? null,
        length_ft: p.Dam_Length_feet ?? null,
        capacity_af: p.Capacity_acre_feet ?? null,
        hazard: clean(p.Downstream_Hazard),
        condition: clean(p.Condition_Assessment),
        restricted: clean(p.Restricted),
        county: clean(p.County),
        state_id: clean(p.State_ID),
        national_id: clean(p.National_ID),
      },
    });
  }
  out.sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  console.log(`  dams: ${out.length} features, ${redacted} owner names redacted`);
  return out.map((feature) => JSON.stringify(feature));
}

/** Delta levee centerlines — line geometry, simplified, editor metadata dropped. */
function buildLevees(raw) {
  const out = [];
  for (const feature of raw.features || []) {
    if (!feature.geometry) continue;
    const parts = stitchParts(simplifyLineParts(feature.geometry));
    if (!parts.length) continue;
    const p = feature.properties || {};
    out.push({
      type: 'Feature',
      geometry: lineGeometry(parts),
      properties: {
        // LMA = Levee Maintaining Agency, the island/tract name ("Bethel Island").
        name: clean(p.LMA) || 'Unnamed levee',
        lma_number: clean(p.LMA_Number),
        reach: clean(p.Reach),
        levee_type: clean(p.Levee_Type),
        ab360_levee_type: clean(p.AB360_Levee_Type),
        urban_status: clean(p.Urban_Status),
        condition: clean(p.Levee_Condition),
        direct_agreement: clean(p.Direct_Agreement),
        source: clean(p.Source),
        data_date: clean(p.Date_Data_Refers_To),
      },
    });
  }
  out.sort((a, b) => a.properties.name.localeCompare(b.properties.name)
    || String(a.properties.reach).localeCompare(String(b.properties.reach)));
  return out.map((feature) => JSON.stringify(feature));
}

/** NHD named flowlines, dissolved to one (Multi)LineString per GNIS name. */
function buildWaterways(features) {
  const byName = new Map();
  for (const feature of features) {
    if (!feature.geometry) continue;
    const p = feature.properties || {};
    const name = clean(p.gnis_name ?? p.GNIS_NAME);
    if (!name) continue;
    const parts = simplifyLineParts(feature.geometry);
    if (!parts.length) continue;
    if (!byName.has(name)) byName.set(name, { parts: [], km: 0, ftype: p.ftype ?? p.FTYPE ?? null });
    const entry = byName.get(name);
    entry.parts.push(...parts);
    entry.km += Number(p.lengthkm ?? p.LENGTHKM ?? 0) || 0;
  }
  return [...byName.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, entry]) => {
      // Stitch AFTER the dissolve: every fragment of the channel is in hand, so
      // chains can span what were separate source features.
      const chained = stitchParts(entry.parts);
      return JSON.stringify({
        type: 'Feature',
        geometry: lineGeometry(chained),
        properties: {
          name,
          ftype: entry.ftype,
          length_km: Number(entry.km.toFixed(3)),
          segments: chained.length,
        },
      });
    });
}

/** Page the NHD flowline query until the server stops reporting a transfer limit. */
async function fetchWaterways() {
  const features = [];
  for (let offset = 0; ; offset += NHD_PAGE) {
    const url = `${NHD_LAYER}?where=${encodeURIComponent('GNIS_NAME IS NOT NULL')}`
      + `&geometry=${encodeURIComponent(DELTA_BBOX)}&geometryType=esriGeometryEnvelope&inSR=4326`
      + `&spatialRel=esriSpatialRelIntersects&outFields=${encodeURIComponent('GNIS_NAME,FTYPE,LENGTHKM')}`
      + `&outSR=4326&f=geojson&resultRecordCount=${NHD_PAGE}&resultOffset=${offset}`;
    const page = await fetchJsonWithRetry(url);
    const batch = page.features || [];
    features.push(...batch);
    console.log(`  NHD page offset=${offset}: ${batch.length} features`);
    if (batch.length === 0) break;
    if (!page.exceededTransferLimit && batch.length < NHD_PAGE) break;
    await sleep(2000); // be a good citizen between pages
  }
  return features;
}

async function main() {
  const rawDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const readRaw = (file) => JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));

  console.log(rawDir ? `Rebuilding from raw files in ${rawDir}` : 'Downloading live sources');

  const damsRaw = rawDir ? readRaw('dams.geojson') : await fetchJsonWithRetry(DAMS_URL);
  writeJsonl('dams', 'dams.geojsonl', buildDams(damsRaw));

  const leveesRaw = rawDir ? readRaw('levees.geojson') : await fetchJsonWithRetry(LEVEES_URL);
  writeJsonl('delta_levees', 'delta_levees.geojsonl', buildLevees(leveesRaw));

  const waterwayFeatures = rawDir
    ? fs.readdirSync(rawDir).filter((file) => /^flow.*\.geojson$/.test(file)).sort()
      .flatMap((file) => readRaw(file).features || [])
    : await fetchWaterways();
  console.log(`  waterways: ${waterwayFeatures.length} raw segments`);
  writeJsonl('delta_waterways', 'delta_waterways.geojsonl', buildWaterways(waterwayFeatures));

  console.log('Done.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
