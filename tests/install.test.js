import { test, equal, deepEqual, assert } from './harness.js';
import { Session, InstallError } from '../js/install.js';
import { parseIndex, buildIndex } from '../js/blueidx.js';
import { reset as resetCatalog } from '../js/catalog.js';

const fixtures = await (await fetch('tests/fixtures/fixtures.json')).json();

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/*
 * A calculator that records what it was asked to do, in order.
 *
 * The order is the point of most of these tests: whether the index claim was
 * written before the files it claims is what decides whether an interrupted
 * install can be recovered or just leaves rubbish behind.
 */
class FakeCalculator {
  constructor({ failOn = null } = {}) {
    this.hello = { maxVarBytes: 30000, freeArchive: 300000, chunkSize: 8192 };
    this.index = new Uint8Array(0);
    this.variables = new Map();
    this.log = [];
    this.failOn = failOn;
  }

  async getIndex() { return this.index; }

  async putIndex(bytes) {
    /* Parse it, as the calculator does -- an index it would refuse must not
     * pass here either. */
    const parsed = parseIndex(bytes);
    this.index = bytes;
    this.log.push(`index(${parsed.packages.map(
      (p) => `${p.id}${p.installing ? '*' : ''}`).join(',')})`);
  }

  async putVariable({ name, body }) {
    if (this.failOn === name) throw new Error(`pretend failure writing ${name}`);
    this.variables.set(name, body);
    this.log.push(`put(${name})`);
    return { bytes: body.length, crc: 0 };
  }

  async deleteVariable(name) {
    const had = this.variables.delete(name);
    this.log.push(`del(${name})`);
    return had;
  }

  async statVariable(name) {
    const body = this.variables.get(name);
    return { present: !!body, archived: true, bytes: body?.length || 0, crc: 0 };
  }
}

/* Serve the catalogue and payloads out of memory instead of over the network. */
function stubFetch(files) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = String(url).replace(/^.*\/(apps\/)/, '$1');
    if (!(key in files)) return { ok: false, status: 404 };
    const value = files[key];
    return {
      ok: true,
      status: 200,
      async json() { return value; },
      async arrayBuffer() { return value.buffer ? value.buffer : value; },
    };
  };
  resetCatalog();
  return () => { globalThis.fetch = real; resetCatalog(); };
}

const program = fromHex(fixtures.variables.program.bytes);
const appvar = fromHex(fixtures.variables.appvar.bytes);

const catalog = {
  byId: new Map([
    ['snake', { id: 'snake', dir: 'snake', name: 'Snake', kind: 'app',
                version: '1.2.0', deps: [] }],
  ]),
};

const snakeManifest = {
  id: 'snake', name: 'Snake', kind: 'app', version: '1.2.0',
  actions: {
    install: [
      { do: 'upload', file: 'SNAKE.8xp', archive: true },
      { do: 'upload', file: 'SNAKEDAT.8xv', archive: true },
      { do: 'message', when: 'post', text: 'Have fun.' },
    ],
  },
};

const files = {
  'apps/snake/manifest.json': snakeManifest,
  'apps/snake/SNAKE.8xp': program,
  'apps/snake/SNAKEDAT.8xv': appvar,
};

test('the index claim is written before the files it claims', async () => {
  const restore = stubFetch(files);
  try {
    const calc = new FakeCalculator();
    const session = new Session(calc, catalog);
    await session.load();
    await session.apply('snake');

    /*
     * The first index write marks the package mid-install and already lists its
     * files; the last clears the mark. Anything that dies in between leaves a
     * row saying exactly what was being attempted.
     */
    deepEqual(calc.log, [
      'index(snake*)',
      'put(SNAKE)',
      'put(SNAKEDAT)',
      'index(snake)',
    ]);
  } finally { restore(); }
});

test('an interrupted install leaves a row that says what it was doing', async () => {
  const restore = stubFetch(files);
  try {
    const calc = new FakeCalculator({ failOn: 'SNAKEDAT' });
    const session = new Session(calc, catalog);
    await session.load();

    let failed = false;
    try { await session.apply('snake'); } catch { failed = true; }
    assert(failed, 'the install should have failed');

    /* What a later connect would see. */
    const after = new Session(calc, catalog);
    await after.load();
    const stuck = after.interrupted();

    equal(stuck.length, 1, 'one package is mid-install');
    equal(stuck[0].id, 'snake');
    deepEqual(stuck[0].files.map((f) => f.name), ['SNAKE', 'SNAKEDAT'],
      'both files are named, including the one that never arrived');

    /* And it is recoverable, because the row names what to clean up. */
    const check = await after.verify('snake');
    equal(check.ok, false);
    deepEqual(check.missing, ['SNAKEDAT']);
  } finally { restore(); }
});

