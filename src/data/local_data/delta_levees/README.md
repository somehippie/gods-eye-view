# Delta levees — Sacramento–San Joaquin levee centerlines

Centerlines of the Sacramento–San Joaquin Delta levee system, mapped from the
January 2017 Delta LiDAR, with the levee crown sections collapsed to centerlines.

- **Source:** California Department of Water Resources,
  ["i17 Delta Levees Centerlines 2017"](https://data.cnra.ca.gov/dataset/i17-delta-levees-centerlines-2017)
- **License:** **CC BY 4.0** — CKAN metadata declares `"license_id": "cc-by"` at
  `https://data.cnra.ca.gov/api/3/action/package_show?id=i17-delta-levees-centerlines-2017`
- **Attribution (required):** "California DWR (CC BY 4.0)". Registered in
  `src/data/dataCredits.js` under key `ca-delta-levees` and listed in
  `DATA_SOURCES.md`.
- **Feature count:** 497 (LineString / MultiLineString)
- **Runtime file:** `delta_levees.geojsonl`
- **Retrieved:** 2026-08-30
- **Rebuild:** `node scripts/build-ca-water-layers.mjs`

## Transform

The source GeoJSON is 44 MB because it averages **1,932 vertices per feature**
(959,971 total across 497 features). The build applies Douglas-Peucker
simplification at a tolerance of `1e-5` degrees (~1 m), which reduces that to
~39,000 vertices and the file to ~1 MB — a 44× reduction with no visible change
at any usable zoom. Coordinates are rounded to 6 decimals (~0.1 m).

Features are **not dissolved**. Each segment carries its own `reach`,
`condition` and `levee_type`, all of which a dissolve by maintaining agency
would discard. (The waterways dataset *is* dissolved, for the opposite reason —
see `../delta_waterways/README.md`.)

`properties.name` carries the **LMA** (Levee Maintaining Agency), which is the
island or tract name — "Bethel Island", "Jersey Island", "Bacon Island". 135
distinct LMAs are present. The name is normalised onto `properties.name` because
the label resolver in `src/data/localGeojson.js` checks `props.name` first.

Fields kept: `name`, `lma_number`, `reach`, `levee_type`, `ab360_levee_type`,
`urban_status`, `condition`, `direct_agreement`, `source`, `data_date`.

Dropped as internal/editor metadata with no map value: `OBJECTID`,
`Last_Modified_By` (editor initials), `Date_Last_Modified`, `ShapeSTLength`,
and `Comments` (3 non-empty values across 497 features, all editorial notes such
as "merge with adjacent old river?").

No personal or contact-oriented data is present in the retained fields.
