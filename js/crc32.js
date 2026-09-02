/*
 * CRC-32, the ordinary reflected one (polynomial 0xEDB88320).
 *
 * Deliberately a second implementation of what BlueObject's calc/src/crc32.c
 * does. They are independent, they must agree, and agreeing is evidence -- one
 * implementation checking its own output against itself would be none.
 *
 * Table-free, matching the calculator's version, which cannot spare a kilobyte
 * of RAM for a lookup table.
 */

export const CRC32_INIT = 0xffffffff;

export function crc32Update(crc, data) {
  for (const byte of data) {
    crc = (crc ^ byte) >>> 0;
    for (let bit = 0; bit < 8; bit++) {
      crc = ((crc >>> 1) ^ (0xedb88320 & -(crc & 1))) >>> 0;
    }
  }
  return crc >>> 0;
}

export function crc32(data) {
  return (crc32Update(CRC32_INIT, data) ^ 0xffffffff) >>> 0;
}
