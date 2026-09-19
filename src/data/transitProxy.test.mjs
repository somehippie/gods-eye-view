/**
 * Boundary tests for the 511 transit-vehicles proxy.
 *
 * WHY THIS FILE EXISTS. This was the last of the three data proxies with no
 * coverage at the seam where it meets the network — the same gap that shipped a
 * broken BART url past 21 green unit tests and an unasserted User-Agent past 17
 * on Amtrak. Writing it found a third instance of the same shape immediately:
 * this proxy sent NO User-Agent at all, so 511 had no way to identify or reach
 * whoever was polling them, and nothing anywhere would have said so.
 *
 * Same method as bartProxy.test.mjs: drive the real handler with `fetch`
 * stubbed, then assert BOTH what it asked upstream for and what it served back.
 *
 * ON THE PAYLOAD. The other proxies in this project stub with recorded JSON
 * fixtures. 511 answers in protobuf, and a real combined `agency=RG` capture is
 * ~200 KB — ten times the largest fixture in the repo — for a file whose job
 * here is to be *a valid body*, not to be interesting. The decoder's fidelity
 * to real 511 bytes is already pinned by gtfsRealtime.test.mjs against two
 * committed real captures, so this file builds small spec-shaped payloads
 * instead and spends its assertions on the seam.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transitVehiclesProxy } from '../../vite.config.js';

// --- minimal GTFS-Realtime encoder (mirrors gtfsRealtime.test.mjs) ----------
const varint = (value) => {
  const out = [];
  let v = BigInt(value);
  do { const byte = Number(v & 0x7fn); v >>= 7n; out.push(v > 0n ? byte | 0x80 : byte); } while (v > 0n);
  return out;
};
const tag = (field, wire) => varint((BigInt(field) << 3n) | BigInt(wire));
const uint = (field, value) => [...tag(field, 0), ...varint(value)];
const bytes = (field, payload) => [...tag(field, 2), ...varint(payload.length), ...payload];
const text = (field, value) => bytes(field, [...Buffer.from(value, 'utf8')]);
const float = (field, value) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value);
  return [...tag(field, 5), ...b];
};
const header = (ts) => bytes(1, [...text(1, '1.0'), ...uint(2, 0), ...uint(3, ts)]);

/** One FeedEntity carrying a VehiclePosition, RG-style (prefixed route id). */
const vehicle = ({ id, routeId, vehicleId, lat, lon, ts }) => bytes(2, [
  ...text(1, id),
  ...bytes(4, [
    ...bytes(1, [...text(5, routeId)]),
    ...bytes(2, [...float(1, lat), ...float(2, lon)]),
    ...uint(5, ts),
    ...bytes(8, [...text(1, vehicleId)]),
  ]),
]);

const FEED_TS = 1789002837;
/** Two trains the proxy must keep, and a ferry and two buses it must drop. */
const REGIONAL_FEED = Buffer.from([
  ...header(FEED_TS),
  ...vehicle({ id: '1', routeId: 'CT:Local Weekday', vehicleId: '144', lat: 37.3736, lon: -122.0149, ts: FEED_TS - 10 }),
  ...vehicle({ id: '2', routeId: 'AM:CC', vehicleId: '2102', lat: 37.8115, lon: -122.3045, ts: FEED_TS - 5 }),
  ...vehicle({ id: '3', routeId: 'SB:SEA', vehicleId: 'Carina', lat: 37.7948, lon: -122.3913, ts: FEED_TS - 8 }),
  ...vehicle({ id: '4', routeId: 'AC:98', vehicleId: '6111', lat: 37.7304, lon: -122.1911, ts: FEED_TS - 3 }),
  ...vehicle({ id: '5', routeId: 'SF:1', vehicleId: '1', lat: 37.8068, lon: -122.4208, ts: FEED_TS - 4 }),
]);

const _tempDirs = [];
function mountProxy() {
  const routes = new Map();
  const cacheDir = mkdtempSync(join(tmpdir(), 'gev-transit-test-'));
  _tempDirs.push(cacheDir);
  const plugin = transitVehiclesProxy({ cacheDir });
  plugin.configureServer({ middlewares: { use: (path, handler) => routes.set(path, handler) } });
  return routes;
}