test('a file too large for the calculator is refused before anything is sent', async () => {
  const restore = stubFetch(files);
  try {
    const calc = new FakeCalculator();
    calc.hello.maxVarBytes = 100;
    const session = new Session(calc, catalog);
    await session.load();

    let message = '';
    try { await session.apply('snake'); } catch (error) { message = error.message; }
    assert(message.includes('only build'), `expected a size refusal, got "${message}"`);
    /*
     * Nothing at all, not even the claim. Finding this out after transferring
     * the first file would waste the transfer and leave the package half on.
     */
    deepEqual(calc.log, []);
  } finally { restore(); }
});

test('a package too large for the archive is refused', async () => {
  const restore = stubFetch(files);
  try {
    const calc = new FakeCalculator();
    calc.hello.freeArchive = 10;
    const session = new Session(calc, catalog);
    await session.load();
    let message = '';
    try { await session.apply('snake'); } catch (error) { message = error.message; }
    assert(message.includes('archive has'), `expected an archive refusal, got "${message}"`);
  } finally { restore(); }
});

test('removal deletes what the index records, not what the manifest lists', async () => {
  const restore = stubFetch(files);
  try {
    const calc = new FakeCalculator();
    calc.variables.set('SNAKE', new Uint8Array(1));
    calc.variables.set('SNAKEDAT', new Uint8Array(1));
    calc.variables.set('SNAKEOLD', new Uint8Array(1));

    /*
     * The calculator holds a third file from an older version that the current
     * manifest knows nothing about. Only the index does, and it is the index
     * that has to be believed.
     */
    calc.index = buildIndex([{
      id: 'snake', version: '1.1.0', name: 'Snake', kind: 0,
      explicit: true, installing: false, deps: [],
      files: [
        { name: 'SNAKE', type: 0x06, archived: true, bytes: 1 },
        { name: 'SNAKEDAT', type: 0x15, archived: true, bytes: 1 },
        { name: 'SNAKEOLD', type: 0x15, archived: true, bytes: 1 },
      ],
    }]);

    const session = new Session(calc, catalog);
    await session.load();
    await session.remove('snake');

    assert(!calc.variables.has('SNAKEOLD'),
      'the file only the calculator knew about was removed too');
    equal(calc.variables.size, 0);
    equal(session.packages.length, 0);
  } finally { restore(); }
});

test('a package the store has dropped can still be removed', async () => {
  /* No manifest is served, which is exactly when somebody wants it gone. */
  const restore = stubFetch({});
  try {
    const calc = new FakeCalculator();
    calc.variables.set('GHOST', new Uint8Array(1));
    calc.index = buildIndex([{
      id: 'ghost', version: '1.0.0', name: 'Ghost', kind: 0,
      explicit: true, installing: false, deps: [],
      files: [{ name: 'GHOST', type: 0x06, archived: true, bytes: 1 }],
    }]);

    const session = new Session(calc, { byId: new Map() });
    await session.load();
    await session.remove('ghost');
    equal(calc.variables.size, 0);
  } finally { restore(); }
});

test('installing again updates in place rather than adding a second row', async () => {
  const restore = stubFetch(files);
  try {
    const calc = new FakeCalculator();
    const session = new Session(calc, catalog);
    await session.load();
    await session.apply('snake');
    await session.apply('snake');
    equal(session.packages.length, 1);
    equal(session.packages[0].version, '1.2.0');
  } finally { restore(); }
});

test('a dependency stays marked as one when it is reinstalled', async () => {
  const restore = stubFetch(files);
  try {
    const calc = new FakeCalculator();
    const session = new Session(calc, catalog);
    await session.load();
    await session.apply('snake', { explicit: false });
    equal(session.packages[0].explicit, false, 'pulled in by the resolver');

    /* Asking for it by name afterwards promotes it, and it must not be demoted
     * again by a later dependency-driven reinstall. */
    await session.apply('snake', { explicit: true });
    equal(session.packages[0].explicit, true);
    await session.apply('snake', { explicit: false });
    equal(session.packages[0].explicit, true, 'still asked for by name');
  } finally { restore(); }
});

test('removing something that is not installed says so', async () => {
  const calc = new FakeCalculator();
  const session = new Session(calc, catalog);
  await session.load();
  let threw = null;
  try { await session.remove('nothing'); } catch (error) { threw = error; }
  assert(threw instanceof InstallError, 'an InstallError names the problem');
});
