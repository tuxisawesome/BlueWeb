import { test, deepEqual, equal, throws, assert } from './harness.js';
import {
  resolveInstall, resolveInstallAll, dependentsOf, planRemoval, orphansAfter,
  findUpdates, PROTECTED,
} from '../js/deps.js';

function catalog(apps) {
  return { apps, byId: new Map(apps.map((a) => [a.id, a])) };
}

const store = catalog([
  { id: 'clibs', name: 'C Libraries', version: '11.0.0', kind: 'app', deps: [] },
  { id: 'fontlib', name: 'FontLib', version: '2.0.0', kind: 'app', deps: ['clibs'] },
  { id: 'snake', name: 'Snake', version: '1.2.0', kind: 'app', deps: ['clibs'] },
  { id: 'oiram', name: 'Oiram', version: '1.4.1', kind: 'app', deps: ['clibs', 'fontlib'] },
  { id: 'cesium', name: 'Cesium', version: '3.7.0', kind: 'system', deps: [] },
]);

const pkg = (id, version, deps, extra = {}) =>
  ({ id, version, deps, explicit: true, kind: 0, files: [], ...extra });

test('dependencies are installed before the thing that needs them', () => {
  const plan = resolveInstall(store, [], 'snake');
  deepEqual(plan.order.map((e) => e.id), ['clibs', 'snake']);
});

test('a deeper graph still comes out in a workable order', () => {
  const plan = resolveInstall(store, [], 'oiram');
  const order = plan.order.map((e) => e.id);
  deepEqual(order, ['clibs', 'fontlib', 'oiram']);
  /*
   * If the session dies part-way, what is left must be inert: complete
   * dependencies and no app referencing them. The other order leaves an app
   * that launches and fails.
   */
  assert(order.indexOf('clibs') < order.indexOf('fontlib'));
  assert(order.indexOf('fontlib') < order.indexOf('oiram'));
});

test('what is already installed is left alone', () => {
  const plan = resolveInstall(store, [pkg('clibs', '11.0.0', [])], 'snake');
  deepEqual(plan.order.map((e) => e.id), ['snake']);
  deepEqual(plan.satisfied.map((s) => s.entry.id), ['clibs']);
});

test('the reason each package is in the plan is recorded', () => {
  const plan = resolveInstall(store, [], 'snake');
  deepEqual(plan.reasons.get('snake'), { requested: true });
  deepEqual(plan.reasons.get('clibs'), { requiredBy: 'snake' });
});

test('a cycle is refused rather than hung on', () => {
  const looped = catalog([
    { id: 'a', name: 'A', version: '1.0.0', deps: ['b'] },
    { id: 'b', name: 'B', version: '1.0.0', deps: ['a'] },
  ]);
  throws(() => resolveInstall(looped, [], 'a'), 'depends on itself');
});

test('a missing dependency is named', () => {
  const broken = catalog([
    { id: 'a', name: 'A', version: '1.0.0', deps: ['ghost'] },
  ]);
  throws(() => resolveInstall(broken, [], 'a'), 'not in the catalogue');
});

test('removal names what would break, and does not cascade on its own', () => {
  const installed = [
    pkg('clibs', '11.0.0', [], { explicit: false }),
    pkg('snake', '1.2.0', ['clibs']),
    pkg('oiram', '1.4.1', ['clibs']),
  ];
  const plan = planRemoval(installed, 'clibs');
  deepEqual(plan.order, [], 'nothing is removed without being asked');
  deepEqual(plan.blockedBy.map((p) => p.id).sort(), ['oiram', 'snake']);
});

test('cascading removes dependents first', () => {
  const installed = [
    pkg('clibs', '11.0.0', [], { explicit: false }),
    pkg('fontlib', '2.0.0', ['clibs'], { explicit: false }),
    pkg('oiram', '1.4.1', ['clibs', 'fontlib']),
  ];
  const order = planRemoval(installed, 'clibs', { cascade: true })
    .order.map((p) => p.id);
  /*
   * The calculator must never hold an app whose dependency has already gone,
   * so the app goes first and the library it needed goes last.
   */
  assert(order.indexOf('oiram') < order.indexOf('fontlib'), 'oiram before fontlib');
  assert(order.indexOf('fontlib') < order.indexOf('clibs'), 'fontlib before clibs');
});

