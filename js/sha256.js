/*
 * SHA-256, for the sync password.
 *
 * WebCrypto, so the browser's own implementation is the one in use here and the
 * calculator's calc/src/sha256.c is checked against Python's hashlib. Three
 * implementations of one standard, none of them checking itself.
 *
 * crypto.subtle exists only in a secure context, which http://localhost is and
 * a plain http:// origin on the network is not -- so a page served to another
 * machine over http would find this missing. Better to say so plainly than to
 * fail at the moment somebody types their password.
 */

export function isAvailable() {
  return typeof crypto !== 'undefined' && !!crypto?.subtle;
}

async function digest(...parts) {
  if (!isAvailable()) {
    throw new Error('This page needs a secure context for password hashing. '
      + 'Open it over https, or as http://localhost.');
  }

  let length = 0;
  for (const part of parts) length += part.length;

  const joined = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { joined.set(part, at); at += part.length; }

  return new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
}

export function randomSalt(length = 16) {
  const salt = new Uint8Array(length);
  crypto.getRandomValues(salt);
  return salt;
}

const encoder = new TextEncoder();

/**
 * What the device block stores: SHA-256(salt || password).
 *
 * Computed here rather than on the calculator, so the password itself never
 * travels even when it is being set for the first time.
 */
export async function storedHash(salt, password) {
  return digest(salt, encoder.encode(password));
}

/**
 * The answer to a challenge: SHA-256(nonce || storedHash).
 *
 * The nonce is fresh per exchange, so a recorded answer cannot be replayed, and
 * the password never crosses the wire in any form.
 */
export async function challengeResponse(salt, nonce, password) {
  return digest(nonce, await storedHash(salt, password));
}
