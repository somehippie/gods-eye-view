# KNOWN ISSUES

Updated: July 8, 2026

This file tracks active runtime issues only.

For the roadmap and open backlog, see the repository issue tracker.

---

## Open

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


### Two sources of truth for sprite layer order
Status: Open (mitigated, not eliminated)

Context:
- `SPRITE_LAYER_ORDER` in `spriteOrder.js` is the production list.
- `spriteOrder.test.mjs` used to hand-copy it into a local `ORDER` constant. That
  copy only SEEDED the fixtures, so a layer added to the real list but not to the
  copy was silently left out of every case — the tests kept passing while
  covering less. Exactly how `transit-vehicles` went unnoticed.

Mitigated 2026-09-19:
- `ORDER` is now `SPRITE_LAYER_ORDER` itself, so the fixture set can no longer
  drift from production.
- The expected sequences inside each assertion are still written out by hand,
  which is deliberate — deriving those too would make the test compare the list
  to itself and assert nothing. They are the real pin.

What is still open:
- Adding a layer means editing the production list AND every hand-written
  expected sequence. That is intended (the test should fail until someone states
  the new order on purpose), but it is a lockstep edit and nothing names that
  requirement at the call site beyond this entry and a comment in the test.

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


### 511 transit-vehicles proxy boundary coverage (closed 2026-09-19)
Resolved. `transitVehiclesProxy` is exported and takes an injectable `cacheDir`,
and `transitProxy.test.mjs` drives the real handler with `fetch` stubbed —
asserting both what it asked upstream for and what it served back. That was the
last of the three data proxies without it.

Writing it found the third instance of the gap it exists to catch: the proxy
sent NO User-Agent at all, so 511 had no way to identify or reach whoever was
polling them, and nothing would ever have said so. The assertion was
mutation-checked — removing the header fails that test and only that test.

---

### transit-vehicles sprite registration (closed 2026-09-19)
Resolved. `transit-vehicles` is now in `SPRITE_LAYER_ORDER`, placed above `ais`
so a train carrying its line reads and clicks ahead of a generic AIS contact.
There is no longer any overlap to trade off, because the layer became rail-only
in the same change.

The underlying class of bug — a registry silently accepting an id it will never
act on — was fixed rather than just this instance:
- `registerSpriteCollection` and `restoreSpriteOrderOnEnable` both warn once,
  naming the id and both remedies, instead of quietly doing nothing.
- A test scans every `registerSpriteCollection` call site in `src/` and fails if
  any id is missing from `SPRITE_LAYER_ORDER`, so the next one is caught in CI
  rather than by someone noticing a layer draws in the wrong order.

Third instance of this shape in the project; the first two were a layer
reporting stats under a name the manager never calls, and this same file's
enable path.

---

### Ferries deliberately excluded from the rail layer (closed 2026-09-19)
Not a defect. SF Bay Ferry publishes 15 boats and every one also broadcasts AIS,
so carrying them in `transit-vehicles` drew each boat twice — two independent
icons at one position, because nothing dedupes between the layers. Golden Gate
and Treasure Island publish no vehicles at all.

Options weighed: exact-name dedup is possible (511 uses the vessel NAME as the
vehicle id, and GTFS-RT carries no MMSI, so name is the only key) but needs a
cross-layer seam this codebase deliberately does not have, for 15 boats. Dropped
ferries instead: AIS is the sole maritime source, rail is the part it cannot
show, and no coupling was introduced.

---

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
