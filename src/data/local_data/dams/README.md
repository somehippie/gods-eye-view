# Dams — California jurisdictional dams (DSOD)

Every dam currently under the jurisdiction of the California Division of Safety
of Dams (DSOD).

- **Source:** California Department of Water Resources — Division of Safety of Dams,
  ["i17 California Jurisdictional Dams"](https://data.cnra.ca.gov/dataset/i17-california-jurisdictional-dams)
- **License:** **CC BY 4.0** — CKAN metadata declares `"license_id": "cc-by"` /
  `"license_title": "Creative Commons Attribution"` at
  `https://data.cnra.ca.gov/api/3/action/package_show?id=i17-california-jurisdictional-dams`
- **Attribution (required):** "California DWR — Division of Safety of Dams
  (CC BY 4.0)". Registered in `src/data/dataCredits.js` under key `ca-dsod-dams`
  and listed in `DATA_SOURCES.md`.
- **Feature count:** 1,230 (Point geometry)
- **Runtime file:** `dams.geojsonl`
- **Retrieved:** 2026-08-30
- **Rebuild:** `node scripts/build-ca-water-layers.mjs`

## What replaced what

This file previously held a 704-feature global OpenInfraMap/OSM extract
(`waterway=dam`, `man_made=dam`, `building=dam`) under ODbL 1.0. That extract
contained **4 features in California and 0 in the San Francisco Bay Area**, so
the layer rendered empty across the region it was most likely to be used in. It
was replaced wholesale by the DSOD inventory above, and the layer's `source`
field in `src/data/localLayers.js` was corrected from `USACE` — which was never
accurate for the OSM extract either — to `CA DWR DSOD`.

The superseded `dams.geojson` (the pretty-printed twin of the old JSONL) was
deleted in the same change: nothing imported it, and leaving a stale 730 KB OSM
file beside the live dataset invites confusion.

Coverage after the swap: 284 features in the Bay Area, 34 in the
Sacramento–San Joaquin Delta, including Bethany Forebay, Clifton Court Forebay,
Marsh Creek, Antioch Reservoir and New Upper San Leandro.

## Privacy transform — this file diverges from source

**DSOD publishes `Owner_Name` verbatim. This bundled snapshot does not.**

DSOD has already redacted owners upstream for `Owner_Type = "Individual owner"`,
where the published value is the literal string `"Private Entity"`. It has
**not** done so for `Owner_Type = "Private trusts and estates"`, where the
published values are the names of private individuals — family trusts, estates
and named trustees — bound to precise property coordinates.

The build script replaces `Owner_Name` for **both** of those owner types:

| `owner_type` | `owner` value in this file | Records |
|---|---|---|
| `Individual owner` | `Private individual (name withheld)` | 155 |
| `Private trusts and estates` | `Private trust or estate (name withheld)` | 15 |

All other owner types — state and county agencies, cities, water and utility
districts, private companies and corporations, and homeowner/lake associations —
**keep their real owner names**, because identifying the operator of a public
water structure is the point of the field. 170 of 1,230 records are affected.

Anyone forking this repo should know the file deliberately differs from
upstream. **Upstream DSOD retains the full values**; re-download from the source
URL above if you need them, and consider your own obligations before
republishing them.

Also dropped as internal/editor metadata with no map value: `OBJECTID`,
`Internal_ID`, `Record_Last_Edited`, `Record_Last_Edited_By`, `Data_Source`,
`Date_Data_Applies`, and the redundant `Latitude`/`Longitude` columns (the
geometry carries the position). The `Comment` column was empty across all 1,230
records.
