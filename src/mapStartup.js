const clean = (value) => String(value || '').trim();

/**
 * Decide which map provider can deliver the best startup experience.
 * @param {{googleApiKey?: string, cesiumToken?: string}} credentials
 * @returns {'google-direct'|'google-ion'|'osm'}
 */
export function selectMapStartupRoute({ googleApiKey = '', cesiumToken = '' } = {}) {
  if (clean(googleApiKey)) return 'google-direct';
  if (clean(cesiumToken)) return 'google-ion';
  return 'osm';
}

/**
 * Load Google Photorealistic 3D Tiles through direct Google access when
 * configured, otherwise through Cesium ion's hosted Google asset. If the
 * direct request fails and an ion token is available, ion is the recovery path.
 *
 * `tilesetOptions` is forwarded to `createGooglePhotorealistic3DTileset` as its
 * SECOND argument, which is where Cesium takes Cesium3DTileset options. It
 * exists so a host can cap the tile cache: the default preset is 1536 MB with
 * 1024 MB of overflow, and a browser configured to terminate the GPU process on
 * VRAM exhaustion (rather than degrade) needs a lower ceiling. That has to
 * reach the CONSTRUCTOR — assigning `tileset.cacheBytes` afterwards is too late,
 * the allocation has already been sized.
 *
 * @param {object} Cesium
 * @param {{googleApiKey?: string, cesiumToken?: string, tilesetOptions?: object}} credentials
 * @returns {Promise<{tileset: object|null, route: 'google-direct'|'google-ion'|'osm', errors: Error[]}>}
 */
export async function loadPhotorealisticTileset(
  Cesium,
  { googleApiKey = '', cesiumToken = '', tilesetOptions = {} } = {},
) {
  const googleKey = clean(googleApiKey);
  const ionToken = clean(cesiumToken);
  const errors = [];

  if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;

  const attempts = [];
  if (googleKey) attempts.push({ route: 'google-direct', googleKey });
  if (ionToken) attempts.push({ route: 'google-ion', googleKey: undefined });

  for (const attempt of attempts) {
    Cesium.GoogleMaps.defaultApiKey = attempt.googleKey;
    try {
      const tileset = await Cesium.createGooglePhotorealistic3DTileset(
        { onlyUsingWithGoogleGeocoder: true },
        tilesetOptions,
      );
      return { tileset, route: attempt.route, errors };
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  Cesium.GoogleMaps.defaultApiKey = undefined;
  return { tileset: null, route: 'osm', errors };
}
