# KNOWN ISSUES

Updated: July 8, 2026

This file tracks active runtime issues only.

For the roadmap and open backlog, see the repository issue tracker.

---

## Open

### Amtrak branch has three prerequisites before it can merge
Status: Open (blocked on permission; work items recorded)

The branch `amtrak-parked-pending-permission` holds a complete, working Amtrak
layer. It is blocked on a permission answer from amtraker@piemadd.com — see
DEVLOG, 2026-09-10. Three things must ALSO be done before it merges, all of
which landed on `delta-water-layers` after that branch was cut, so it would
otherwise merge with a weaker seam than the layer that came after it:

1. **Route it through `capabilityGate` plus the consecutive-failure latch.**
   Both exist now (`recordTransientFailure` / `recordCapabilitySuccess`) and
   `bartDepartures.js` is the worked example. As the branch stands, a mirror
   that disappears logs a warning on every poll forever — and this upstream is
   a volunteer's server with no SLA, so that is the likely failure, not a
   hypothetical one.

2. **Migrate `amtrakFeed.js` to `fieldGuards.js`.** It carries its own local
   typeof/finite guard, written in response to the same `Number('') === 0` bug
   that `fieldGuards` now exists to prevent centrally. Add `amtrakFeed.js` to
   `GUARDED_PARSERS` in `fieldGuards.test.mjs` at the same time, which is what
   actually enforces it.

3. **Give the Amtrak proxy the boundary tests BART has.** Same extract-and-
   export step: export the proxy factory, drive it with `fetch` stubbed by a
   recorded fixture, assert what it requested as well as what it served. BART
   shipped a broken URL past 21 green unit tests precisely because that seam
   was untested; the Amtrak proxy has the identical untested seam today.

The same generalisation is worth doing for the 511 proxy, which is already
merged and has no boundary coverage either. That one is not blocked on
anything.


### BART departure board cap of 8 has never engaged on real data
Status: Open (unverified threshold)

Context:
- `MAX_BOARD_ROWS` in `bartDepartures.js` caps the selected station's board at
  8 rows, so a busy transfer station cannot run its board off the screen.
- Every frame observed while building the layer was late-night. The busiest
  single station seen had **4** departures (19th St. Oakland, 00:49 PDT);
  system-wide totals were 97 departures at 00:49, 7 at 01:49, 2 at 02:20.
- The cap has therefore never actually truncated anything. 8 is a guess sized
  off the feed's shape (up to 3 destinations x up to 3 estimates), not a
  measurement.

What could be wrong:
- Too low: a rush-hour transfer station truncates real departures with no
  indication that rows were dropped. There is currently no "+N more" row.
- Too high: 8 rows at 14px is ~112px of label stack, which may overlap
  neighbouring stations in dense downtown SF at low zoom.

