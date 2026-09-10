# Development log

Session-by-session record of what was investigated, what was measured, and what
was decided. Newest first.

`CHANGELOG.md` records what shipped. This records *why*, and — more usefully —
what turned out not to be possible, so it is not re-investigated. Numbers here
are measured unless labelled otherwise; where a measurement or a reading was
wrong, the correction is left in place rather than edited out.

---

## 2026-09-10 — Amtrak layer built, then parked pending permission

**Status: not shipped. Nothing Amtrak-related is registered or running.** The
work lives on the branch `amtrak-parked-pending-permission` and is not merged.

A complete national Amtrak train layer was built — normalizer, server-side
proxy, Cesium layer, tests, all green — and then parked, because the terms
question was asked in the wrong direction first and the right answer turned out
to matter.

**The framing error.** The initial check was against *Amtrak's* terms of use,
which 404 or return only page chrome, and the conclusion recorded was "no terms
located." That was the wrong party. Requests go to Amtraker, a volunteer-run
project that republishes Amtrak data; Amtrak's terms govern whether Amtraker may
republish, which is Amtraker's exposure, not a consumer's. **The document that
governs a consumer is Amtraker's own**, and it exists, is thorough, and is easy
to find — `https://amtraker.com/llms.txt` and the `piemadd/amtrak` README.

**What Amtraker actually requires:**

| Requirement | Detail |
|---|---|
| `User-Agent` identifying the project | Mandatory — "If no User-Agent is provided, your request will be blocked" |
| Attribution, ODC-By v1.0 | Adopted 2026-08-19. Interactive maps: bottom right corner |
| Rate limit / poll interval / caching | **None stated anywhere** |

The grace period to 2026-10-31 applies only to projects predating 2026-08-19.
A new integration owes compliance immediately.

**Why it is parked.** `llms.txt`, at the API root, addressing automated clients:

> You are allowed to display simple information (such as the list of stops,
> speed, train number, train name, etc) within your view, but anything complex
> (train location on a map, all trains, etc) the user should be directed to
> Amtraker.com instead.

That names this use case exactly — train location on a map, all trains. A
reading exists under which it addresses LLM agents answering questions rather
than map applications, and under which the README's "Interactive Maps"
attribution rule shows map use is contemplated. That reading does a lot of work
to reach yes, and `llms.txt` sits at the API root addressing automated clients,
which a polling proxy is. **Permission has been requested by email
(amtraker@piemadd.com, the channel the README names for licensing questions).
The layer stays parked until there is an answer.**

Reading around a volunteer's stated wishes to save a few days on a hobby map is
not a trade worth making.

**Measurements worth keeping**, whatever the answer:

- Amtrak's own feed is encrypted. `getTrainsData` answers 200 with ~492 KB of
  base64 AES ciphertext; `getTrainsRealtime` is now a 404.
- Fix age on the mirror: p50 2.7 min, p99 9.8 min, max 9.8 min (n=50).
- A null `updatedAt` correlates exactly with `Predeparture` — 9 of 9, twice,
  with zero nulls in any other state. Those rows carry a scheduled origin, not
  an observed position.
- **Cadence should be 300 s, not the 180 s first chosen.** The original
  reasoning leaned on a derived ~3.5 min per-train update period computed from
  position changes between polls. That figure is confounded: a train stopped at
  a station has its fix refresh while its position does not change, so the
  move count undercounts updates and *overstates* the period. Fix age is the
  sound basis — p50 2.7 min is server-side staleness no poll rate can reduce,
  so 300 s costs ~2 min of extra worst-case age on a dot already ~3 min old,
  for 40% less load on a volunteer's bandwidth. At 79 mph that is 6.6 miles
  between polls versus 4.0 — sub-pixel on a national map.

**Two bugs found by writing the tests**, both fixed on the parked branch:

- `trainLabel` deduplicated whole strings rather than token runs, so "Acela
  2150" plus train number "2150" produced "Acela 2150 2150". Same failure class
  as the multi-word-operator bug fixed in *fix(ui): dedupe a multi-word operator
  out of the copied line*.
- `Number(null)` is `0`, and `0` is a perfectly finite latitude. A row with a
  null `lat` passed the coordinate check and would have rendered a train in the
  Gulf of Guinea. The fix is a `typeof` guard, not a range check.

One piece of this work **did** land, because it is independent of Amtrak:
`directionToHeading` now reads single-letter cardinals in dedicated direction
fields.

---

## 2026-09-10 — Rail feed survey: what is actually available

Prompted by the rail/ferry layer feeling sparse. Four questions, probed rather
than read off documentation.

**Freight publishes nothing public and positional.** Confirmed, not assumed:

| Source | Result |
|---|---|
| FRA ArcGIS (`fragis.fra.dot.gov`) | Grade crossings, freight stations. Infrastructure only |
| `api.bnsf.com` | 403 — exists, gated behind a shipper account |
| UP / CSX / NS customer portals | Login-walled shipment tracking, not train positions |

The Class I customer APIs track a railcar, not a train, and need a commercial
relationship. The only real-time freight position data in the US is commercial
sensor networks or hobbyist signal decoding. **Closed — do not revisit.**

**There is no national GTFS-RT aggregator.** Measured against the Mobility
Database catalog: 386 feeds worldwide carry vehicle positions, 176 resolve to
the US across 156 distinct providers, 76 of those behind an API key. 511.org is
Bay Area only. Transitland and the Mobility Database are catalogs of feeds, not
live aggregators. National commuter rail coverage means 25–30 separate
integrations, each with its own key, quota and id conventions. **Scoped out.**

**Why the existing rail/ferry layer looks sparse**, in order of size:

1. `RAIL_FERRY_AGENCIES` is a seven-agency allowlist. Muni Metro and VTA light
   rail publish positions and are dropped by it. That is a product call, not a
   data limit — and it has not been quantified. Measuring the pre-filter counts
   at a weekday rush hour is still outstanding, and needs one instrumented
   frame, since the proxy filters before caching.
2. BART is genuinely absent — it publishes no vehicle positions anywhere.
3. Time of day. A live frame at 00:56 PDT carried **two** vehicles. The
   remembered figure of 43 was a daytime number.

---

## 2026-09-10 — Startup diagnosis: orphaned dev servers

The app was not loading in Chrome. No recent commit was capable of breaking
startup — the Vite config imports clean, the transit proxy is fully lazy with no
work at boot, the new layer appears in both `main.js` and `LAYER_STATE_REGISTRY`,
and the suite was green.

The cause was environmental — though that the orphans *explain* the blank page
is inference, not observation. No browser console was ever read. What was
measured is below; the causal link was not.

Four orphaned Vite processes from the previous evening still held ports
4173–4176, so a fresh `npm run dev` walked to 4177 and `localhost:4173` was
being answered by a six-hour-old server. That server was serving
`/src/main.js` pinned to an HMR timestamp older than the three most recent
commits. Four servers watching one tree also compete for Windows file-watch
handles, which is how a module graph ends up half-updated.

Every listener was bound to `::1` only, not `127.0.0.1` — worth knowing when
`localhost` resolves to IPv4 and the connection is refused with no server-side
trace.

**Check the port before debugging the code.** If `npm run dev` does not print
`4173`, an orphan is still up and the code under test is not the code being
served.

**And read the console before reloading.** A full page load spends one of the
project's eight daily Google 3D Tiles root-tileset sessions, so reloading to
diagnose a blank page is the fastest way to exhaust the quota and turn a fixable
bug into a black globe that looks like the same bug. If the UI loads but the
globe stays black, check the network panel for a 403 on `tile.googleapis.com`
before suspecting the code.
