import { test, equal, deepEqual, throws, bytesEqual, fromHex } from './harness.js';
import { readVariable, isValidName, TYPE_APPVAR } from '../js/tifile.js';

const fixtures = await (await fetch('tests/fixtures/fixtures.json')).json();

test('reads a program built by tools/make_fixtures.py', () => {
  const want = fixtures.variables.program;
  const got = readVariable(fromHex(want.bytes));
  equal(got.name, want.name);
  equal(got.type, want.type);
  equal(got.archived, want.archived);
  bytesEqual(got.body, fromHex(want.body), 'program body');
});

test('reads an appvar, and keeps its archive flag', () => {
  const want = fixtures.variables.appvar;
  const got = readVariable(fromHex(want.bytes));
  equal(got.name, want.name);
  equal(got.type, TYPE_APPVAR);
  equal(got.archived, false, 'this one was stored in RAM');
  bytesEqual(got.body, fromHex(want.body), 'appvar body');
});

test('a damaged file is refused rather than pushed', () => {
  /*
   * This is the one path where a malformed file becomes a program the
   * calculator will try to run, so it has to fail here and not later.
   */
  throws(() => readVariable(fromHex(fixtures.variables.corrupt)),
    'checksum', 'a flipped byte must fail the checksum');
});

test('rubbish is refused', () => {
  throws(() => readVariable(new Uint8Array(10)), 'too short');
  throws(() => readVariable(new Uint8Array(100)), 'bad signature');
});

test('names the calculator will and will not accept', () => {
  deepEqual(['SNAKE', 'A', 'ABCDEFGH'].map(isValidName), [true, true, true]);
  deepEqual(['', 'snake', '1SNAKE', 'ABCDEFGHI', 'A B'].map(isValidName),
    [false, false, false, false, false]);
});
