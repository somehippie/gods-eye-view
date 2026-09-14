/**
 * Boundary tests for the Amtrak proxy.
 *
 * WHY THIS FILE EXISTS. The layer shipped to a parked branch with 17 passing
 * tests, every one of them against the pure normalizer, and none of them
 * touching the seam where the proxy meets the network. That is the same gap
 * that let the BART proxy build an ETD url without `orig` and stay green
 * through 21 tests, and the same gap that let a line-geometry bug through 22.
 * Three times is a pattern, not bad luck.
 *
 * For this upstream the seam carries something the normalizer can never see:
 * api.amtraker.com/docs states that a request WITHOUT a User-Agent is blocked
 * outright. A wrong or missing header is therefore a dead layer with a fully
 * green unit suite — exactly the `orig=ALL` shape. The maintainer also had to
 * write to us because the header we did send identified the wrong project, so
 * asserting its content here is not ceremony.
 *
 * Fixtures are recorded response shapes committed beside this file. No live
 * endpoint, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { amtrakTrainsProxy } from '../../vite.config.js';

const TRAINS = readFileSync(
  fileURLToPath(new URL('./fixtures/amtrak-trains-sample.json', import.meta.url)),
  'utf8',
);

const _tempDirs = [];

/**
 * Mount the plugin and collect its handlers by path.
 *
 * Each mount gets its OWN cache directory. The disk cache is otherwise
 * process-global and survives between instances, which makes these tests
 * order-dependent: a later test mounts a fresh proxy, finds the frame an
 * earlier one wrote, and never calls upstream — so an assertion about what was
 * requested passes or fails depending on what ran before it.
 */
function mountProxy() {
  const routes = new Map();
  const cacheDir = mkdtempSync(join(tmpdir(), 'gev-amtrak-test-'));
  _tempDirs.push(cacheDir);
  const plugin = amtrakTrainsProxy({ cacheDir });
  plugin.configureServer({ middlewares: { use: (path, handler) => routes.set(path, handler) } });
  return routes;
}

test.after(() => {
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

/** Stub global fetch, recording every url AND every header sent. */
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

const ok = (body) => ({ ok: true, status: 200, async text() { return body; } });
const refuse = (status) => ({ ok: false, status, async text() { return ''; } });

async function callProxy(routes, path = '/api/rail/amtrak') {
  const res = fakeRes();
  await routes.get(path)({ method: 'GET', url: path }, res, () => {});
  return res;
}

test('the upstream request carries a User-Agent — without one the host blocks it', async () => {
  // THE ASSERTION THIS FILE IS FOR. api.amtraker.com/docs: "If no User-Agent is
  // provided, your request will be blocked." No normalizer test can see this.
  const routes = mountProxy();
  const stub = stubFetch(() => ok(TRAINS));
  try {
    await callProxy(routes);
    const call = stub.calls[0];
    assert.ok(call, 'the proxy must actually call upstream');
    const ua = call.headers['User-Agent'];
    assert.ok(ua, 'a User-Agent must be sent');
    assert.match(ua, /^gods-eye-view-amtrak-proxy\//, 'must identify THIS integration');
    assert.doesNotMatch(ua, /GodsEyeView/, 'must not announce the host application');
    assert.match(ua, /\(\+.+\)/, 'must carry a reachable contact');
    assert.doesNotMatch(ua, /bilawalsidhu/, 'contact must not point at the upstream repo');
  } finally {
    stub.restore();
  }
});

test('the proxy calls the documented v3 trains endpoint and nothing else', async () => {
  const routes = mountProxy();
  const stub = stubFetch(() => ok(TRAINS));
  try {
    await callProxy(routes);
    assert.equal(stub.calls.length, 1, 'exactly one upstream call per refresh');
    const { url } = stub.calls[0];
    assert.equal(url.hostname, 'api-v3.amtraker.com');
    assert.equal(url.pathname, '/v3/trains');
  } finally {
    stub.restore();
  }
});

test('what crosses the wire is NORMALIZED but not yet filtered', async () => {
  // Pinning the real contract, which is not what the proxy's own doc comment
  // claimed. The proxy runs normalizeAmtrakTrains only; runningTrains is applied
  // client-side in amtrakTrains.js. So Predeparture and Completed rows DO cross
  // the wire and are dropped at render.
  //
  // Not a rendering bug — the client filters correctly — but the wire contract
  // is worth asserting rather than assuming, because payload size and "do
  // unobserved positions leave the server" both depend on it.
  const routes = mountProxy();
  const stub = stubFetch(() => ok(TRAINS));
  try {
    const res = await callProxy(routes);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const ids = body.trains.map((t) => t.id).sort();
    assert.deepEqual(ids, ['1-9', '448-9', '6-10', '97-8']);
    assert.equal(body.count, 4);
    assert.ok(Number.isFinite(body.fetchedAt));

    // The rows a caller must still filter, and the field that identifies them.
    const predeparture = body.trains.find((t) => t.id === '448-9');
    assert.equal(predeparture.state, 'Predeparture');
    assert.equal(predeparture.timestamp, null, 'no observation time — a schedule, not a fix');
  } finally {
    stub.restore();
  }
});

test('an upstream refusal serves the last good frame rather than an error', async () => {
  const routes = mountProxy();
  let stub = stubFetch(() => ok(TRAINS));
  try {
    await callProxy(routes);                       // warm the cache
  } finally { stub.restore(); }

  stub = stubFetch(() => refuse(429));
  try {
    const res = await callProxy(routes);
    assert.equal(res.statusCode, 200, 'a 429 must not become a client-facing error');
    const body = JSON.parse(res.body);
    assert.equal(body.count, 4, 'the last good frame is still served');
  } finally {
    stub.restore();
  }
});

test('the status route reports cache state without calling upstream', async () => {
  const routes = mountProxy();
  const stub = stubFetch(() => { throw new Error('status must not call upstream'); });
  try {
    const res = await callProxy(routes, '/api/rail/amtrak/status');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(stub.calls.length, 0);
    assert.ok('lastFetch' in body && 'ttlMs' in body);
  } finally {
    stub.restore();
  }
});
