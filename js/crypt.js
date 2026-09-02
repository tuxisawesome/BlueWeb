/*
 * The encryption around a backup file.
 *
 * A backup is the entire contents of somebody's calculator sitting as a file on
 * a disk, so it is encrypted before it is written. The key comes from a
 * passphrase -- the calculator's sync password where there is one, and a
 * passphrase for the file alone where there is not.
 *
 * All of this is the browser's. The calculator has SHA-256 and no cipher, no
 * key schedule and no random number generator worth the name -- auth.c's nonce
 * is documented as unrepeated rather than unguessable -- so encrypting on that
 * side would mean writing a cipher for a machine that cannot check its own
 * work. The cable is a wire between two devices in the same room; the file is
 * the thing that travels.
 *
 * Deliberately *not* keyed on the digest the calculator stores. SHA-256(salt ||
 * password) is the right thing to answer a challenge with over a cable, where a
 * guess has to be submitted one at a time into a counter. It is the wrong thing
 * to key a file with, where an attacker holds the ciphertext and can guess as
 * fast as their hardware allows. The password is the shared secret; its
 * unstretched digest is not a key.
 */

import { isAvailable } from './sha256.js';

const MAGIC = [0x42, 0x4c, 0x55, 0x45, 0x42, 0x41, 0x4b, 0x00];  /* "BLUEBAK\0" */
const FORMAT = 1;

const SALT_AT = 12;
const SALT_SIZE = 16;
const IV_AT = 28;
const IV_SIZE = 12;
const LENGTH_AT = 40;

/* The header is authenticated but not encrypted, so it is also the AAD. */
export const HEADER_SIZE = 44;

/*
 * PBKDF2, at the iteration count OWASP currently gives for SHA-256.
 *
 * It costs about half a second in a browser, once per backup or restore, and it
 * is the entire difference between a weak passphrase being worth guessing and
 * not. Nobody types this in a loop.
 */
const ITERATIONS = 600000;

const encoder = new TextEncoder();

function unavailable() {
  return new Error('This page needs a secure context to encrypt a backup. '
    + 'Open it over https, or as http://localhost.');
}

async function keyFrom(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']);
}

/**
 * Wrap plaintext into a backup file.
 *
 * ```
 * 0   8   magic "BLUEBAK\0"
 * 8   1   format version
 * 9   3   reserved
 * 12  16  PBKDF2 salt
 * 28  12  AES-GCM IV
 * 40  4   ciphertext length
 * 44  ..  ciphertext, tag included
 * ```
 *
 * Bytes 0..39 of the header -- everything but the length -- go in as additional
 * authenticated data, so a file whose magic, format or salt has been edited
 * fails to decrypt rather than being believed and acted on. The length cannot
 * join them, because it is not known until the ciphertext exists; it is checked
 * structurally instead, against how long the file actually is. Nothing in a
 * header is secret; all of it is load-bearing.
 */
export async function encrypt(plain, passphrase) {
  if (!isAvailable()) throw unavailable();

  const salt = crypto.getRandomValues(new Uint8Array(SALT_SIZE));
  const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE));
  const key = await keyFrom(passphrase, salt);

  const header = new Uint8Array(HEADER_SIZE);
  header.set(MAGIC, 0);
  header[8] = FORMAT;
  header.set(salt, SALT_AT);
  header.set(iv, IV_AT);

  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: header.subarray(0, LENGTH_AT) },
    key, plain));

  new DataView(header.buffer).setUint32(LENGTH_AT, cipher.length, true);

  const out = new Uint8Array(HEADER_SIZE + cipher.length);
  out.set(header, 0);
  out.set(cipher, HEADER_SIZE);
  return out;
}

/** The other direction. Throws on a wrong passphrase or a damaged file. */
export async function decrypt(file, passphrase) {
  if (!isAvailable()) throw unavailable();

  const bytes = new Uint8Array(file);
  if (bytes.length < HEADER_SIZE) {
    throw new Error('that file is too short to be a backup');
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('that is not a BlueObject backup');
  }
  if (bytes[8] !== FORMAT) {
    throw new Error(`that backup is format ${bytes[8]} and this page reads `
      + `format ${FORMAT}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(LENGTH_AT, true);
  if (HEADER_SIZE + length !== bytes.length) {
    throw new Error('that backup file is truncated');
  }

  const key = await keyFrom(passphrase, bytes.subarray(SALT_AT, SALT_AT + SALT_SIZE));

  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.subarray(IV_AT, IV_AT + IV_SIZE),
        additionalData: bytes.subarray(0, LENGTH_AT),
      },
      key, bytes.subarray(HEADER_SIZE)));
  } catch {
    /*
     * AES-GCM fails closed and says nothing about why -- a wrong key and a
     * flipped byte arrive as the same bare OperationError. The wrong password
     * is overwhelmingly the likelier of the two and the only one the person
     * reading this can do anything about, so that is what it says.
     */
    throw new Error('that password does not open this backup');
  }
}