test.after(async () => {
  // The proxy writes its disk cache fire-and-forget (`void writeDisk`), so a
  // write can still be in flight here. Removing the directory underneath it
  // logs a harmless ENOENT; one turn of the loop lets it land first.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const dir of _tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Minimal res double — the proxy only uses writeHead and end. */
function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { res.body = body; res.done = true; },
  };
  return res;
}

function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, headers: init?.headers ?? {} });
    return handler(url);
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

const okProtobuf = (body) => ({
  ok: true,
  status: 200,
  async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); },
});

const serveFeed = () => okProtobuf(REGIONAL_FEED);

async function callProxy(routes, { path = '/api/transit/vehicles', method = 'GET' } = {}) {
  const res = fakeRes();
  await routes.get(path)({ method, url: path }, res, () => {});
  return res;
}

/** The proxy reads the token from the environment at call time. */
function withToken(value, run) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'FIVEONEONE_TOKEN');
  const previous = process.env.FIVEONEONE_TOKEN;
  if (value === null) delete process.env.FIVEONEONE_TOKEN;
  else process.env.FIVEONEONE_TOKEN = value;
  return (async () => {
    try { return await run(); } finally {
      if (had) process.env.FIVEONEONE_TOKEN = previous;
      else delete process.env.FIVEONEONE_TOKEN;
    }
  })();
}

// ---------------------------------------------------------------------------

test('the upstream request asks for the combined feed, not one agency', async () => {
  // agency=RG is the whole reason one call covers seven operators. Asking per
  // agency would be seven calls against a 60/hour budget.
  await withToken('test-token', async () => {
    const routes = mountProxy();
    const stub = stubFetch(serveFeed);
    try {
      await callProxy(routes);
      assert.equal(stub.calls.length, 1, 'exactly one upstream call per refresh');
      assert.equal(stub.calls[0].url.searchParams.get('agency'), 'RG');
      assert.equal(stub.calls[0].url.pathname, '/transit/vehiclepositions');
    } finally { stub.restore(); }
  });
});

test('every upstream request identifies this integration — the check that was missing', async () => {
  // THIS is the assertion that would have failed before this file existed: the
  // proxy sent no User-Agent at all, so 511 had no way to reach whoever was
  // polling them. It names the integration, not the host app, and carries a
  // contact that is not the upstream repository this project derives from.
  await withToken('test-token', async () => {
    const routes = mountProxy();
    const stub = stubFetch(serveFeed);
    try {
      await callProxy(routes);
      assert.ok(stub.calls.length > 0);
      for (const call of stub.calls) {
        const agent = call.headers['User-Agent'] ?? '';
        assert.match(agent, /^gods-eye-view-transit-proxy\/[\d.]+ \(\+.+\)$/);
        assert.doesNotMatch(agent, /github\.com/, 'the contact must be reachable, not the upstream repo');
      }
    } finally { stub.restore(); }
  });
});

test('the token reaches the query string and never the path', async () => {
  await withToken('secret-token', async () => {
    const routes = mountProxy();
    const stub = stubFetch(serveFeed);
    try {
      await callProxy(routes);
      const { url } = stub.calls[0];
      assert.equal(url.searchParams.get('api_key'), 'secret-token');
      assert.equal(url.pathname, '/transit/vehiclepositions');
      assert.doesNotMatch(url.pathname, /secret-token/);
    } finally { stub.restore(); }
  });
});

test('the served payload keeps rail and drops the buses and ferries', async () => {
  // The feed is ~2,000 vehicles at rush hour and all but ~40 are buses. The
  // filter runs server-side, so this asserts what actually crosses the wire.
  await withToken('test-token', async () => {
    const routes = mountProxy();
    const stub = stubFetch(serveFeed);
    try {
      const res = await callProxy(routes);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.count, 2, 'two trains; the ferry and both buses are dropped');
      assert.deepEqual(body.vehicles.map((v) => v.id), ['CT:144', 'AM:2102']);
      // The ferry is dropped on purpose: AIS already draws that boat, and
      // nothing dedupes between the two layers.
      assert.ok(!body.vehicles.some((v) => v.id.startsWith('SB:')), 'no ferries');
      assert.equal(body.feedTimestamp, FEED_TS);
      assert.equal(body.stale, false);
    } finally { stub.restore(); }
  });
});

