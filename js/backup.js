/*
 * What a backup file holds, before it is encrypted.
 *
 * Everything BlueObject can address: every program, protected program and
 * appvar the calculator holds, and the BLUEIDX index that records which of them
 * belong to which package. Lists, matrices, strings and pictures are not here,
 * and not by oversight -- their names are tokenised rather than ASCII and do
 * not fit the eight-byte name field the link uses, so the calculator cannot
 * name them over the wire at all.
 *
 * ```
 * 0   4   json length
 * 4   ..  the manifest, UTF-8 JSON
 * ..  ..  every body, raw, concatenated in manifest order
 * ```
 *
 * Bodies stay raw rather than going into the JSON. A full calculator is
 * megabytes, and base64 would add a third to that for no gain -- the whole
 * container is inside one AES-GCM ciphertext either way.
 *
 * The index goes in the manifest as hex because it is small, at most 64 KB and
 * usually a few hundred bytes, and having it in one readable field makes a
 * damaged backup diagnosable.
 */

import { crc32 } from './crc32.js';
import { isValidName, TYPE_NAMES } from './tifile.js';
import { isSystemVariable } from './install.js';

export const FORMAT = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2) {
    throw new Error('the backup index is not hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) throw new Error('the backup index is not hex');
    out[i] = byte;
  }
  return out;
}

/**
 * Assemble the plaintext of a backup.
 *
 * `variables` are `{ name, type, archived, body }`; `index` is the BLUEIDX bytes
 * exactly as INDEX_GET handed them over, device block already zeroed by the
 * calculator. The password hash is not in a backup and never has been.
 */
export function buildBackup({ calcId, blueObject, index, variables }) {
  const manifest = {
    format: FORMAT,
    created: new Date().toISOString(),
    calcId: calcId || '',
    blueObject: blueObject || '',
    index: toHex(index || new Uint8Array(0)),
    variables: variables.map((variable) => ({
      name: variable.name,
      type: variable.type,
      archived: !!variable.archived,
      bytes: variable.body.length,
      crc: crc32(variable.body),
    })),
  };

  const json = encoder.encode(JSON.stringify(manifest));
  let total = 4 + json.length;
  for (const variable of variables) total += variable.body.length;

  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);

  let at = 4 + json.length;
  for (const variable of variables) {
    out.set(variable.body, at);
    at += variable.body.length;
  }

  return out;
}

/**
 * Read one back, refusing anything that does not add up.
 *
 * As suspicious as blueidx.js is of an index, and for the same reason turned up
 * a notch: what comes out of here becomes programs on somebody's calculator. A
 * length is checked against the buffer before it is used, every body is checked
 * against the checksum recorded for it, every name against what TI-OS will
 * accept, and a reserved BLUE* name is refused outright -- a backup naming the
 * index or the running program is either damaged or hostile, and there is no
 * third reading of it.
 */
export function parseBackup(plain) {
  const bytes = new Uint8Array(plain);
  if (bytes.length < 4) throw new Error('the backup is too short to read');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(0, true);
  if (4 + jsonLength > bytes.length) {
    throw new Error('the backup ends inside its own manifest');
  }

  let manifest;
  try {
    manifest = JSON.parse(decoder.decode(bytes.subarray(4, 4 + jsonLength)));
  } catch {
    throw new Error('the backup manifest is not readable');
  }

  if (manifest?.format !== FORMAT) {
    throw new Error(`that backup is format ${manifest?.format} and this page `
      + `reads format ${FORMAT}`);
  }
  if (!Array.isArray(manifest.variables)) {
    throw new Error('the backup manifest lists no files');
  }

  const index = fromHex(manifest.index || '');
  const variables = [];
  let at = 4 + jsonLength;

  for (const entry of manifest.variables) {
    if (!isValidName(entry?.name)) {
      throw new Error(`the backup names a file the calculator will not accept: `
        + `${entry?.name}`);
    }
    /*
     * BLUEIDX travels as the index field and BLUE/BLUEUP come from the store.
     * A body under one of those names could only overwrite the program doing
     * the restoring or the record of what is installed.
     */
    if (isSystemVariable(entry.name)) {
      throw new Error(`${entry.name} is a name BlueObject reserves, and a `
        + `backup has no business carrying one`);
    }
    if (!(entry.type in TYPE_NAMES)) {
      throw new Error(`${entry.name} has a type this page cannot install `
        + `(0x${Number(entry.type).toString(16)})`);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0
        || at + entry.bytes > bytes.length) {
      throw new Error(`${entry.name} runs past the end of the backup`);
    }

    const body = bytes.slice(at, at + entry.bytes);
    if (crc32(body) !== entry.crc) {
      throw new Error(`${entry.name} does not match its checksum -- the backup `
        + `is damaged`);
    }

    variables.push({
      name: entry.name,
      type: entry.type,
      archived: !!entry.archived,
      body,
    });
    at += entry.bytes;
  }

  /*
   * Trailing bytes nothing accounts for. Harmless in themselves, but they mean
   * the file is not the file this manifest describes, and that is worth knowing
   * before it is written to a calculator.
   */
  if (at !== bytes.length) {
    throw new Error('the backup has more data than its manifest accounts for');
  }

  return { manifest, index, variables };
}

/** Everything a restore is about to write, in bytes. */
export function backupSize(variables) {
  return variables.reduce((sum, variable) => sum + variable.body.length, 0);
}
