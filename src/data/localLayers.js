import { createLocalGeoJsonLayer } from './localGeojson.js';
import { createFirmsHeatmapLayer } from './firmsHeatmap.js';
import submarineCablesLayer from './telegeographySubmarineCables.js';

// Use Vite's ?url import to properly resolve these assets in dev and build
import datacentersUrl from './local_data/datacenters/datacenters.geojsonl?url';
import damsUrl from './local_data/dams/dams.geojsonl?url';
import deltaLeveesUrl from './local_data/delta_levees/delta_levees.geojsonl?url';
import deltaWaterwaysUrl from './local_data/delta_waterways/delta_waterways.geojsonl?url';

/**
 * Registry of local GeoJSON datasets.
 * These are lazily loaded natively into Cesium when enabled.
 */
const datacenters = createLocalGeoJsonLayer({
  id: 'local-datacenters',
  url: datacentersUrl,
  name: 'Datacenters',
  color: '#00ffff', // Cyan
  icon: '▣',
  source: 'Local',
  labels: true,
  labelMax: 700,
  labelGridPx: 138,
});

const dams = createLocalGeoJsonLayer({
  id: 'local-dams',
  url: damsUrl,
  name: 'Dams',
  color: '#0088ff', // Blue
  icon: '▰',
  source: 'CA DWR DSOD',
  labels: true,
  labelMax: 900,
  labelGridPx: 132,
});

const deltaLevees = createLocalGeoJsonLayer({
  id: 'local-delta-levees',
  url: deltaLeveesUrl,
  name: 'Delta Levees',
  color: '#ffb000', // Amber
  icon: '▬',
  source: 'CA DWR',
  labels: true,
  labelMax: 500,
  labelGridPx: 140,
});

const deltaWaterways = createLocalGeoJsonLayer({
  id: 'local-delta-waterways',
  url: deltaWaterwaysUrl,
  name: 'Delta Waterways',
  color: '#33e0ff', // Cyan-blue
  icon: '≈',
  source: 'USGS NHD',
  labels: true,
  labelMax: 600,
  labelGridPx: 150,
});

// Live NASA FIRMS fires (VIIRS ×3 NRT via the /api/firms proxy). The id keeps
// the historical `local-` prefix for persistence + voice-tool-enum compat,
// but the data is NOT bundled anymore — it needs FIRMS_MAP_KEY server-side.
const fires = createFirmsHeatmapLayer({
  id: 'local-firms',
  name: 'FIRMS Active Fires',
  icon: '▲',
  source: 'NASA FIRMS · LIVE',
});

export default [
  datacenters,
  dams,
  deltaLevees,
  deltaWaterways,
  submarineCablesLayer,
  fires,
];
