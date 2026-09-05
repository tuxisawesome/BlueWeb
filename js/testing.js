/*
 * What this page will do for somebody testing it, and not for everybody else.
 *
 * There is one thing so far: showing packages the catalogue has hidden. A
 * hidden package is still a package -- one already on a calculator keeps its
 * name in the Device panel and its version in Updates, and anything depending
 * on it still resolves. What it loses is the shop window, and that is the whole
 * difference between hiding a package and taking it out of apps/, which orphans
 * every calculator that already has it.
 *
 * Being able to install one anyway is what makes some things testable at all.
 * KhiCAS is 44 files and nearly three megabytes, which is the only package here
 * big enough to fill an archive and force the calculator to garbage collect --
 * and the collect path is the one place where a mistake is expensive, because a
 * collect moves every variable and anything holding a pointer into one is then
 * holding a pointer into something else.
 *
 * ## Why it is hidden behind a gesture rather than a checkbox
 *
 * A checkbox in Settings is a thing people find and turn on to see what
 * happens, and what happens here is that the Store starts offering packages
 * that were hidden for a reason. Twenty deliberate taps is not something anyone
 * does by accident, and it is the same gesture every Android phone uses for the
 * same purpose, so it is guessable by exactly the people it is for.
 *
 * Once it is on it stops being hidden: Settings grows a section saying so, with
 * a way to turn it off. An easter egg with no visible off switch is a trap.
 */

const KEY = 'blueweb.showHidden';

/** Taps on the catalogue line at the foot of the Store. */
export const UNLOCK_TAPS = 20;

/** How many are left before the page starts counting down out loud. */
export const COUNTDOWN_FROM = 5;

/**
 * Is the page showing hidden packages?
 *
 * Storage can throw outright -- a private window, or a browser set to block
 * site data -- so this never assumes it is there. A page that cannot remember
 * the answer just starts locked again, which is the right way round.
 */
export function showHidden() {
  try {
    return window.localStorage.getItem(KEY) === 'yes';
  } catch {
    return false;
  }
}

/** Returns false if the choice could not be remembered. */
export function setShowHidden(on) {
  try {
    if (on) window.localStorage.setItem(KEY, 'yes');
    else window.localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
