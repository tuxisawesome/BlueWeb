/*
 * The backup container and the encryption around it.
 *
 * Two halves with different jobs. buildBackup/parseBackup is a byte format, and
 * the tests that matter there are the ones that feed it something wrong: what
 * comes out of a backup becomes programs on somebody's calculator, so it is
 * refused whole or believed whole and there is nothing in between.
 *
 * The crypt half is checked for the property that is easy to lose by accident
 * -- that a file which has been edited fails rather than decrypts. AES-GCM
 * gives that for the ciphertext on its own; the header only gets it because it
 * is passed in as additional authenticated data, and nothing else would notice
 * if that stopped happening.
 */

import { test, equal, assert, deepEqual, throws, bytesEqual } from './harness.js';
import { buildBackup, parseBackup, backupSize } from '../js/backup.js';
import { encrypt, decrypt, HEADER_SIZE } from '../js/crypt.js';
import { crc32 } from '../js/crc32.js';
import { deleteVariables } from '../js/install.js';

const bytes = (...values) => new Uint8Array(values);

function sample() {
  return {
    calcId: '0011223344556677',
    blueObject: '1.2.0',
    index: bytes(1, 2, 3, 4, 5),
    variables: [
      { name: 'SNAKE', type: 0x05, archived: true, body: bytes(9, 8, 7, 6) },
      { name: 'SNAKESAV', type: 0x15, archived: false, body: bytes(1) },
      /* A file somebody saved empty. Not a hypothetical: a game writing its
       * save before there is anything to save produces exactly this, and a
       * container that cannot express it would refuse to back the calculator
       * up at all. */
      { name: 'Empty', type: 0x15, archived: true, body: new Uint8Array(0) },
    ],
  };
}

test('a backup round-trips names, types, archive flags and bodies', () => {
  const source = sample();
  const parsed = parseBackup(buildBackup(source));

  equal(parsed.manifest.calcId, source.calcId, 'calculator id');
  equal(parsed.manifest.blueObject, source.blueObject, 'BlueObject version');
  bytesEqual(parsed.index, source.index, 'the index');
  equal(parsed.variables.length, 3, 'file count');

  for (let at = 0; at < source.variables.length; at++) {
    const was = source.variables[at];
    const now = parsed.variables[at];
    equal(now.name, was.name, `name ${at}`);
    equal(now.type, was.type, `type ${at}`);
    equal(now.archived, was.archived, `archived ${at}`);
    bytesEqual(now.body, was.body, `body ${at}`);
  }
});

test('a body at the format ceiling survives', () => {
  const body = new Uint8Array(65512);
  for (let i = 0; i < body.length; i++) body[i] = i & 0xff;

  const parsed = parseBackup(buildBackup({
    calcId: 'x', blueObject: '1.2.0', index: new Uint8Array(0),
    variables: [{ name: 'BIG', type: 0x15, archived: true, body }],
  }));

  bytesEqual(parsed.variables[0].body, body, 'the whole body');
  equal(backupSize(parsed.variables), 65512, 'reported size');
});

test('a backup with no index at all is still a backup', () => {
  const parsed = parseBackup(buildBackup({
    calcId: 'x', blueObject: '1.2.0', index: new Uint8Array(0),
    variables: [{ name: 'LOOSE', type: 0x05, archived: true, body: bytes(1, 2) }],
  }));
  equal(parsed.index.length, 0, 'empty index');
  equal(parsed.variables.length, 1, 'the file is still there');
});

test('a truncated backup is refused', () => {
  const whole = buildBackup(sample());
  throws(() => parseBackup(whole.subarray(0, whole.length - 3)), undefined,
    'a file cut short must not parse');
  throws(() => parseBackup(new Uint8Array(2)), undefined, 'shorter than its own length');
});

test('a backup whose manifest is not JSON is refused', () => {
  const whole = buildBackup(sample());
  whole[6] = 0x7b;  /* inside the manifest text */
  throws(() => parseBackup(whole), undefined, 'damaged manifest');
});

test('a body that does not match its checksum is refused', () => {
  const whole = buildBackup(sample());
  /* The last byte is inside the final body, past every length field. */
  whole[whole.length - 1] ^= 0xff;
  throws(() => parseBackup(whole), 'checksum', 'a flipped byte in a body');
});

/*
 * The one that is a security property rather than a correctness one. A backup
 * naming BLUEIDX would overwrite the record of what is installed and the device
 * block behind it; one naming BLUE would overwrite the program doing the
 * restoring. Neither is a thing a real backup contains.
 */
test('a backup carrying a reserved name is refused', () => {
  const whole = buildBackup({
    calcId: 'x', blueObject: '1.2.0', index: new Uint8Array(0),
    variables: [{ name: 'BLUEIDX', type: 0x15, archived: true, body: bytes(1) }],
  });
  throws(() => parseBackup(whole), 'reserves', 'BLUE* must not come out of a file');
});

