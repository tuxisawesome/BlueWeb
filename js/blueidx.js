/*
 * BLUEIDX: the calculator's record of what is installed.
 *
 * One appvar, holding a package table, a file table and a string pool, plus a
 * 64-byte device block that belongs to the calculator alone.
 *
 * This index is what removal reads to decide what to delete, which makes
 * validation a safety property rather than a nicety: a package row whose file
 * range runs past the end of the file table would have BlueObject deleting
 * whatever happened to follow it in memory. Both ends parse defensively, and
 * the calculator refuses an index it cannot fully verify.
 *
 * The format is written three times -- here, in BlueObject's calc/src/index.c,
 * and in its tools/blueidx.py. They are cross-checked against each other,
 * because a format with one implementation has no way to be wrong out loud.
 *
 * Everything is little-endian.
 */

export const MAGIC = 'BLUIDX';
export const FORMAT_VERSION = 1;

export const HEADER_SIZE = 96;
export const PACKAGE_RECORD = 14;
export const FILE_RECORD = 12;

export const DEVICE_OFFSET = 32;
export const DEVICE_SIZE = 64;

export const KIND_APP = 0;
export const KIND_SYSTEM = 1;

/* Package flags. */
export const PKG_EXPLICIT = 0x01;   /* the user asked for this, not the resolver */
export const PKG_INSTALLING = 0x02; /* written before the files; cleared after */

/* File flags. */
export const FILE_ARCHIVED = 0x01;

const ASCII = {
  encode(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0x7f) throw new Error(`"${text}" is not ASCII`);
      out[i] = code;
    }
    return out;
  },
};

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /* Set once the tables have been measured; until then no string is readable. */
    this.poolAt = Infinity;
  }

  u8(at) { return this.bytes[at]; }
  u16(at) { return this.view.getUint16(at, true); }

  /*
   * A NUL-terminated string, which must start inside the pool and end before
   * the buffer does.
   *
   * Checked against the pool rather than the header, so that an offset pointing
   * into the package or file table is refused. The calculator's index.c checks
   * it that way, and a parser here that accepted what the calculator rejects
   * would let a bad index through to be discovered on hardware.
   */
  string(at, what) {
    if (at < this.poolAt || at >= this.bytes.length) {
      throw new Error(`${what}: string offset ${at} is outside the string pool`);
    }
    let end = at;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    if (end >= this.bytes.length) {
      throw new Error(`${what}: string at ${at} is not terminated`);
    }
    return String.fromCharCode(...this.bytes.subarray(at, end));
  }
}

function readName(bytes, at) {
  let name = '';
  for (let i = at; i < at + 8; i++) {
    if (bytes[i] === 0 || bytes[i] === 0x20) break;
    name += String.fromCharCode(bytes[i]);
  }
  return name;
}

/**
 * Parse an index, or throw saying why it cannot be trusted.
 *
 * An empty buffer is a calculator that has no index yet, which is an ordinary
 * state and not an error -- it parses as an empty index with a blank device
 * block.
 */
export function parseIndex(bytes) {
  const data = new Uint8Array(bytes);
  if (data.length === 0) {
    return { version: FORMAT_VERSION, flags: 0, packages: [],
             deviceBlock: new Uint8Array(DEVICE_SIZE) };
  }
  if (data.length < HEADER_SIZE) throw new Error('index is shorter than its header');

  const r = new Reader(data);
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC.charCodeAt(i)) throw new Error('not a BlueObject index');
  }

  const version = data[6];
  if (version !== FORMAT_VERSION) {
    throw new Error(`index format version ${version}, expected ${FORMAT_VERSION}`);
  }

  const packageCount = r.u16(8);
  const fileCount = r.u16(10);
  const poolSize = r.u16(12);
  const totalSize = r.u16(14);

  const packagesAt = HEADER_SIZE;
  const filesAt = packagesAt + packageCount * PACKAGE_RECORD;
  const poolAt = filesAt + fileCount * FILE_RECORD;
  const expected = poolAt + poolSize;
  r.poolAt = poolAt;

  /*
   * totalSize is redundant with the counts on purpose. It is the one field that
   * catches an index truncated in flash, where the counts still look plausible
   * because they were written before the damage.
   */
  if (totalSize !== expected) {
    throw new Error(`index says it is ${totalSize} bytes but its tables need ${expected}`);
  }
  if (data.length < expected) {
    throw new Error(`index is ${data.length} bytes but needs ${expected}`);
  }

  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const at = filesAt + i * FILE_RECORD;
    files.push({
      name: readName(data, at),
      type: data[at + 8],
      archived: (data[at + 9] & FILE_ARCHIVED) !== 0,
      bytes: r.u16(at + 10),
    });
  }

  const packages = [];
  for (let i = 0; i < packageCount; i++) {
    const at = packagesAt + i * PACKAGE_RECORD;
    const first = r.u16(at + 6);
    const count = r.u16(at + 8);

    /* The check that matters: this range is what removal will delete. */
    if (first + count > fileCount) {
      throw new Error(`package ${i} claims files ${first}..${first + count - 1} `
        + `but the index only has ${fileCount}`);
    }

    const flags = data[at + 11];
    const deps = r.string(r.u16(at + 12), `package ${i} dependencies`);
    packages.push({
      id: r.string(r.u16(at), `package ${i} id`),
      version: r.string(r.u16(at + 2), `package ${i} version`),
      name: r.string(r.u16(at + 4), `package ${i} name`),
      kind: data[at + 10],
      explicit: (flags & PKG_EXPLICIT) !== 0,
      installing: (flags & PKG_INSTALLING) !== 0,
      /*
       * What this package needed when it was installed -- not what the
       * catalogue says it needs now. Removing something has to know what
       * actually depends on it, and the catalogue may have moved on, changed
       * the dependency, or dropped the package entirely.
       */
      deps: deps ? deps.split(',') : [],
      files: files.slice(first, first + count),
    });
  }

  return {
    version,
    flags: data[7],
    packages,
    deviceBlock: data.slice(DEVICE_OFFSET, DEVICE_OFFSET + DEVICE_SIZE),
  };
}

