import { test, assert, equal, deepEqual } from './harness.js';
import {
  createPlanProgress, runPlan, describeStep, describeRate, FIXED_STEP_WEIGHT,
} from '../js/progress.js';

test('the bar spans every step, weighted by bytes', () => {
  const plan = createPlanProgress([
    { label: 'A', bytes: 1000 },
    { label: 'B', bytes: 3000 },
  ]);

  equal(plan.total, 4000);
  equal(plan.advance(0, 0).fraction, 0);
  equal(plan.advance(0, 500).fraction, 0.125);
  equal(plan.advance(1, 0).fraction, 0.25);
  equal(plan.advance(1, 3000).fraction, 1);
});

/*
 * The index writes and the commits move no bytes and take real time -- most of
 * it a flash write. Weighing them at nothing leaves the bar frozen through
 * exactly the parts that look most like a hang.
 */
test('steps that move no bytes still advance the bar', () => {
  const plan = createPlanProgress([
    { label: 'Recording the install', bytes: 0 },
    { label: 'A', bytes: 1000 },
    { label: 'Finishing', bytes: 0 },
  ]);

  equal(plan.total, FIXED_STEP_WEIGHT * 2 + 1000);
  equal(plan.advance(0, 0).fraction, 0, 'starts at nothing');

  const afterClaim = plan.advance(1, 0).fraction;
  assert(afterClaim > 0, 'writing the index moved the bar along');

  const atFinish = plan.advance(2, 0).fraction;
  assert(atFinish > afterClaim, 'the transfer between them moved it further');
  assert(atFinish < 1, 'and the last step is still to come');

  equal(plan.finish().fraction, 1);
});

test('a step reports where it is inside itself', () => {
  const plan = createPlanProgress([{ label: 'AppIns07.8xv', bytes: 8192 }]);
  const state = plan.advance(0, 4096);
  equal(state.label, 'AppIns07.8xv');
  equal(state.step, 1);
  equal(state.steps, 1);
  equal(state.itemFraction, 0.5);
});

test('a step that moves no bytes has no fraction of its own', () => {
  const plan = createPlanProgress([{ label: 'Finishing', bytes: 0 }]);
  equal(plan.advance(0, 0).itemFraction, null);
});

test('the bar is clamped at both ends', () => {
  const plan = createPlanProgress([{ label: 'A', bytes: 100 }]);
  equal(plan.advance(0, -50).fraction, 0);
  equal(plan.advance(0, 500).fraction, 1);
  equal(plan.advance(9, 0).step, 1, 'an index past the end stays on the last step');
});

/*
 * The rate has to stay null until there is something to measure. Zero beside a
 * bar that is visibly moving reads as a bug in the page.
 */
test('no rate is reported before there is enough signal', () => {
  const plan = createPlanProgress([{ label: 'A', bytes: 100000 }]);
  equal(plan.advance(0, 0, 1000).bytesPerSecond, null);
  equal(plan.advance(0, 100, 1010).bytesPerSecond, null,
    'samples closer than the minimum are ignored');
});

test('the rate is measured once samples are far enough apart', () => {
  const plan = createPlanProgress([{ label: 'A', bytes: 100000 }]);
  plan.advance(0, 0, 1000);
  const state = plan.advance(0, 10000, 2000);
  equal(state.bytesPerSecond, 10000);
  equal(state.secondsLeft, 9, '90000 bytes left at 10000 a second');
});

/*
 * The within-step counter restarts at every boundary, so progress is tracked
 * against the running total rather than against it. Get that wrong and the
 * difference between two samples comes out negative at each boundary, which is
 * a nonsense rate on a transfer that only ever moves forwards.
 */
test('a step boundary does not send the bar or the rate backwards', () => {
  const plan = createPlanProgress([
    { label: 'A', bytes: 10000 },
    { label: 'B', bytes: 10000 },
  ]);

  plan.advance(0, 0, 1000);
  const end = plan.advance(0, 10000, 2000);
  const start = plan.advance(1, 0, 2050);

  equal(start.fraction, end.fraction,
    'the same point, counted from the end of one step or the start of the next');
  assert(start.bytesPerSecond >= 0, `rate went negative: ${start.bytesPerSecond}`);
  assert(Number.isFinite(start.bytesPerSecond), 'rate stayed a number');
});