test('a second request inside the TTL serves cache and makes no upstream call', async () => {
  await withToken('test-token', async () => {
    const routes = mountProxy();
    const stub = stubFetch(serveFeed);
    try {
      await callProxy(routes);
      const afterFirst = stub.calls.length;
      const res = await callProxy(routes);
      assert.equal(res.headers['X-GEV-Cache'], 'HIT');
      assert.equal(stub.calls.length, afterFirst, 'a cache hit must not spend quota');
    } finally { stub.restore(); }
  });
});

test('no token means no upstream call at all, and a 503 the layer can read', async () => {
  await withToken(null, async () => {
    const routes = mountProxy();
    const stub = stubFetch(serveFeed);
    try {
      const res = await callProxy(routes);
      assert.equal(res.statusCode, 503);
      assert.equal(JSON.parse(res.body).error, 'no_key');
      assert.equal(stub.calls.length, 0, 'an unconfigured proxy must never touch 511');
    } finally { stub.restore(); }
  });
});

test('an upstream 429 answers 429, not a broken 200, and backs off locally', async () => {
  // 511 sends no Retry-After and no reset header, and its quota is a fixed
  // hourly window — so a throttle means an hour of nothing. The proxy must
  // stop asking rather than hammer a closed door.
  await withToken('test-token', async () => {
    const routes = mountProxy();
    const stub = stubFetch(() => ({ ok: false, status: 429, async arrayBuffer() { return new ArrayBuffer(0); } }));
    try {
      const res = await callProxy(routes);
      assert.equal(res.statusCode, 429);
      assert.equal(JSON.parse(res.body).error, 'upstream_throttled');
      const afterFirst = stub.calls.length;
      await callProxy(routes);
      assert.equal(stub.calls.length, afterFirst, 'the backoff must suppress the next attempt');
    } finally { stub.restore(); }
  });
});

test('a throttle after a good frame serves the last good frame, not an error', async () => {
  await withToken('test-token', async () => {
    const routes = mountProxy();
    let throttle = false;
    const stub = stubFetch(() => (throttle
      ? { ok: false, status: 429, async arrayBuffer() { return new ArrayBuffer(0); } }
      : serveFeed()));
    try {
      await callProxy(routes);
      throttle = true;
      // Force the cached frame past its TTL so the next call must refresh.
      const originalNow = Date.now;
      Date.now = () => originalNow() + 10 * 60_000;
      try {
        const res = await callProxy(routes);
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['X-GEV-Cache'], 'STALE-THROTTLED');
        const body = JSON.parse(res.body);
        assert.equal(body.stale, true);
        assert.equal(body.count, 2, 'the last good vehicles are still served');
      } finally { Date.now = originalNow; }
    } finally { stub.restore(); }
  });
});

test('an upstream failure with no cached frame answers 502', async () => {
  await withToken('test-token', async () => {
    const routes = mountProxy();
    const stub = stubFetch(() => { throw new Error('network down'); });
    try {
      const res = await callProxy(routes);
      assert.equal(res.statusCode, 502);
      assert.equal(JSON.parse(res.body).error, 'upstream_unavailable');
    } finally { stub.restore(); }
  });
});

test('a non-GET is refused before any upstream call', async () => {
  await withToken('test-token', async () => {
    const routes = mountProxy();
    const stub = stubFetch(serveFeed);
    try {
      const res = await callProxy(routes, { method: 'POST' });
      assert.equal(res.statusCode, 405);
      assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
  });
});

test('status reports the cadence the layer is actually polling at', async () => {
  await withToken('test-token', async () => {
    const routes = mountProxy();
    const res = await callProxy(routes, { path: '/api/transit/status' });
    const body = JSON.parse(res.body);
    assert.equal(body.ttlMs, 90_000, 'the measured 40-calls/hour cadence');
    assert.equal(body.hasKey, true);
    assert.equal(body.lastFetch, null);
    assert.equal(body.stale, true);
  });
});

test('status reports hasKey false without a token, and still answers', async () => {
  await withToken(null, async () => {
    const routes = mountProxy();
    const res = await callProxy(routes, { path: '/api/transit/status' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).hasKey, false);
  });
});
