/*
 * One bar for the whole of an install, and an honest speed for it.
 *
 * The old bar measured one file at a time and reset to indeterminate between
 * them, so installing a package of forty appvars showed forty bars each of
 * which finished, and never once said how far through the *install* it was.
 * That is the number somebody watching actually wants.
 *
 * ## Weights, and why the non-transfers have any
 *
 * A step's weight is its share of the bar. Uploads are weighted by bytes,
 * because bytes are what take the time. But an install is not only uploads: the
 * index is written before and after, files get removed, and each commit ends in
 * a flash write that can stall for seconds. Give those zero weight and the bar
 * sits perfectly still through the slowest parts, which is exactly when a user
 * starts to wonder whether it has died. So they get a small fixed weight --
 * enough to keep the bar moving through them, not enough to distort a real
 * transfer.
 *
 * ## The speed is smoothed, and that is the point
 *
 * Chunks land in 8 KB bursts punctuated by multi-second archive writes. The
 * instantaneous rate between two samples is therefore either "very fast" or
 * "zero", and neither is true. An exponentially weighted average over the
 * recent past is the smallest thing that reads as a speed rather than as noise.
 *
 * Before there is enough signal the rate is null, not zero, so the caller can
 * leave the line out instead of printing `0.0 KB/s` at somebody.
 */

import { formatRate, formatDuration } from './log.js';

/*
 * What a step that moves no bytes is worth, in notional bytes. About a second
 * of transfer on this link, which is roughly what an archive write costs.
 */
export const FIXED_STEP_WEIGHT = 4096;

/** "AppIns07.8xv — 8 of 46 · 61%", or just the step's name if it moves no bytes. */
export function describeStep(state) {
  const where = `${state.label} — ${state.step} of ${state.steps}`;
  return state.itemFraction === null
    ? where
    : `${where} · ${Math.round(state.itemFraction * 100)}%`;
}

/** "11.2 KB/s · about 1m 40s left", with either half omitted if unknown. */
export function describeRate(state) {
  const speed = formatRate(state.bytesPerSecond);
  const left = formatDuration(state.secondsLeft);
  if (!speed) return '';
  return left ? `${speed} · ${left} left` : speed;
}

/**
 * `steps` is `[{ label, bytes }]` in the order they will happen. A step with no
 * `bytes` (or zero) is a fixed-weight step: an index write, a removal, a commit.
 */
export function createPlanProgress(steps) {
  const weights = steps.map((s) => (s.bytes > 0 ? s.bytes : FIXED_STEP_WEIGHT));
  const total = weights.reduce((sum, w) => sum + w, 0);

  /* Where each step starts, so a step's own progress can be placed inside it. */
  const offsets = [];
  let running = 0;
  for (const w of weights) {
    offsets.push(running);
    running += w;
  }

  let rate = null;          /* bytes per second, smoothed */
  let lastBytes = null;
  let lastAt = null;

  /*
   * How much of the past a sample is allowed to outweigh. Higher is steadier
   * and slower to react; this is about three seconds of memory, which rides
   * over a chunk boundary without hiding a transfer that has genuinely stalled.
   */
  const SMOOTHING = 0.75;

  /* Below this the two samples are too close together to divide by. */
  const MIN_SAMPLE_MS = 120;

  function observe(bytesDone, now) {
    if (lastBytes === null) {
      lastBytes = bytesDone;
      lastAt = now;
      return;
    }

    const elapsed = now - lastAt;
    if (elapsed < MIN_SAMPLE_MS) return;

    const moved = bytesDone - lastBytes;
    lastBytes = bytesDone;
    lastAt = now;

    /*
     * A step boundary resets the within-step counter, so `moved` can come out
     * negative. That is a bookkeeping artefact, not a measurement -- drop it
     * rather than letting it drag the average down.
     */
    if (moved < 0) return;

    const sample = (moved * 1000) / elapsed;
    rate = rate === null ? sample : rate * SMOOTHING + sample * (1 - SMOOTHING);
  }

  return {
    total,

    /*
     * `index` is which step is running and `within` how many of its bytes have
     * landed. Returns everything the dialog needs and nothing it has to compute.
     */
    advance(index, within = 0, now = Date.now()) {
      const at = Math.max(0, Math.min(index, steps.length - 1));
      const step = steps[at] || { label: '', bytes: 0 };
      const weight = weights[at] || 0;

      const inStep = step.bytes > 0
        ? Math.max(0, Math.min(within, step.bytes))
        : 0;
      const itemFraction = step.bytes > 0 ? inStep / step.bytes : null;

      const done = offsets[at] + (step.bytes > 0 ? inStep : 0);
      const fraction = total > 0 ? Math.max(0, Math.min(done / total, 1)) : 0;

      observe(done, now);

      /*
       * Time left is estimated from the weighted remainder, not from bytes, so
       * the fixed-weight steps are accounted for instead of arriving as a
       * surprise after the bar has reached the end.
       */
      const secondsLeft = rate && rate > 0 ? (total - done) / rate : null;

      return {
        fraction,
        label: step.label,
        step: at + 1,
        steps: steps.length,
        itemFraction,
        bytesPerSecond: rate,
        secondsLeft,
      };
    },

    /*
     * A defragment is not a stall, but it looks exactly like one to an average
     * over recent bytes. Forget what we thought the speed was rather than
     * letting minutes of silence be averaged in.
     */
    stalled() {
      rate = null;
      lastBytes = null;
      lastAt = null;
    },

    finish(now = Date.now()) {
      observe(total, now);
      return {
        fraction: 1,
        label: '',
        step: steps.length,
        steps: steps.length,
        itemFraction: 1,
        bytesPerSecond: rate,
        secondsLeft: 0,
      };
    },
  };
}

/**
 * Install a whole plan behind one bar.
 *
 * `items` is the resolver's order -- several packages, each of several steps --
 * and this lays them end to end so the bar spans the lot. Both the Store and
 * the Updates panel drive installs this way and neither should have to work out
 * the arithmetic; `session` and `bar` are injected rather than imported so this
 * stays testable without a DOM or a calculator.
 *
 * `explicitFor(item)` says whether the user asked for that package by name.
 * `onMessage` is handed each `message` action as the list reaches it; returning
 * false from it stops the plan where it stands.
 */
export async function runPlan({
  session, items, bar, explicitFor, onMessage = null,
}) {
  /*
   * Every step of every package, and where each package starts within them.
   * This costs a preflight of the whole plan up front -- which planSteps caches
   * for the apply that follows -- and buys a bar that never restarts.
   */
  const steps = [];
  const offsets = [];
  for (const item of items) {
    offsets.push(steps.length);
    for (const step of await session.planSteps(item.id)) {
      steps.push({ label: step.label, bytes: step.bytes, package: item.name });
    }
  }

  const plan = createPlanProgress(steps);

  const show = (state) => {
    bar.fraction(state.fraction);
    bar.detail(describeStep(state));
    bar.rate(describeRate(state));
  };

  show(plan.advance(0));

  for (let at = 0; at < items.length; at++) {
    const item = items[at];
    const base = offsets[at];

    bar.say(`${item.name} ${item.version}`);
    await session.apply(item.id, {
      explicit: explicitFor(item),
      onProgress: ({ step, sent }) => show(plan.advance(base + step, sent)),
      onMessage,
    });
  }

  show(plan.finish());
  return plan;
}
