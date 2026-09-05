import { test, equal, deepEqual, throws } from './harness.js';
import {
  resolveChannel, isChannel, channelName, getChannel, setChannel, DEFAULT_CHANNEL,
} from '../js/channel.js';
import { resolveBuild } from '../js/catalog.js';

/* An index entry as tools/build_catalog.py writes one for a package with
 * channels: the release channel's numbers at the top level, and every channel
 * spelled out beside them. */
const entry = {
  id: 'blueobject',
  dir: 'blueobject',
  name: 'BlueObject',
  version: '1.3.0',
  bytes: 26224,
  maxFile: 18811,
  deps: ['clibs'],
  files: 'blueobject/builds/1.3.0',
  channels: {
    release: {
      version: '1.3.0', bytes: 26224, maxFile: 18811, deps: ['clibs'],
      files: 'blueobject/builds/1.3.0',
    },
    development: {
      version: '2.0.0', bytes: 38491, maxFile: 30226, deps: [],
      files: 'blueobject/builds/2.0.0',
    },
  },
};

const plain = { id: 'snake', dir: 'snake', version: '1.2.0', deps: [] };

test('release is the default channel', () => {
  equal(DEFAULT_CHANNEL, 'release');
  equal(isChannel('release'), true);
  equal(isChannel('development'), true);
  equal(isChannel('nightly'), false);
});

test('a package with one build is returned untouched', () => {
  /* Which is every package but BlueObject, so this is the common path. */
  equal(resolveChannel(plain, 'development'), plain);
});

test('choosing a channel replaces the version, size and dependencies', () => {
  const dev = resolveChannel(entry, 'development');
  equal(dev.version, '2.0.0');
  equal(dev.maxFile, 30226);
  deepEqual(dev.deps, []);
  equal(dev.files, 'blueobject/builds/2.0.0');
  equal(dev.channel, 'development');
});

test('and the release channel gives back what the entry already said', () => {
  const release = resolveChannel(entry, 'release');
  equal(release.version, '1.3.0');
  deepEqual(release.deps, ['clibs']);
  equal(release.files, 'blueobject/builds/1.3.0');
});

test('a channel a package does not publish on falls back to release', () => {
  /*
   * Not an error and not a hidden package. Somebody testing a development
   * BlueObject still wants the rest of the store, and every other package has
   * only ever had one build.
   */
  const missing = resolveChannel({ ...entry, channels: { release: entry.channels.release } },
                                 'development');
  equal(missing.version, '1.3.0');
  equal(missing.channel, 'release', 'and says which channel it actually is');
});

test('a name that is not a channel is refused rather than stored', () => {
  /*
   * Before storage is touched, so a typo cannot leave the page on a channel
   * that does not exist and then fall back to release for ever without saying
   * anything about it.
   */
  throws(() => setChannel('nightly'), 'not a channel');
  equal(getChannel(), DEFAULT_CHANNEL);
});

test('a chosen channel is remembered, and release clears the memory', () => {
  const before = getChannel();
  try {
    setChannel('development');
    equal(getChannel(), 'development');
    setChannel('release');
    equal(getChannel(), 'release');
  } finally {
    setChannel(before);
  }
});

test('channels have display names', () => {
  equal(channelName('development'), 'Development');
  equal(channelName('release'), 'Release');
  equal(channelName('nightly'), 'nightly', 'and an unknown one is its own name');
});

/* ------------------------------------------------------- folding in a build */

const manifest = {
  id: 'blueobject',
  name: 'BlueObject',
  summary: 'The calculator companion this store installs through.',
  dependencies: [],
  actions: { install: [{ do: 'upload', file: 'BLUE.8xp' }] },
  channels: { release: '1.3.0', development: '2.0.0' },
  builds: {
    '2.0.0': { dependencies: [], notes: 'Needs no C libraries.' },
    '1.3.0': { dependencies: ['clibs'] },
  },
};

test('a build overrides what it names and inherits the rest', () => {
  const built = resolveBuild(manifest, '1.3.0');
  equal(built.version, '1.3.0');
  deepEqual(built.dependencies, ['clibs'], 'the field that differs per build');
  equal(built.name, 'BlueObject', 'and the ones that do not are inherited');
  deepEqual(built.actions.install[0].file, 'BLUE.8xp');
});

test('the resolved manifest carries no trace of the other builds', () => {
  /*
   * Everything downstream treats a manifest as describing one version. Leaving
   * `builds` on it would let a later reader pick a different one and disagree
   * with the catalogue index about what is being installed.
   */
  const built = resolveBuild(manifest, '2.0.0');
  equal(built.builds, undefined);
  equal(built.channels, undefined);
  equal(built.notes, 'Needs no C libraries.');
});

test('asking for a build that does not exist says what to run', () => {
  throws(() => resolveBuild(manifest, '9.9.9'), 'build_catalog.py');
});

test('a manifest with no builds is its own build', () => {
  const one = { id: 'snake', version: '1.2.0' };
  equal(resolveBuild(one, '1.2.0'), one);
});
