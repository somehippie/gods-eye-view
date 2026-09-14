import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { coordinateField, integerField, numericField, textField } from './fieldGuards.js';

/**
 * Parsers that read an external payload and must not coerce with bare
 * `Number()`. Adding a parser here is one line and a deliberate act; that is
 * the point. A blanket ban is not viable — `src/` has 502 bare `Number()`
 * calls, the overwhelming majority of them on values this app computed itself.
 *
 * ONE GOTCHA WHEN ADDING A FILE. The check below is a text scan over the raw
 * source and does not know a comment from a statement, so a file on this list
 * cannot spell the hazard out in prose either — a comment explaining the
 * coercion trips the guard that forbids it. That is exactly what happened when
 * `amtrakFeed.js` was added (2026-09-14): it failed on an explanatory comment,
 * not on any code. Write comments in these files to say what the fix DOES
 * ("parses through numericField", "null-coerces-to-zero hazard"), not to
 * restate the bug in its literal form.
 */
const GUARDED_PARSERS = ['bartEtd.js', 'amtrakFeed.js'];

test('every value that is not a number fails, rather than becoming zero', () => {
  // This is the whole bug. Number() maps all of these to 0, and 0 is a finite
  // latitude, a plausible car count and a believable speed.
  for (const blank of [null, undefined, '', '   ', [], false, true, {}, NaN]) {
    assert.equal(numericField(blank), null, `${JSON.stringify(blank)} must not become a number`);
  }
  assert.equal(numericField(0), 0, 'a real zero is still a real zero');
  assert.equal(numericField('0'), 0);
  assert.equal(numericField('37.696924'), 37.696924);
  assert.equal(numericField(-122.1), -122.1);
  assert.equal(numericField('nope'), null);
  assert.equal(numericField(Infinity), null);
});

test('integerField rejects fractions as well as blanks', () => {
  assert.equal(integerField('6'), 6);
  assert.equal(integerField(6), 6);
  assert.equal(integerField('6.5'), null);
  assert.equal(integerField(''), null);
  assert.equal(integerField(null), null);
});

test('textField rejects the literal string "null", which these feeds send', () => {
  assert.equal(textField(' Bay Fair '), 'Bay Fair');
  assert.equal(textField('null'), null);
  assert.equal(textField('NULL'), null);
  assert.equal(textField(''), null);
  assert.equal(textField(null), null);
  assert.equal(textField(0), '0');
});

test('a coordinate needs range as well as type, because every bug was finite', () => {
  assert.deepEqual(coordinateField('37.696924', '-122.126514'), {
    latitude: 37.696924, longitude: -122.126514,
  });
  // The three real defects all produced a FINITE coordinate, so finiteness was
  // never the missing check.
  assert.equal(coordinateField(null, '-122.1'), null);
  assert.equal(coordinateField('', '-122.1'), null);
  assert.equal(coordinateField(91, 0), null, 'latitude past the pole');
  assert.equal(coordinateField(0, 181), null, 'longitude past the antimeridian');
});

test('Null Island is rejected, because it usually means two blank fields', () => {
  assert.equal(coordinateField(0, 0), null);
  assert.equal(coordinateField('0', '0'), null);
  // But a real point on either axis alone is legitimate and must survive.
  assert.notEqual(coordinateField(0, -122.1), null, 'the equator is a real place');
  assert.notEqual(coordinateField(51.48, 0), null, 'Greenwich is a real place');
});

test('guarded parsers contain no bare Number() coercion', () => {
  // A lint rule would be the right home for this, but this repo has no ESLint
  // and a blanket ban is unworkable (502 call sites, nearly all fine). This is
  // the enforceable subset: an explicit list of parsers that read off-machine
  // data, checked by the suite that already runs.
  for (const file of GUARDED_PARSERS) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    // `Number.isFinite(` and friends carry a dot and are not matched.
    const offenders = source.match(/\bNumber\(/g) ?? [];
    assert.equal(
      offenders.length,
      0,
      `${file} coerces with bare Number(); use numericField/integerField from fieldGuards.js`,
    );
  }
});

test('the guard scan can actually fail', () => {
  // A search whose negative result has never been falsified is not evidence.
  const positiveControl = 'const lat = Number(row.lat);';
  assert.equal((positiveControl.match(/\bNumber\(/g) ?? []).length, 1);
  const negativeControl = 'if (Number.isFinite(x) && Number.isInteger(y)) return x;';
  assert.equal((negativeControl.match(/\bNumber\(/g) ?? []).length, 0);
});