How to verify (weekday, ~08:00 or ~17:30 PDT):
- Fastest, no UI:

      curl -s localhost:4173/api/rail/bart | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const s=j.stations.map(x=>[x.departures.length,x.name]).sort((a,b)=>b[0]-a[0]);console.log('open',j.open,'of',j.count);console.log(s.slice(0,8).map(r=>r[0]+'  '+r[1]).join('
'));})"

  If the top number reaches or exceeds 8, the cap is engaging.
- In the app: enable the layer and click a multi-line transfer station —
  MacArthur, 19th St. Oakland, 12th St. Oakland City Center, Embarcadero,
  Montgomery, Powell, Civic Center. Those carry the most lines.
- Check both: whether rows are being dropped, and whether the stack visually
  collides with adjacent station dots at city zoom.


### transit-vehicles registers a sprite collection that is never ordered
Status: Open (cosmetic / dead code)

Context:
- `transitVehicles.js` calls `registerSpriteCollection('transit-vehicles', ...)`
  in `init()` and `restoreSpriteOrder(...)` in `init()`/`enable()`.
- `SPRITE_LAYER_ORDER` in `spriteOrder.js` lists only cctv, firms, bikeshare,
  ais, military and flights. `transit-vehicles` is not among them.
- `restoreSpriteOrder` iterates `SPRITE_LAYER_ORDER` and raises each registered
  collection to the top, so a collection registered under an unlisted id is
  stored in the map and never acted on. The call currently does nothing.

Consequence:
- No visible bug today. Rail/ferry points simply keep whatever draw order they
  received when added to the scene, rather than a declared one.
- The hazard is that it reads as if ordering were handled. A future layer
  copying this pattern would inherit a silent no-op.

Fix candidates (not yet chosen):
- Add `transit-vehicles` to `SPRITE_LAYER_ORDER` at the intended depth, or
- Drop the two calls from `transitVehicles.js` so the file stops implying an
  ordering guarantee it does not have.

Deliberately not fixed alongside the direction-text change: picking a draw
order is a rendering decision that deserves its own change and its own look at
how the layer sits against ais/flights.


### Street traffic can be slow/uneven when panning across dense city blocks
Status: Open (partially mitigated)

Context:
- Current traffic loader fetches one clamped viewport tile at a time (major pass, then full pass).
- In dense cores, some visible roads can appear late after city jumps or fast pans.
- Zooming into adjacent streets does not always immediately trigger higher-detail coverage for all visible roads.

Current mitigation in runtime:
- Fair per-road dot budget allocation (reduces hard starvation under global `MAX_DOTS` cap).
- Center-shift threshold (reduces stale overlap lock while panning).

Next iteration candidates:
- Prioritize currently visible road segments inside the active viewport before off-center segments.
- Add neighbor prefetch ring for nearby tiles after jump-to-city actions.
- Add adaptive dot cap by frame time (coverage first, density second).
- Promote sync chip from loading indicator to true multi-phase progress.

---

### CCTV panel can appear "missing" after layout refactors
Status: Open (workaround available)

Context:
- Panel positions are persisted in local storage and can restore off-screen after UI changes.

Workaround:
- In browser console:
  - `localStorage.removeItem('godsEyeView.v6.panelPos.cctv-panel');`
  - `localStorage.removeItem('godsEyeView.v6.panelCollapsed.cctv-panel');`
  - `location.reload();`

Related keys (current versions):
- Panel positions: `godsEyeView.v7.panelPos.<panel-id>` (re-versioned 2026-06-10)
- Panel collapsed state: `godsEyeView.v6.panelCollapsed.<panel-id>`
- CCTV calibration: `godsEyeView.cctv.calibration.v2`

---

### Height-datum residuals (branch `feat/height-datum`, pending merge)
Status: Open (owner-accepted 2026-07-08, documented)

- **Cold-start floor latency:** at a freshly-visited airport, grounded/low aircraft
  float low for ~1–2 poll cycles (30–60 s) and rise as terrain floors resolve;
  a few stragglers take one more poll.
- **Born-grounded first poll:** a contact first seen on the ground with no altitude
  data renders at the geoid for ≤1 poll until its floor cell warms.
- Full context, improvement ideas, and the verification oracle
  (`scripts/qa-floor-verify.mjs`):
  `docs/superpowers/reports/2026-07-08-height-datum-handover.md`.

---

## Closed / Intentional (for clarity)

### Proxy SSRF and error-surface hardening gaps
Status: Closed as fixed on `main`

Context:
- Proxy middleware previously allowed broader error/internal surface area and looser upstream handling.
- Current `main` includes hardened proxy behavior in `vite.config.js`:
  - CCTV upstream URL no longer accepted from client query params.
  - Error payloads are sanitized.
  - OpenSky cache stores successful responses only.
  - OpenSky token refresh is coalesced.
  - GBFS/CCTV memory growth is bounded.

Validation target:
- `vite.config.js`

---

### NVG vignette edge color bleed
Status: Closed as fixed in current shader composite

Context:
- Earlier builds leaked original scene colors near the NVG tube edge.
- Current composite now masks NVG output with tube falloff before final blend, removing the color edge bleed.

Validation target:
- `src/styles/surveillance.js`

---

### Wildfires layer unavailable / static bundled snapshot
Status: Closed — live FIRMS integration shipped (2026-07-16)

Context:
- Wildfires (NASA FIRMS) were removed from runtime in v0.5.3, returned June 2026 as a
  bundled-snapshot layer (`local-firms`, 2026-05-25 data, ~58 MB in-repo), and were
  converted to **live NASA FIRMS data** on 2026-07-16: the `/api/firms` proxy merges
  three VIIRS NRT sources (trailing 24 h, 30 min cache, serve-stale-on-failure) and the
  bundled snapshot was deleted. Requires a free server-side `FIRMS_MAP_KEY`; without it
  the layer shows a KEY REQUIRED state.
- Weather radar is still held out of OSS v1 after QA found the previous overlay did not provide reliable visible value.
