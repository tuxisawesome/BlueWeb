import { test, assert, equal, deepEqual } from './harness.js';
import { createLock, BusyError } from '../js/lock.js';

/* A promise plus the handles to settle it, so a test can hold an operation
 * open and act while it is still running. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a lock nobody holds runs the work and reports the result', async () => {
  const lock = createLock();
  equal(lock.isBusy(), false);
  equal(await lock.run('Installing', async () => 'done'), 'done');
  equal(lock.isBusy(), false);
  equal(lock.label(), null);
});

test('the label says what is holding it', async () => {
  const lock = createLock();
  const held = deferred();

  const running = lock.run('Installing KhiCAS', () => held.promise);
  equal(lock.isBusy(), true);
  equal(lock.label(), 'Installing KhiCAS');

  held.resolve();
  await running;
  equal(lock.label(), null);
});

/*
 * The whole point. A second operation is refused, not queued -- a queued click
 * would act minutes later against a calculator whose state had moved on, which
 * is the "it happened in the background" behaviour this exists to prevent.
 */
test('a second operation is refused, not queued', async () => {
  const lock = createLock();
  const held = deferred();
  const ran = [];

  const first = lock.run('Installing', async () => { ran.push('first'); await held.promise; });

  let refused = null;
  try {
    await lock.run('Removing', async () => { ran.push('second'); });
  } catch (error) {
    refused = error;
  }

  assert(refused instanceof BusyError, 'refused with a BusyError');
  equal(refused.label, 'Installing', 'and names what is holding it');
  assert(refused.message.includes('Installing'), refused.message);
  deepEqual(ran, ['first'], 'the second body never ran');

  held.resolve();
  await first;
});

test('the lock is released once the first finishes, and can be taken again', async () => {
  const lock = createLock();
  const held = deferred();
  const first = lock.run('Installing', () => held.promise);

  held.resolve();
  await first;

  equal(await lock.run('Removing', async () => 'ok'), 'ok');
});

/*
 * A failed install must not wedge the page. This is the case that turns one bad
 * transfer into a calculator nothing can touch until the tab is reloaded.
 */
test('a throwing operation still releases the lock', async () => {
  const lock = createLock();

  let thrown = null;
  try {
    await lock.run('Installing', async () => { throw new Error('cable out'); });
  } catch (error) {
    thrown = error;
  }

  equal(thrown.message, 'cable out', 'the error reaches the caller unchanged');
  equal(lock.isBusy(), false);
  equal(await lock.run('Removing', async () => 'ok'), 'ok');
});

/*
 * onChange is what redraws the panels with their buttons disabled, so it has to
 * fire on both edges -- and the taking edge must fire before the work starts,
 * or the buttons stay live for the length of the operation.
 */
test('onChange fires when the lock is taken and when it is released', async () => {
  const seen = [];
  const lock = createLock({ onChange: () => seen.push(lock.label()) });
  const held = deferred();

  const running = lock.run('Installing', async () => {
    deepEqual(seen, ['Installing'], 'the panels were told before the work began');
    await held.promise;
  });

  held.resolve();
  await running;
  deepEqual(seen, ['Installing', null]);
});

test('a refused operation does not disturb the lock or fire onChange', async () => {
  let changes = 0;
  const lock = createLock({ onChange: () => { changes++; } });
  const held = deferred();
  const first = lock.run('Installing', () => held.promise);

  equal(changes, 1);
  try { await lock.run('Removing', async () => {}); } catch { /* expected */ }

  equal(changes, 1, 'a refusal is not a state change');
  equal(lock.label(), 'Installing', 'and the holder is untouched');

  held.resolve();
  await first;
});
