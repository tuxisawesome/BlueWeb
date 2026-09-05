/*
 * Developer options: what this page will do for somebody working on it, and not
 * for everybody else.
 *
 * Two things, and they belong together because they are both ways of reaching
 * something that is deliberately not on offer.
 *
 * **Build channels.** Which build of BlueObject the Store installs. Getting a
 * new one onto a calculator before it is published is the whole point of the
 * development channel -- and a build that does not start is not a broken app,
 * it is a calculator this page can no longer reach.
 *
 * **Hidden packages.** A hidden package is still a package: one already on a
 * calculator keeps its name in the Device panel and its version in Updates, and
 * anything depending on it still resolves. What it loses is the shop window,
 * and that is the whole difference between hiding a package and taking it out
 * of apps/, which orphans every calculator that already has it. Being able to
 * install one anyway is what makes some things testable at all -- KhiCAS, at 44
 * files and nearly three megabytes, is the only package here big enough to fill
 * an archive and make the calculator garbage collect.
 *
 * ## Why a gesture rather than a checkbox
 *
 * Both of those are worse than useless in the hands of somebody who wandered
 * into them. A checkbox in Settings is a thing people turn on to see what
 * happens, and what happens here is a store offering packages that were hidden
 * for a reason and firmware nobody has vouched for. Twenty deliberate taps on a
 * footnote is not something anyone does by accident, and it is the gesture every
 * Android phone uses for the same purpose, so it is guessable by exactly the
 * people it is for.
 *
 * Once it is on it stops being hidden: Settings grows a section saying so, with
 * a way to turn it off. An easter egg with no visible off switch is a trap.
 */

const KEY = 'blueweb.developer';

/** Taps on the catalogue line at the foot of the Store. */
export const UNLOCK_TAPS = 20;

/** How many are left before the page starts counting down out loud. */
export const COUNTDOWN_FROM = 5;

/**
 * Are developer options on?
 *
 * Storage can throw outright -- a private window, or a browser set to block
 * site data -- so this never assumes it is there. A page that cannot remember
 * the answer just starts locked again, which is the right way round.
 */
export function developerMode() {
  try {
    return window.localStorage.getItem(KEY) === 'yes';
  } catch {
    return false;
  }
}

/** Returns false if the choice could not be remembered. */
export function setDeveloperMode(on) {
  try {
    if (on) window.localStorage.setItem(KEY, 'yes');
    else window.localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