test('removing something nothing needs is unblocked', () => {
  const installed = [pkg('clibs', '11.0.0', []), pkg('snake', '1.2.0', ['clibs'])];
  const plan = planRemoval(installed, 'snake');
  deepEqual(plan.blockedBy, []);
  deepEqual(plan.order.map((p) => p.id), ['snake']);
});

test('dependents are found from the index, not the catalogue', () => {
  /*
   * snake was installed when it still needed fontlib. The catalogue says it
   * only needs clibs now, and following the catalogue would wrongly report
   * fontlib as safe to remove.
   */
  const installed = [pkg('fontlib', '2.0.0', []), pkg('snake', '1.1.0', ['fontlib'])];
  deepEqual(dependentsOf(installed, 'fontlib').map((p) => p.id), ['snake']);
});

test('only pulled-in dependencies are offered as orphans', () => {
  const installed = [
    pkg('clibs', '11.0.0', [], { explicit: false }),
    pkg('fontlib', '2.0.0', [], { explicit: true }),
    pkg('snake', '1.2.0', ['clibs']),
  ];
  const orphans = orphansAfter(installed, ['snake']).map((p) => p.id);
  deepEqual(orphans, ['clibs'], 'fontlib was asked for by name, so it stays');
});

test('a system package is never offered as an orphan', () => {
  const installed = [
    pkg('cesium', '3.7.0', [], { explicit: false, kind: 1 }),
    pkg('snake', '1.2.0', ['cesium']),
  ];
  deepEqual(orphansAfter(installed, ['snake']), []);
});

test('a dependency something else still needs is not an orphan', () => {
  const installed = [
    pkg('clibs', '11.0.0', [], { explicit: false }),
    pkg('snake', '1.2.0', ['clibs']),
    pkg('oiram', '1.4.1', ['clibs']),
  ];
  deepEqual(orphansAfter(installed, ['snake']), []);
});

test('updates are found, and downgrades are not offered', () => {
  const installed = [
    pkg('snake', '1.1.0', ['clibs']),
    pkg('clibs', '11.0.0', []),
    pkg('cesium', '4.0.0', [], { kind: 1 }),
  ];
  const updates = findUpdates(store, installed);
  deepEqual(updates.map((u) => u.entry.id), ['snake'],
    'clibs is current, and cesium is newer than the store has');
  equal(updates[0].from, '1.1.0');
  equal(updates[0].to, '1.2.0');
});


test('removing the libraries out from under BlueObject is refused outright', () => {
  /*
   * BlueObject is a C program and loads five of the shared libraries, so it
   * depends on clibs like anything else. Cascading would sweep it up -- and
   * removing it stops the only thing that can install anything, so there is no
   * route back from the page. Not a warning: no version of this is offered.
   */
  const installed = [
    pkg('clibs', '15.0.0', [], { explicit: false }),
    pkg('blueobject', '1.0.2', ['clibs'], { kind: 1 }),
    pkg('2048', '2.2.0', ['clibs']),
  ];

  const plan = planRemoval(installed, 'clibs');
  deepEqual(plan.order, [], 'nothing is removed');
  deepEqual(plan.protectedBy.map((p) => p.id), ['blueobject']);

  /* And cascading does not get round it either. */
  const forced = planRemoval(installed, 'clibs', { cascade: true });
  deepEqual(forced.order, [], 'even asked to cascade, it removes nothing');
  deepEqual(forced.protectedBy.map((p) => p.id), ['blueobject']);
});

test('an ordinary dependency is still only a warning', () => {
  /* The protection is specific, not a general refusal to cascade. */
  const installed = [
    pkg('clibs', '15.0.0', [], { explicit: false }),
    pkg('2048', '2.2.0', ['clibs']),
  ];
  const plan = planRemoval(installed, 'clibs');
  deepEqual(plan.protectedBy, []);
  deepEqual(plan.blockedBy.map((p) => p.id), ['2048']);
  deepEqual(planRemoval(installed, 'clibs', { cascade: true })
    .order.map((p) => p.id), ['2048', 'clibs']);
});