/**
 * Build an index.
 *
 * `deviceBlock` is normally left out: the calculator splices its own live block
 * over whatever arrives, so the computer has nothing useful to put there and
 * writing zeros is what lets the page compare the index it holds against the
 * one it would build.
 */
export function buildIndex(packages, deviceBlock = null) {
  const pool = [];
  let poolSize = 0;
  const strings = new Map();

  const packagesAt = HEADER_SIZE;
  const filesAt = packagesAt + packages.length * PACKAGE_RECORD;
  let fileCount = 0;
  for (const pkg of packages) fileCount += pkg.files.length;
  const poolAt = filesAt + fileCount * FILE_RECORD;

  /* Identical strings are stored once. Package ids repeat constantly. */
  const intern = (text) => {
    if (strings.has(text)) return strings.get(text);
    const at = poolAt + poolSize;
    strings.set(text, at);
    const encoded = ASCII.encode(text);
    pool.push(encoded);
    poolSize += encoded.length + 1;
    return at;
  };

  const packageRows = [];
  const fileRows = [];
  for (const pkg of packages) {
    const idOffset = intern(pkg.id);
    const versionOffset = intern(pkg.version);
    const nameOffset = intern(pkg.name ?? pkg.id);
    const depsOffset = intern((pkg.deps ?? []).join(','));

    packageRows.push({
      idOffset, versionOffset, nameOffset, depsOffset,
      first: fileRows.length,
      count: pkg.files.length,
      kind: pkg.kind === KIND_SYSTEM || pkg.kind === 'system' ? KIND_SYSTEM : KIND_APP,
      flags: (pkg.explicit ? PKG_EXPLICIT : 0) | (pkg.installing ? PKG_INSTALLING : 0),
    });

    for (const file of pkg.files) fileRows.push(file);
  }

  const total = poolAt + poolSize;
  if (total > 0xffff) throw new Error('index is too large for the calculator');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  for (let i = 0; i < MAGIC.length; i++) out[i] = MAGIC.charCodeAt(i);
  out[6] = FORMAT_VERSION;
  out[7] = 0;
  view.setUint16(8, packages.length, true);
  view.setUint16(10, fileRows.length, true);
  view.setUint16(12, poolSize, true);
  view.setUint16(14, total, true);

  if (deviceBlock) out.set(deviceBlock.subarray(0, DEVICE_SIZE), DEVICE_OFFSET);

  packageRows.forEach((row, i) => {
    const at = packagesAt + i * PACKAGE_RECORD;
    view.setUint16(at, row.idOffset, true);
    view.setUint16(at + 2, row.versionOffset, true);
    view.setUint16(at + 4, row.nameOffset, true);
    view.setUint16(at + 6, row.first, true);
    view.setUint16(at + 8, row.count, true);
    out[at + 10] = row.kind;
    out[at + 11] = row.flags;
    view.setUint16(at + 12, row.depsOffset, true);
  });

  fileRows.forEach((file, i) => {
    const at = filesAt + i * FILE_RECORD;
    const name = ASCII.encode(file.name);
    if (name.length > 8) throw new Error(`"${file.name}" is too long for a TI name`);
    out.set(name, at);
    out[at + 8] = file.type;
    out[at + 9] = file.archived ? FILE_ARCHIVED : 0;
    view.setUint16(at + 10, file.bytes, true);
  });

  let at = poolAt;
  for (const encoded of pool) {
    out.set(encoded, at);
    at += encoded.length + 1;   /* the NUL is already zero */
  }

  return out;
}

/** The packages that own a given variable name, for orphan and conflict checks. */
export function ownersOf(index, name) {
  return index.packages.filter((p) => p.files.some((f) => f.name === name));
}
