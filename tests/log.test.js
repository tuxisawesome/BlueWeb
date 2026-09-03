import { test, assert, equal } from './harness.js';
import {
  startLog, logEvent, logEntries, droppedCount, subscribeLog, formatLog,
  stamp, formatBytes, formatRate, formatDuration,
} from '../js/log.js';

test('log records what crossed the cable, in order', () => {
  startLog();
  logEvent('>', 'VAR_END');
  logEvent('<', 'VAR_END ok');

  const entries = logEntries();
  equal(entries.length, 2);
  equal(entries[0].dir, '>');
  equal(entries[1].text, 'VAR_END ok');
  assert(entries[0].at >= 0, 'timestamps run from the start of the session');
});

test('starting a session throws away the last one', () => {
  startLog();
  logEvent('>', 'HELLO');
  startLog();
  equal(logEntries().length, 0);
  equal(droppedCount(), 0);
});

test('logEntries hands out a copy, not the log itself', () => {
  startLog();
  logEvent('>', 'HELLO');
  logEntries().push({ at: 0, dir: '!', text: 'not really' });
  equal(logEntries().length, 1);
});

/*
 * The ring is the point: a long install must not grow without bound, and when
 * it wraps it is the *end* that has to survive, because that is where whatever
 * went wrong happened.
 */
test('the log wraps, keeping the newest and counting the rest', () => {
  startLog();
  for (let i = 0; i < 600; i++) logEvent('>', `line ${i}`);

  const entries = logEntries();
  equal(entries.length, 500);
  equal(entries[entries.length - 1].text, 'line 599');
  equal(droppedCount(), 100);
  assert(formatLog().startsWith('… 100 earlier lines dropped'),
    'the copied text says what is missing');
});

test('subscribers hear about every line, and can stop', () => {
  startLog();
  let calls = 0;
  const stop = subscribeLog(() => { calls++; });

  logEvent('>', 'one');
  logEvent('>', 'two');
  equal(calls, 2);

  stop();
  logEvent('>', 'three');
  equal(calls, 2, 'nothing after unsubscribing');
});

test('formatLog is plain text with a timestamp and a direction', () => {
  startLog();
  logEvent('>', 'VAR_CHUNK');
  const text = formatLog();
  assert(text.includes('> VAR_CHUNK'), text);
  assert(/\d+:\d\d\.\d/.test(text), `expected a timestamp in: ${text}`);
});

test('stamps read as minutes and seconds from the start', () => {
  equal(stamp(0), '0:00.0');
  equal(stamp(31500), '0:31.5');
  equal(stamp(95400), '1:35.4');
});

/* Below a kilobyte, bytes stay bytes -- "0.1 KB" is worse than "94 B". */
test('sizes read in units a person would use', () => {
  equal(formatBytes(0), '0 B');
  equal(formatBytes(94), '94 B');
  equal(formatBytes(1024), '1.0 KB');
  equal(formatBytes(11469), '11.2 KB');
  equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});

/*
 * A null rate means "not enough signal yet" and has to stay distinguishable
 * from zero, so the dialog can leave the line out rather than print 0.0 KB/s
 * beside a bar that is visibly moving.
 */
test('an unknown rate is null, not a zero', () => {
  equal(formatRate(null), null);
  equal(formatRate(Infinity), null);
  equal(formatRate(11469), '11.2 KB/s');
});

test('durations are vague on purpose', () => {
  equal(formatDuration(null), null);
  equal(formatDuration(-1), null);
  equal(formatDuration(4), 'a few seconds');
  equal(formatDuration(32), 'about 30s');
  equal(formatDuration(100), 'about 1m 40s');
  equal(formatDuration(121), 'about 2m');
});
