/*
 * What actually happened on the link, kept for as long as the session lasts.
 *
 * This exists because of a bug that presented as "the calculator did not answer
 * command 0x08" and nothing else. That sentence is true and useless: it does not
 * say the transfer had been going fine for ninety seconds, that the calculator
 * had gone quiet mid-commit, or that a defragment notice never arrived. All of
 * that was knowable at the time and none of it was written down.
 *
 * So: one line per thing that crosses the cable, timestamped from the start of
 * the session, held in a ring so a long install cannot grow without bound, and
 * readable after the install that failed has closed its dialog. The Copy button
 * is the point of the whole module -- a bug report with the log in it is a
 * different conversation from one without.
 *
 * Nothing here talks to the DOM. The panels subscribe.
 */

/*
 * Enough to hold a large package's whole install -- KhiCAS is forty-odd files,
 * a few hundred requests -- and small enough that keeping it costs nothing.
 * When it wraps, the oldest lines go, because the end of a failing session is
 * the part somebody needs.
 */
const CAPACITY = 500;

let entries = [];
let dropped = 0;
let startedAt = 0;
let subscribers = [];

/** Restart the clock and throw away the previous session's lines. */
export function startLog() {
  entries = [];
  dropped = 0;
  startedAt = Date.now();
  announce();
}

export function clearLog() {
  startLog();
}

/*
 * `dir` is which way it went, and it is what makes the log skimmable: '>' out
 * to the calculator, '<' back from it, '!' a fault, '·' a note from this page.
 */
export function logEvent(dir, text) {
  if (!startedAt) startedAt = Date.now();

  entries.push({ at: Date.now() - startedAt, dir, text });
  if (entries.length > CAPACITY) {
    entries.shift();
    dropped++;
  }
  announce();
}

export function logEntries() {
  return entries.slice();
}

export function droppedCount() {
  return dropped;
}

/** Returns an unsubscribe function, so a panel that is torn down can let go. */
export function subscribeLog(fn) {
  subscribers.push(fn);
  return () => {
    subscribers = subscribers.filter((each) => each !== fn);
  };
}

function announce() {
  for (const fn of subscribers) fn();
}

/** `m:ss.t` from the start of the session. Relative, because absolute clock
 *  times say nothing about how long a step took. */
export function stamp(at) {
  const tenths = Math.floor(at / 100) % 10;
  const seconds = Math.floor(at / 1000) % 60;
  const minutes = Math.floor(at / 60000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

/** The whole log as plain text, for the clipboard. */
export function formatLog() {
  const head = dropped
    ? [`… ${dropped} earlier ${dropped === 1 ? 'line' : 'lines'} dropped`]
    : [];
  return head
    .concat(entries.map((e) => `${stamp(e.at).padStart(8)}  ${e.dir} ${e.text}`))
    .join('\n');
}

/*
 * Sizes and rates in units a person reads. Bytes below a kilobyte stay bytes --
 * "0.1 KB" is worse than "94 B" -- and one decimal place is as much precision
 * as a number this jittery deserves.
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRate(bytesPerSecond) {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return null;
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

/*
 * Rounded hard, and deliberately vague. This link runs at a few kilobytes a
 * second through flash writes that stall for seconds at a time, so a countdown
 * accurate to the second would be a lie told ten times a second.
 */
export function formatDuration(seconds) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 10) return 'a few seconds';
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5}s`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round((seconds % 60) / 10) * 10;
  if (rest === 0 || rest === 60) return `about ${minutes + (rest === 60 ? 1 : 0)}m`;
  return `about ${minutes}m ${rest}s`;
}
