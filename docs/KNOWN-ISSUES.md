# KNOWN ISSUES

Updated: July 8, 2026

This file tracks active runtime issues only.

For the roadmap and open backlog, see the repository issue tracker.

---

## Open

### 511 transit-vehicles proxy has no boundary coverage
Status: Open (not blocked on anything)

Carried out of the Amtrak prerequisites entry when that closed, because it was
never an Amtrak item and would otherwise have been filed away with it.

`transitVehiclesProxy` in `vite.config.js` is neither exported nor driven by a
test, so the seam where it meets 511 is uncovered — the same gap that shipped a
broken BART url past 21 green unit tests, and an unasserted User-Agent past 17
on Amtrak. `bartProxy.test.mjs` and `amtrakProxy.test.mjs` are both worked
examples now; the step is export the factory, add an injectable `cacheDir`, and
assert what it requested as well as what it served.


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

### A comment that describes a defence is not the same as a defence
Status: Open (standing habit, not a bug)

Three occurrences now of the same shape: **a comment states behaviour the code
does not actually implement**, and nothing fails, because the tests exercise
that the function runs rather than that the specific hazard the comment names
is actually stopped.

1. `amtrakFeed.js` — the local numeric guard's comment warned that a null
   `lat` would "render a train in the Gulf of Guinea". That is 0,0. The guard
   stopped `null` coercing to zero and did nothing about a row carrying two
   *genuine* zeros, which passed straight through. Seventeen tests were green
   over it; none covered the case the comment named. Found 2026-09-14 while
   migrating to `coordinateField`, which does reject it.
2. `vite.config.js` (Amtrak proxy) — "the non-running rows are dropped before
   anything crosses the wire". They are not. `runningTrains` is applied
   client-side, so Predeparture and Completed rows reach the browser. Not a
   rendering fault, but the stated wire contract was wrong, and
   `DATA_SOURCES.md` repeated it. Found 2026-09-14 when a boundary test written
   *from the comment* failed against the code.
3. `.env.example` — `CCTV_AUTO_CALIBRATE` and `CCTV_DRAPE_MESH` are
   documented as "(client flag)" with described behaviour. Zero references in
   `src/`, `vite.config.js` or `index.html`. Setting either does nothing.
   Still true as of 2026-09-14.

The near-loss of the cache-ceiling override during the upstream merge is a
*different* failure (a correct implementation nearly deleted) and is not
counted here.

**The habit this asks for:** when a comment says a guard defends against a
specific named hazard, write the test that feeds it that exact hazard — not a
test that the function returns something sensible. All three above would have
been caught at write time by one assertion each. A defensive comment is a
claim, and an unasserted claim is how these survive.

## Closed / Intentional (for clarity)

### Amtrak layer: merged, and all three prerequisites closed
Status: CLOSED 2026-09-14

All three are done. Permission was granted by email the same day — see DEVLOG
2026-09-14, which records the two research errors that reply corrected.

- **(1) capabilityGate — DONE**, commit `2ca6ec7`. Latches the layer off when
  the mirror stops answering, so a volunteer-run server going away no longer
  logs a warning every 120 s for as long as the tab is open. Deliberately
  diverges from `bartDepartures.js`: 403 latches, 503 does not, because Amtrak
  has no key and a 503 from that host reads as downtime, not misconfiguration.
- **(2) fieldGuards — DONE.** Code migrated in `ee13c33`; ENFORCEMENT added in
  `639c94b`, which is the half that was missing. `amtrakFeed.js` is now in
  `GUARDED_PARSERS`, and a bare numeric coercion there fails the suite —
  verified by injecting one and watching it fail, then reverting.
- **(3) boundary tests — DONE**, commit `80f3ad6`.

Kept rather than deleted, because the middle of it is the useful part: the layer
MERGED on 2026-09-14 with (1) not done and (2) only half done. This entry was
wrong in one direction before the merge and wrong in the other direction for
several hours after it. Both states follow.

---


**Permission is no longer the blocker** — granted by email 2026-09-14, see DEVLOG.
The layer merged to `delta-water-layers` that day. Two of the three
prerequisites below were done in that merge; **one was missed and one was only
half done**, and the entry stays open until they are closed:

- **(1) capabilityGate — NOT DONE.** `amtrakTrains.js` has zero references to
  `recordTransientFailure` / `recordCapabilitySuccess`. `bartDepartures.js` has
  four. The failure this guards against is live in `main` now.
- **(2) fieldGuards — HALF DONE.** The code was migrated (commit `ee13c33`), but
  `GUARDED_PARSERS` in `fieldGuards.test.mjs` is still `['bartEtd.js']`.
  Nothing stops a bare `Number(` being reintroduced into `amtrakFeed.js`.
- **(3) boundary tests — DONE**, commit `80f3ad6`.

Original text follows.

---

Status (historical): Open (blocked on permission; work items recorded)

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