/*
 * A commit is a real pause -- the flash write at the end of a file -- so a
 * second of it genuinely is a second at no bytes, and the speed should say so
 * rather than keep reporting the transfer rate that preceded it.
 */
test('a pause between steps slows the reported rate', () => {
  const plan = createPlanProgress([
    { label: 'A', bytes: 10000 },
    { label: 'B', bytes: 10000 },
  ]);

  plan.advance(0, 0, 1000);
  const moving = plan.advance(0, 10000, 2000).bytesPerSecond;
  const paused = plan.advance(1, 0, 3000).bytesPerSecond;

  assert(paused < moving, `expected the pause to slow it: ${moving} then ${paused}`);
  assert(paused > 0, 'but not all the way to a stop after one sample');
});

/*
 * A defragment is minutes of silence that is not a stall. Averaging it in would
 * leave the speed reading as near zero for the rest of the install.
 */
test('a defragment forgets the rate rather than averaging in the wait', () => {
  const plan = createPlanProgress([{ label: 'A', bytes: 100000 }]);
  plan.advance(0, 0, 1000);
  assert(plan.advance(0, 10000, 2000).bytesPerSecond > 0);

  plan.stalled();
  equal(plan.advance(0, 10000, 400000).bytesPerSecond, null);
});

test('descriptions read as a person would say them', () => {
  equal(
    describeStep({ label: 'AppIns07.8xv', step: 3, steps: 44, itemFraction: 0.61 }),
    'AppIns07.8xv — 3 of 44 · 61%');
  equal(
    describeStep({ label: 'Finishing', step: 44, steps: 44, itemFraction: null }),
    'Finishing — 44 of 44');
  equal(
    describeRate({ bytesPerSecond: 11469, secondsLeft: 100 }),
    '11.2 KB/s · about 1m 40s left');
  equal(describeRate({ bytesPerSecond: null, secondsLeft: null }), '');
});

/* ------------------------------------------------------------------ runPlan */

function fakeBar() {
  const seen = { fractions: [], details: [], rates: [], said: [] };
  return {
    seen,
    say: (t) => seen.said.push(t),
    fraction: (v) => seen.fractions.push(v),
    detail: (t) => seen.details.push(t),
    rate: (t) => seen.rates.push(t),
  };
}

/* Stands in for Session: reports the same step indices apply() really does. */
function fakeSession(perPackage) {
  return {
    applied: [],
    async planSteps(id) {
      return perPackage[id];
    },
    async apply(id, { onProgress }) {
      this.applied.push(id);
      perPackage[id].forEach((step, at) => {
        onProgress({ step: at, sent: step.bytes, size: step.bytes });
      });
    },
  };
}

test('runPlan lays several packages end to end behind one bar', async () => {
  const session = fakeSession({
    clibs: [{ label: 'claim', bytes: 0 }, { label: 'LibLoad', bytes: 2000 }],
    khicas: [{ label: 'claim', bytes: 0 }, { label: 'KhiCAS', bytes: 6000 }],
  });
  const bar = fakeBar();

  await runPlan({
    session,
    items: [{ id: 'clibs', name: 'C libraries', version: '1' },
            { id: 'khicas', name: 'KhiCAS', version: '2' }],
    bar,
    explicitFor: (item) => item.id === 'khicas',
  });

  deepEqual(session.applied, ['clibs', 'khicas']);
  equal(bar.seen.fractions[bar.seen.fractions.length - 1], 1,
    'it ends full');

  /* The one property that matters: it never goes backwards between packages. */
  let last = -1;
  for (const value of bar.seen.fractions) {
    assert(value >= last, `the bar went backwards: ${last} then ${value}`);
    last = value;
  }
});

test('runPlan passes each package its own explicit flag', async () => {
  const session = fakeSession({ a: [{ label: 'x', bytes: 10 }] });
  const asked = [];
  session.apply = async (id, { explicit }) => { asked.push([id, explicit]); };

  await runPlan({
    session,
    items: [{ id: 'a', name: 'A', version: '1' }],
    bar: fakeBar(),
    explicitFor: (item) => item.id === 'a',
  });

  deepEqual(asked, [['a', true]]);
});
