/*
 * Which build of a package this page offers: the released one, or the next one.
 *
 * Most packages have exactly one build and none of this applies to them. The
 * one that needs it is BlueObject, because it is the package this page installs
 * *through* -- a bad build of it is not a bad app, it is a calculator that can
 * no longer be reached from here. So a new BlueObject wants trying on a real
 * calculator before everybody gets it, and that is what a development channel
 * is for.
 *
 * ## Why this is a preference and not a URL
 *
 * The choice has to survive a reload, because the whole point is to keep a
 * calculator on the development build across sessions -- an install today, the
 * Updates panel offering the next development build next week. A query string
 * would be lost the first time somebody opened the page from a bookmark, and
 * they would be quietly moved back to release without being told.
 *
 * It is per-browser and not per-calculator on purpose. It describes who is
 * doing the installing, not what is installed: the same person testing on three
 * calculators wants all three on the same channel, and somebody else opening
 * this page gets the release build whatever anyone else chose.
 *
 * ## Release is the default, and the fallback
 *
 * Anything that cannot be answered resolves to release: storage that throws, a
 * stored name that no longer exists, a package with no build on the chosen
 * channel. The failure mode of guessing wrong in the other direction is putting
 * an untested build of the app manager on somebody's calculator, which is the
 * one outcome none of this is allowed to produce.
 */

const KEY = 'blueweb.channel';

export const DEFAULT_CHANNEL = 'release';

export const CHANNELS = [
  {
    id: 'release',
    name: 'Release',
    summary: 'The published build. What everybody gets.',
  },
  {
    id: 'development',
    name: 'Development',
    summary: 'The next build, before it is published. Try it on a calculator '
      + 'you can reach with a cable if it goes wrong.',
  },
];

export function isChannel(id) {
  return CHANNELS.some((channel) => channel.id === id);
}

export function channelName(id) {
  return CHANNELS.find((channel) => channel.id === id)?.name || id;
}

/**
 * The chosen channel.
 *
 * Reading storage can throw outright -- a private window, or a browser set to
 * block site data -- so this never assumes it is there. A page that cannot
 * remember the choice still works; it just always starts on release.
 */
export function getChannel() {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored && isChannel(stored)) return stored;
  } catch {
    /* No storage. Release, as everywhere else here. */
  }
  return DEFAULT_CHANNEL;
}

/** Remember the choice. Returns false if it could not be remembered. */
export function setChannel(id) {
  if (!isChannel(id)) throw new Error(`"${id}" is not a channel`);
  try {
    if (id === DEFAULT_CHANNEL) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a package's build for a channel, from the catalogue index.
 *
 * A package with no `channels` block has one build and is returned untouched,
 * which is every package but one. A package that has them but nothing on the
 * chosen channel falls back to release -- an app is not hidden from somebody
 * because they are testing something else.
 */
export function resolveChannel(entry, channel) {
  if (!entry?.channels) return entry;

  const build = entry.channels[channel] || entry.channels[DEFAULT_CHANNEL];
  if (!build) return entry;

  return { ...entry, ...build, channel: entry.channels[channel] ? channel : DEFAULT_CHANNEL };
}
