/*
 * TI-84 Plus CE variable files (.8xp programs, .8xv appvars).
 *
 * Apps are committed to this repository as the real files, exactly as they are
 * downloaded, so they stay usable with TI Connect CE and so packaging an app is
 * a matter of dropping files in a directory. What goes over the link is the
 * variable's body inside the wrapper, not the wrapper: the calculator creates
 * the variable itself.
 *
 * That makes this file the source of truth for a variable's name, type and
 * archive flag. A manifest may declare them, but only so the linter can catch a
 * package whose manifest and payload disagree -- the file wins.
 *
 * Layout: an 11-byte signature, a 42-byte comment, the data section length, the
 * section itself, and a 16-bit sum of the section.
 */

const SIGNATURE = [0x2a, 0x2a, 0x54, 0x49, 0x38, 0x33, 0x46, 0x2a, 0x1a, 0x0a, 0x00];

export const TYPE_PROGRAM = 0x05;
export const TYPE_PROTECTED_PROGRAM = 0x06;
export const TYPE_APPVAR = 0x15;

/* What a manifest may call each type, and what the wire calls it. */
export const TYPE_NAMES = {
  [TYPE_PROGRAM]: 'program',
  [TYPE_PROTECTED_PROGRAM]: 'protected program',
  [TYPE_APPVAR]: 'appvar',
};

export const TYPE_BY_NAME = {
  program: TYPE_PROGRAM,
  prgm: TYPE_PROGRAM,
  'protected program': TYPE_PROTECTED_PROGRAM,
  prot_prgm: TYPE_PROTECTED_PROGRAM,
  appvar: TYPE_APPVAR,
};

/*
 * A variable's length field is 16 bit, so this is a hard ceiling no calculator
 * can exceed. The *practical* ceiling is much lower and is reported by the
 * calculator as maxVarBytes -- a variable must exist whole in RAM before it can
 * be archived, and there is nowhere near 64 KB of that free.
 */
export const MAX_VAR_SIZE = 65512;

/**
 * Is this a name TI-OS will accept?
 *
 * A capital first, then up to seven more letters or digits of either case.
 * The mixed case is not a nicety: the C libraries are named that way on
 * purpose -- LibLoad is spelled exactly like that -- because lowercase keeps
 * them out of reach of the homescreen, where they could be renamed or deleted
 * by accident. Requiring all caps here would make the most depended-on package
 * in the store impossible to install.
 */
export function isValidName(name) {
  return /^[A-Z][A-Za-z0-9]{0,7}$/.test(name);
}

/**
 * Read one variable out of a .8xv or .8xp file.
 *
 * Returns `{ name, type, archived, body }`, where `body` is the contents with
 * the file wrapper and the length fields stripped -- exactly the bytes the
 * calculator has to end up holding.
 *
 * Deliberately strict. This is the one path where a malformed file becomes a
 * program the calculator will try to run, so anything that does not parse
 * cleanly is refused here rather than pushed and found out later.
 */
export function readVariable(bytes) {
  const data = new Uint8Array(bytes);
  if (data.length < 57) throw new Error('not a TI variable file: too short');
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (data[i] !== SIGNATURE[i]) throw new Error('not a TI variable file: bad signature');
  }

  const sectionLength = data[53] | (data[54] << 8);
  if (55 + sectionLength + 2 > data.length) {
    throw new Error('TI variable file is truncated');
  }

  let checksum = 0;
  for (let i = 55; i < 55 + sectionLength; i++) checksum = (checksum + data[i]) & 0xffff;
  const stored = data[55 + sectionLength] | (data[56 + sectionLength] << 8);
  if (checksum !== stored) throw new Error('TI variable file checksum does not match');

  const entry = data.subarray(55, 55 + sectionLength);
  const headerLength = entry[0] | (entry[1] << 8);
  if (headerLength !== 13) {
    throw new Error(`unsupported variable entry header (${headerLength} bytes)`);
  }

  const type = entry[4];
  let name = '';
  for (let i = 5; i < 13; i++) {
    if (entry[i] === 0 || entry[i] === 0x20) break;
    name += String.fromCharCode(entry[i]);
  }

  if (!isValidName(name)) {
    throw new Error(`"${name}" is not a name the calculator will accept`);
  }
  if (!(type in TYPE_NAMES)) {
    throw new Error(`unsupported variable type 0x${type.toString(16)}`);
  }

  /*
   * The variable data is preceded by its own 16-bit length, which is two bytes
   * shorter than the entry's own length field claims.
   */
  const varData = entry.subarray(2 + headerLength + 2);
  const bodyLength = varData[0] | (varData[1] << 8);
  if (bodyLength + 2 > varData.length) throw new Error('variable data is truncated');

  return {
    name,
    type,
    archived: (entry[14] & 0x80) !== 0,
    body: varData.slice(2, 2 + bodyLength),
  };
}
