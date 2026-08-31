# Delta waterways — named NHD channels

Named river, slough, canal and cut centerlines for the Sacramento–San Joaquin
Delta, extracted from the USGS National Hydrography Dataset.

- **Source:** U.S. Geological Survey, National Hydrography Dataset (NHD),
  "Flowline - Large Scale" (MapServer layer 6),
  <https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer>
- **License:** **Public domain** — CKAN metadata declares
  `"license_id": "other-pd"` / `"Other (Public Domain)"` on
  <https://data.ca.gov/dataset/national-hydrography-data-nhd-and-3dhp>.
  No attribution is required; credited as a courtesy.
- **Attribution (courtesy):** "U.S. Geological Survey — National Hydrography
  Dataset". Registered in `src/data/dataCredits.js` under key `usgs-nhd`.
- **Feature count:** 199 named channels (LineString / MultiLineString)
- **Runtime file:** `delta_waterways.geojsonl`
- **Retrieved:** 2026-08-30
- **Rebuild:** `node scripts/build-ca-water-layers.mjs`

## Extent

Queried against an envelope covering the legal Delta and its approaches —
`-122.0, 37.75` to `-121.2, 38.6` — which runs from Carquinez Strait east to
Stockton and from the Suisun Marsh north to the Sacramento Deep Water Ship
Channel.

The query filters to `GNIS_NAME IS NOT NULL`: unnamed ditches and minor
tributaries are excluded, since the value of the layer is naming the water.

## Transform — dissolved by name

The raw query returns **2,968 individual flowline segments** for only **199
distinct named channels**. Old River alone is 46 segments; Marsh Creek is 72.
Shipped raw, that would put 2,968 features into the label arbiter to render 199
names, all competing with each other.

The build therefore **dissolves segments by GNIS name** into one
`MultiLineString` per channel, preserving `length_km` (summed) and `segments`
(the part count) as properties. Douglas-Peucker simplification at `1e-5` degrees
(~1 m) and 6-decimal rounding are applied before the dissolve.

Longest channels present: Sacramento River (103 km), San Joaquin River (96 km),
Old River (70 km), Middle River (45 km), Sacramento River Deep Water Ship
Channel (43 km), Mokelumne River, Contra Costa Canal, Georgiana Slough,
Montezuma Slough.

Fields: `name`, `ftype`, `length_km`, `segments`. The NHD source carries no
personal or contact-oriented data.

## Note on the alternatives

NHD "Area - Large Scale" (layer 9) returns the water-surface *polygons* rather
than centerlines, but over this envelope it is 17.8 MB for 1,842 features of
which only 3 carry a name — the wrong trade for a labelled layer. The CNRA
dataset "i12 Delta Hydrology" sounds relevant but is a set of gauge **stations**,
not channel geometry.
