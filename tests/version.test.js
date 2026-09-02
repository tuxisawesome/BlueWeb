import { test, equal, assert, throws } from './harness.js';
import { compareVersions, satisfies, isUpgrade, isValidVersion } from '../js/version.js';

test('versions order numerically, not as text', () => {
  /* The one that matters: "10" sorts before "9" as a string. */
  equal(compareVersions('1.10.0', '1.9.0'), 1, '1.10.0 > 1.9.0');
  equal(compareVersions('2.0.0', '10.0.0'), -1, '2.0.0 < 10.0.0');
  equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('a pre-release sorts below its release', () => {
  equal(compareVersions('1.2.0-rc1', '1.2.0'), -1);
  equal(compareVersions('1.2.0', '1.2.0-rc1'), 1);
  equal(compareVersions('1.2.0-rc1', '1.2.0-rc2'), -1);
});

test('a downgrade is not an update', () => {
  /* Inequality alone would offer to install 1.0.0 over 1.1.0. */
  assert(!isUpgrade('1.1.0', '1.0.0'), 'older catalogue version is not an update');
  assert(!isUpgrade('1.1.0', '1.1.0'), 'the same version is not an update');
  assert(isUpgrade('1.0.0', '1.1.0'), 'newer catalogue version is an update');
});

test('ranges', () => {
  assert(satisfies('11.0.0', '>=11.0.0'));
  assert(satisfies('11.2.0', '>=11.0.0'));
  assert(!satisfies('10.9.0', '>=11.0.0'));
  assert(satisfies('1.2.3', '*'));
  assert(satisfies('1.2.3', null));
  assert(satisfies('1.2.3', '=1.2.3'));
  assert(!satisfies('1.2.4', '=1.2.3'));
});

test('caret pins the leftmost non-zero component', () => {
  assert(satisfies('1.5.0', '^1.2.0'));
  assert(!satisfies('2.0.0', '^1.2.0'));
  assert(satisfies('0.2.9', '^0.2.0'));
  assert(!satisfies('0.3.0', '^0.2.0'), '0.x releases are not compatible across x');
});

test('a range that cannot be understood is refused, not ignored', () => {
  /* Treating a typo as "anything" would silently disable a requirement. */
  throws(() => satisfies('1.0.0', '~>1.0.0'), 'cannot understand');
  throws(() => satisfies('1.0.0', '>=banana'), 'is not a version');
});

test('version shape', () => {
  assert(isValidVersion('1.0.0'));
  assert(isValidVersion('1.0.0-rc.1'));
  assert(!isValidVersion('1.0'));
  assert(!isValidVersion('v1.0.0'));
});
