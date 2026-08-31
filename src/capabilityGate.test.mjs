import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetCapabilityGateForTest,
  isCapabilityAvailable,
  isUnconfiguredStatus,
  markCapabilityUnavailable,
} from './capabilityGate.js';

test('only configuration answers latch; transient failures keep retrying', () => {
  // "Not configured" — the server or the provider account needs changing.
  for (const status of [401, 403, 501, 503]) {
    assert.equal(isUnconfiguredStatus(status), true, `${status} should latch`);
  }
  // "Try again" — rate limits, gateway errors, success, and the 0 used when no
  // response arrived at all (timeout / network blip).
  for (const status of [0, 200, 429, 500, 502, 504]) {
    assert.equal(isUnconfiguredStatus(status), false, `${status} must not latch`);
  }
});

test('a latched capability stays off and logs exactly once', () => {
  _resetCapabilityGateForTest();
  const logged = [];
  const originalInfo = console.info;
  console.info = (...args) => logged.push(args.join(' '));
  try {
    assert.equal(isCapabilityAvailable('AI HUD summary'), true);

    assert.equal(
      markCapabilityUnavailable('AI HUD summary', 'HTTP 503', 'set OPENAI_API_KEY in .env'),
      true,
      'the first mark reports that it latched',
    );
    assert.equal(isCapabilityAvailable('AI HUD summary'), false);

    // Every later poll must be a no-op: no second line in the console, which is
    // the whole point of the latch.
    assert.equal(
      markCapabilityUnavailable('AI HUD summary', 'HTTP 503', 'set OPENAI_API_KEY in .env'),
      false,
    );
    assert.equal(logged.length, 1);
    // The remedy is capability-specific and must survive into the message.
    assert.match(logged[0], /OPENAI_API_KEY/);
    assert.match(logged[0], /__gevCapabilities/);
  } finally {
    console.info = originalInfo;
  }
});

test('capabilities latch independently of one another', () => {
  _resetCapabilityGateForTest();
  const originalInfo = console.info;
  console.info = () => {};
  try {
    markCapabilityUnavailable('Nearby places', 'HTTP 403', 'enable the Places API');
    assert.equal(isCapabilityAvailable('Nearby places'), false);
    assert.equal(isCapabilityAvailable('AI HUD summary'), true);
  } finally {
    console.info = originalInfo;
  }
});

test('resetting re-arms the latch — the reload path', () => {
  _resetCapabilityGateForTest();
  const originalInfo = console.info;
  console.info = () => {};
  try {
    markCapabilityUnavailable('Nearby places', 'HTTP 403', 'enable the Places API');
    assert.equal(isCapabilityAvailable('Nearby places'), false);
    _resetCapabilityGateForTest();
    assert.equal(isCapabilityAvailable('Nearby places'), true);
  } finally {
    console.info = originalInfo;
  }
});
