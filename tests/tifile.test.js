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

test('the eleventh byte is not part of the signature', () => {
  /*
   * It is quoted as part of it almost everywhere, and it is not. Oiram's
   * OiramPK.8xv has an 'O' there and is otherwise an ordinary variable file
   * whose checksum validates -- requiring 0x00 rejected a real release.
   */
  const got = readVariable(fromHex(fixtures.variables.oddSignatureByte));
  equal(got.name, 'SNAKE');
  bytesEqual(got.body, fromHex(fixtures.variables.program.body),
    'the body reads back the same either way');
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

test('mixed case after the first letter is allowed', () => {
  /*
   * Not a nicety. The C libraries are named this way deliberately -- lowercase
   * keeps them out of reach of the homescreen, where they could be renamed or
   * deleted by accident -- and LibLoad is what nearly every C and ICE program
   * on the calculator loads itself through. An all-caps rule made the most
   * depended-on package in the store impossible to install, with an error
   * blaming the name.
   */
  deepEqual(['LibLoad', 'GRAPHX', 'CE2048SV'].map(isValidName),
    [true, true, true]);

  /* The first character still has to be a capital, which is TI's own rule. */
  deepEqual(['libload', 'lowerFirst'].map(isValidName), [false, false]);
});
