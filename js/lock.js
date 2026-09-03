/*
 * One thing at a time, and only when somebody pressed something.
 *
 * The link is strict lockstep -- one request in flight, the reply carries the
 * same sequence number -- and until now nothing enforced that above the wire.
 * Two flows could be in the air at once: a rescan fired and not waited for, an
 * install started while the connect that opened the port was still finishing
 * its own work. Their requests interleave, each reads bytes meant for the
 * other, and what comes out the far end is a half-written package and an index
 * that disagrees with the calculator.
 *
 * So every flow that touches the calculator runs through here. A second one
 * does not queue -- it is refused. Queueing would be the same bug wearing a
 * hat: the click would appear to do nothing and then act minutes later, on a
 * calculator whose state had moved on, which is exactly the "it happened in the
 * background" complaint this exists to answer.
 *
 * The label is not decoration. It is what the refusal says, and what the panels
 * show while the buttons are disabled, so "nothing is responding" is always
 * answered with which operation is holding the link.
 */

export class BusyError extends Error {
  constructor(label) {
    super(`${label} is still going. Wait for it to finish.`);
    this.name = 'BusyError';
    this.label = label;
  }
}

export function createLock({ onChange = null } = {}) {
  let held = null;

  return {
    /** What is running, or null. */
    label() {
      return held;
    },

    isBusy() {
      return held !== null;
    },

    /**
     * Run `fn` with the link held.
     *
     * Throws BusyError if something else has it. Callers that are UI handlers
     * should catch that and say so rather than letting it reach the console --
     * a refused click is a normal thing to happen, not a fault.
     */
    async run(label, fn) {
      if (held) throw new BusyError(held);

      held = label;
      onChange?.();
      try {
        return await fn();
      } finally {
        held = null;
        onChange?.();
      }
    },
  };
}
