/**
 * Boundary tests for the BART proxy.
 *
 * WHY THIS FILE EXISTS. A first version of the proxy built the ETD url without
 * `orig`, which BART answers with 400 "Invalid orig" rather than defaulting.
 * The layer was dead end to end and **21 unit tests stayed green**, because
 * every one of them exercised the pure normalizer and nothing touched the
 * boundary where the code meets the network.
 *
 * That is the second time this project has had that exact gap — earlier it was
 * 22 tests green with nothing exercising line geometry. The shape is the same
 * both times: the pure function was covered and the seam was not.
 *
 * The minimum that closes it, and all this file does: drive the real proxy
 * handler with `fetch` stubbed by recorded fixtures, then assert BOTH what it
 * asked upstream for and what it served back. No live endpoint, no network, no
 * integration harness — the fixtures are real recorded responses committed
 * beside this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bartDeparturesProxy } from '../../vite.config.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const STATIONS = fixture('bart-stations.json');
const ETD_CLOSING = fixture('bart-etd-closing.json');

/**
 * Collect the handlers the plugin installs, keyed by the path it used.
 *
 * Each mount gets its OWN cache directory. The proxy's disk cache is otherwise
 * process-global and survives between instances, which made these tests
 * order-dependent: a later test mounted a fresh proxy, found the frame an
 * earlier one had written to `.gev-cache/`, and served it without any upstream
 * call — so an assertion about what was requested passed or failed depending on
 * which tests had run before it.
 */
const _tempDirs = [];
function mountProxy() {
  const routes = new Map();
  const cacheDir = mkdtempSync(join(tmpdir(), 'gev-bart-test-'));
  _tempDirs.push(cacheDir);
  const plugin = bartDeparturesProxy({ cacheDir });
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

/**
 * Stub global fetch with recorded responses, recording every URL requested.
 * Returns the list of requested URLs so a test can assert what was asked for.
 */
function stubFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, headers: init?.headers ?? {} });
    return handler(url);
  };
  return {
    calls,
    restore() { globalThis.fetch = real; },
  };
}

const ok = (body) => ({
  ok: true,
  status: 200,
  async text() { return body; },
});

function respondFromFixtures(url) {
  if (url.pathname.endsWith('stn.aspx')) return ok(STATIONS);
  if (url.pathname.endsWith('etd.aspx')) return ok(ETD_CLOSING);
  throw new Error(`unexpected upstream call: ${url}`);
}

async function callProxy(routes, { path = '/api/rail/bart', method = 'GET' } = {}) {
  const res = fakeRes();
  await routes.get(path)({ method, url: path }, res, () => {});
  return res;
}

test('the ETD request carries orig=ALL — the check that was missing', async () => {
  // THIS is the assertion that would have failed on the original bug. Without
  // orig, BART answers 400 and the layer renders nothing, while every
  // normalizer test still passes.
  const routes = mountProxy();
  const stub = stubFetch(respondFromFixtures);
  try {
    await callProxy(routes);
    const etd = stub.calls.find((call) => call.url.pathname.endsWith('etd.aspx'));
    assert.ok(etd, 'the proxy must actually call the ETD endpoint');
    assert.equal(etd.url.searchParams.get('orig'), 'ALL');
    assert.equal(etd.url.searchParams.get('cmd'), 'etd');
    assert.equal(etd.url.searchParams.get('json'), 'y');
  } finally {
    stub.restore();
  }
});

test('every upstream request identifies this app', async () => {
  const routes = mountProxy();
  const stub = stubFetch(respondFromFixtures);
  try {
    await callProxy(routes);
    assert.ok(stub.calls.length > 0);
    for (const call of stub.calls) {
      assert.match(call.headers['User-Agent'] ?? '', /^GodsEyeView\/[\d.]+ \(\+https:\/\//);
    }
  } finally {
    stub.restore();
  }
});

test('a key reaches the query string and never the path', async () => {
  const routes = mountProxy();
  const stub = stubFetch(respondFromFixtures);
  try {
    await callProxy(routes);
    for (const call of stub.calls) {
      assert.ok(call.url.searchParams.get('key'), 'every BART call needs a key');
      assert.match(call.url.pathname, /^\/api\/(stn|etd)\.aspx$/);
    }
  } finally {
    stub.restore();
  }
});

test('the served payload merges departures onto the FULL station list', async () => {
  // The recorded ETD fixture is a real 01:49 PDT response: 7 stations reporting
  // out of 50. All 50 must come back, or the map empties overnight.
  const routes = mountProxy();
  const stub = stubFetch(respondFromFixtures);
  try {
    const res = await callProxy(routes);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.count, 50, 'all stations, not only the reporting ones');
    assert.equal(body.open, 7, 'the fixture is a near-closed system');
    assert.equal(body.stations.length, 50);
    assert.equal(body.stations.filter((s) => s.departures.length === 0).length, 43);
  } finally {
    stub.restore();
  }
});

test('a second request inside the TTL serves cache and makes no upstream call', async () => {
  const routes = mountProxy();
  const stub = stubFetch(respondFromFixtures);
  try {
    await callProxy(routes);
    const afterFirst = stub.calls.length;
    const res = await callProxy(routes);
    assert.equal(res.headers['X-GEV-Cache'], 'HIT');
    assert.equal(stub.calls.length, afterFirst, 'a cache hit must not touch upstream');
  } finally {
    stub.restore();
  }
});

test('an upstream failure with no cached frame answers 502, not a broken 200', async () => {
  const routes = mountProxy();
  const stub = stubFetch(() => { throw new Error('network down'); });
  try {
    const res = await callProxy(routes);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'upstream_unavailable');
  } finally {
    stub.restore();
  }
});

test('a non-GET is refused before any upstream call', async () => {
  const routes = mountProxy();
  const stub = stubFetch(respondFromFixtures);
  try {
    const res = await callProxy(routes, { method: 'POST' });
    assert.equal(res.statusCode, 405);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('status reports the cadence the layer is actually polling at', async () => {
  const routes = mountProxy();
  const res = await callProxy(routes, { path: '/api/rail/bart/status' });
  const body = JSON.parse(res.body);
  assert.equal(body.ttlMs, 30_000);
  assert.equal(body.lastFetch, null);
  assert.equal(body.stale, true);
});