test('a backup naming a file TI-OS would not accept is refused', () => {
  const whole = buildBackup({
    calcId: 'x', blueObject: '1.2.0', index: new Uint8Array(0),
    variables: [{ name: 'lower', type: 0x05, archived: true, body: bytes(1) }],
  });
  throws(() => parseBackup(whole), undefined, 'a name with no capital');
});

test('a backup from a later format is refused rather than guessed at', () => {
  const json = new TextEncoder().encode(JSON.stringify({ format: 9, variables: [] }));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  throws(() => parseBackup(out), 'format', 'a newer format must not be read');
});

test('the checksums a backup records are the ones crc32 computes', () => {
  const source = sample();
  const parsed = parseBackup(buildBackup(source));
  deepEqual(parsed.manifest.variables.map((v) => v.crc),
    source.variables.map((v) => crc32(v.body)), 'per-file checksums');
});

/* ------------------------------------------------------------ encryption */

test('a file encrypts and decrypts back to the same bytes', async () => {
  const plain = buildBackup(sample());
  const file = await encrypt(plain, 'correct horse');
  assert(file.length > HEADER_SIZE, 'there is a ciphertext');
  bytesEqual(await decrypt(file, 'correct horse'), plain, 'round trip');
});

test('the wrong password does not open a file', async () => {
  const file = await encrypt(buildBackup(sample()), 'correct horse');
  let threw = false;
  try {
    await decrypt(file, 'correct horsf');
  } catch (error) {
    threw = true;
    assert(error.message.includes('password'), 'says what is wrong');
  }
  assert(threw, 'a wrong password must not decrypt');
});

test('a flipped byte in the ciphertext fails', async () => {
  const file = await encrypt(buildBackup(sample()), 'correct horse');
  file[file.length - 5] ^= 0x01;
  let threw = false;
  try { await decrypt(file, 'correct horse'); } catch { threw = true; }
  assert(threw, 'a damaged ciphertext must not decrypt');
});

/*
 * The header is not encrypted, only authenticated, and it would be very easy to
 * leave it out of the additional authenticated data without anything else
 * noticing. Then an edited salt would simply produce a wrong key and the same
 * "wrong password" as a typo -- the file would have been tampered with and
 * nothing would say so.
 */
test('a flipped byte in the header fails too', async () => {
  const file = await encrypt(buildBackup(sample()), 'correct horse');
  file[14] ^= 0x01;  /* inside the PBKDF2 salt */
  let threw = false;
  try { await decrypt(file, 'correct horse'); } catch { threw = true; }
  assert(threw, 'an edited header must not decrypt');
});

test('a file that is not a backup is refused before any key work', async () => {
  const notABackup = new Uint8Array(200);
  let threw = false;
  try { await decrypt(notABackup, 'anything'); } catch (error) {
    threw = true;
    assert(error.message.includes('not a BlueObject backup'), 'says what it is');
  }
  assert(threw, 'bad magic must be refused');
});

/* -------------------------------------------------------- bulk deletion */

class DeletingCalculator {
  constructor({ refuse = [] } = {}) {
    this.refuse = refuse;
    this.gone = [];
  }

  async deleteVariable(name) {
    if (this.refuse.includes(name)) throw new Error(`${name} is in use`);
    this.gone.push(name);
    return true;
  }
}

test('deleting several deletes all of them', async () => {
  const calculator = new DeletingCalculator();
  const list = [{ name: 'A', type: 5 }, { name: 'B', type: 5 }, { name: 'C', type: 5 }];
  const { deleted, failed } = await deleteVariables(calculator, list);

  deepEqual(calculator.gone, ['A', 'B', 'C'], 'all three, in order');
  equal(deleted.length, 3, 'all reported deleted');
  equal(failed.length, 0, 'nothing failed');
});

/*
 * The behaviour the panel depends on. Somebody clearing out a dozen leftovers
 * has already said what they want done with all twelve; stopping at the one
 * that will not go would leave them to work out which nine are still there.
 */
test('one that will not go does not abandon the rest', async () => {
  const calculator = new DeletingCalculator({ refuse: ['B'] });
  const list = [{ name: 'A', type: 5 }, { name: 'B', type: 5 }, { name: 'C', type: 5 }];
  const { deleted, failed } = await deleteVariables(calculator, list);

  deepEqual(calculator.gone, ['A', 'C'], 'the other two still went');
  equal(deleted.length, 2, 'two deleted');
  equal(failed.length, 1, 'one failure recorded');
  equal(failed[0].variable.name, 'B', 'and it names which');
});

test('deleting reports progress for every step and then the end', async () => {
  const calculator = new DeletingCalculator();
  const seen = [];
  await deleteVariables(calculator,
    [{ name: 'A', type: 5 }, { name: 'B', type: 5 }],
    ({ variable, done, total }) => seen.push(`${variable?.name ?? '-'}:${done}/${total}`));

  deepEqual(seen, ['A:0/2', 'B:1/2', '-:2/2'], 'each step, then done');
});