test('BlueObject is the protected one', () => {
  assert(PROTECTED.has('blueobject'));
  assert(!PROTECTED.has('cesium'), 'Cesium is a system package but is removable');
});

/* ------------------------------------------------- several apps in one go */

test('a shared dependency is only installed once for a batch', () => {
  const plan = resolveInstallAll(store, [], ['snake', 'oiram']);
  deepEqual(plan.order.map((e) => e.id), ['clibs', 'snake', 'fontlib', 'oiram']);
});

test('a batch still installs every dependency before what needs it', () => {
  const plan = resolveInstallAll(store, [], ['oiram', 'snake', 'fontlib']);
  const order = plan.order.map((e) => e.id);
  for (const [dep, app] of [['clibs', 'snake'], ['clibs', 'oiram'],
                            ['clibs', 'fontlib'], ['fontlib', 'oiram']]) {
    assert(order.indexOf(dep) < order.indexOf(app),
      `${dep} must come before ${app}, got ${order.join(', ')}`);
  }
});

test('every app in a batch is recorded as asked for, not as a dependency', () => {
  /*
   * clibs is reached as Snake's dependency before the walk ever gets to it as a
   * root of its own. Whichever order the batch is resolved in, somebody who
   * ticked it is owed a dialog that says they asked for it -- and it must not
   * be installed as a pulled-in package that Device later offers as an orphan.
   */
  const plan = resolveInstallAll(store, [], ['snake', 'clibs']);
  deepEqual(plan.reasons.get('clibs'), { requested: true });
  deepEqual(plan.reasons.get('snake'), { requested: true });
  deepEqual([...plan.requested].sort(), ['clibs', 'snake']);
});

test('a dependency nobody ticked keeps the name of what pulled it in', () => {
  const plan = resolveInstallAll(store, [], ['oiram', 'snake']);
  deepEqual(plan.reasons.get('clibs'), { requiredBy: 'oiram' });
  deepEqual(plan.reasons.get('fontlib'), { requiredBy: 'oiram' });
});

test('a batch leaves alone what is already installed', () => {
  const installed = [pkg('clibs', '11.0.0', []), pkg('snake', '1.2.0', ['clibs'])];
  const plan = resolveInstallAll(store, installed, ['snake', 'oiram']);
  deepEqual(plan.order.map((e) => e.id), ['fontlib', 'oiram']);
  deepEqual(plan.satisfied.map((s) => s.entry.id).sort(), ['clibs', 'snake']);
});

test('a package one app can live with and another cannot is installed, not skipped', () => {
  /*
   * Snake accepts the installed C libraries; Oiram's manifest asks for a newer
   * range than what is on the calculator. Resolved one root at a time that is
   * "satisfied" once and "upgrade" once, and the honest answer is the upgrade:
   * it is in the order, so it must not also be reported as left alone.
   */
  const installed = [pkg('clibs', '10.0.0', [])];
  const manifests = new Map([
    ['snake', { id: 'snake', dependencies: ['clibs'] }],
    ['oiram', { id: 'oiram',
                dependencies: [{ id: 'clibs', version: '>=11.0.0' }, 'fontlib'] }],
  ]);
  const plan = resolveInstallAll(store, installed, ['snake', 'oiram'], manifests);
  assert(plan.order.some((e) => e.id === 'clibs'), 'the libraries are upgraded');
  deepEqual(plan.satisfied.map((s) => s.entry.id), [],
    'nothing being installed is also reported as left alone');
});

test('an empty batch plans nothing rather than throwing', () => {
  const plan = resolveInstallAll(store, [], []);
  deepEqual(plan.order, []);
});

test('a batch reports a broken dependency the same way one app does', () => {
  const broken = catalog([{ id: 'a', name: 'A', version: '1.0.0', deps: ['ghost'] }]);
  throws(() => resolveInstallAll(broken, [], ['a']), 'not in the catalogue');
});
