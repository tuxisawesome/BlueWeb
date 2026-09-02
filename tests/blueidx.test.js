import { test, equal, deepEqual, assert, throws, bytesEqual, fromHex } from './harness.js';
import { parseIndex, buildIndex, ownersOf, KIND_SYSTEM } from '../js/blueidx.js';

const fixtures = await (await fetch('tests/fixtures/fixtures.json')).json();

test('parses an index built by tools/blueidx.py', () => {
  /*
   * The fixture came from a separate implementation in another language, so
   * this is two implementations agreeing rather than one agreeing with itself.
   */
  const index = parseIndex(fromHex(fixtures.index.bytes));
  equal(index.packages.length, fixtures.index.packages.length);

  fixtures.index.packages.forEach((want, i) => {
    const got = index.packages[i];
    equal(got.id, want.id, `package ${i} id`);
    equal(got.version, want.version, `${want.id} version`);
    equal(got.name, want.name, `${want.id} name`);
    equal(got.kind, want.kind, `${want.id} kind`);
    equal(got.explicit, want.explicit, `${want.id} explicit`);
    deepEqual(got.deps, want.deps, `${want.id} dependencies`);
    deepEqual(
      got.files.map((f) => [f.name, f.type, f.archived, f.bytes]),
      want.files.map((f) => [f.name, f.type, f.archived, f.bytes]),
      `${want.id} files`);
  });
});

test('builds the same bytes tools/blueidx.py builds', () => {
  /*
   * Byte-exact, not merely round-trippable. Two implementations that each
   * round-trip their own output can still disagree about the format.
   */
  const built = buildIndex(fixtures.index.packages.map((p) => ({
    id: p.id, version: p.version, name: p.name, kind: p.kind,
    explicit: p.explicit, installing: p.installing, deps: p.deps,
    files: p.files,
  })));
  bytesEqual(built, fromHex(fixtures.index.bytes), 'index bytes');
});

test('an empty index is a state, not an error', () => {
  const index = parseIndex(new Uint8Array(0));
  equal(index.packages.length, 0);
  equal(index.deviceBlock.length, 64);
});

test('round-trips through this implementation too', () => {
  const packages = [{
    id: 'oiram', version: '1.4.1', name: 'Oiram', kind: 0,
    explicit: true, installing: false, deps: ['clibs'],
    files: [{ name: 'OIRAM', type: 0x06, archived: true, bytes: 60000 }],
  }];
  deepEqual(parseIndex(buildIndex(packages)).packages, packages);
});

test('the device block is carried and can be read back', () => {
  const block = new Uint8Array(64).fill(0xab);
  const index = parseIndex(buildIndex([], block));
  bytesEqual(index.deviceBlock, block, 'device block survives a round trip');
});

test('every malformed index is refused', () => {
  /*
   * This index is what uninstalling reads to decide what to delete, so being
   * approximately right about it is not good enough. Each of these is a real
   * failure mode, and "file range past the table" is a licence to delete
   * whatever bytes happen to follow.
   */
  for (const [why, hex] of Object.entries(fixtures.malformed)) {
    throws(() => parseIndex(fromHex(hex)), undefined, `must refuse: ${why}`);
  }
});

test('finds which packages own a variable', () => {
  const index = parseIndex(fromHex(fixtures.index.bytes));
  deepEqual(ownersOf(index, 'CLIBS').map((p) => p.id), ['clibs']);
  deepEqual(ownersOf(index, 'NOSUCH').map((p) => p.id), []);
});

test('a system package is marked as one', () => {
  const index = parseIndex(fromHex(fixtures.index.bytes));
  const cesium = index.packages.find((p) => p.id === 'cesium');
  assert(cesium, 'cesium is in the fixture');
  equal(cesium.kind, KIND_SYSTEM);
});
