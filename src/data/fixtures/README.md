# Test fixtures

- `tomtom-flow-austin-12-935-1686.pbf` — one real TomTom traffic-flow vector
  tile (Mapbox Vector Tile protobuf, layer `"Traffic flow"`), downtown Austin
  z12 x935 y1686, captured 2026-07-16 from
  `api.tomtom.com/traffic/map/4/tile/flow/relative/12/935/1686.pbf`
  (22,980 bytes). Used ONLY by `src/data/flowTiles.test.mjs` to pin MVT
  decoding offline — it is a point-in-time congestion snapshot, not a bundled
  data layer, and is never served to the app. © TomTom.

- `gtfs-rt-caltrain-vehicles.pb` (968 bytes) and
  `gtfs-rt-capitol-corridor-vehicles.pb` (956 bytes) — two real GTFS-Realtime
  `VehiclePositions` feeds captured 2026-09-10 from
  `api.511.org/transit/vehiclepositions?agency=CT|AM`. Used ONLY by
  `src/data/gtfsRealtime.test.mjs` to pin decoding offline. The pair is
  deliberate: Caltrain publishes position and timestamp but no bearing, speed,
  status or stop_id, while Capitol Corridor publishes all of them, so together
  they cover both the sparse and the complete shape. Point-in-time snapshots,
  never served to the app. Data © 511 SF Bay / MTC and the operating agencies.
