import { test, deepEqual } from './harness.js';
import { listable, search } from '../js/catalog.js';

/* Enough of a catalogue for the two functions that read one. */
const catalog = {
  apps: [
    { id: 'snake', name: 'Snake', category: 'games', summary: 'A snake.' },
    { id: 'khicas', name: 'KhiCAS', category: 'tools', disabled: true,
      summary: 'A computer algebra system.' },
    { id: 'clibs', name: 'C Libraries', category: 'libs', summary: 'Shared code.' },
  ],
};

const names = (apps) => apps.map((a) => a.id);

test('a disabled package is not offered in the Store', () => {
  deepEqual(names(listable(catalog)), ['snake', 'clibs']);
});

test('nor is it found by searching for it', () => {
  /*
   * Hiding it from the list and leaving it in the search results would put it
   * one keystroke away, which is not hidden.
   */
  deepEqual(names(search(catalog, 'khicas')), []);
  deepEqual(names(search(catalog, 'algebra')), [], 'nor by its summary');
  deepEqual(names(search(catalog, 'KhiCAS')), [], 'nor by its display name');
});

test('an empty search is still the whole listable catalogue', () => {
  deepEqual(names(search(catalog, '')), ['snake', 'clibs']);
  deepEqual(names(search(catalog, '   ')), ['snake', 'clibs'], 'and whitespace');
});

test('everything else is unaffected', () => {
  deepEqual(names(search(catalog, 'snake')), ['snake']);
  deepEqual(names(search(catalog, 'lib')), ['clibs'], 'by id');
});

/* --------------------------------------------------- packages the Store hides */

test('a hidden package is shown when the Store is asked for it', () => {
  /*
   * The twenty-tap unlock in testing.js decides *whether* to ask; these two
   * only have to answer honestly either way, which is why the option is a
   * parameter rather than something they read for themselves.
   */
  deepEqual(names(listable(catalog, { hidden: true })),
            ['snake', 'khicas', 'clibs']);
});

test('and found by searching, once it is', () => {
  deepEqual(names(search(catalog, 'khicas', { hidden: true })), ['khicas']);
  deepEqual(names(search(catalog, 'algebra', { hidden: true })), ['khicas'],
            'by its summary too');
});

test('asking for them explicitly is the only way to get them', () => {
  /* The default has to stay the safe one: every existing caller passes no
   * options at all, and a hidden package appearing for everybody is the
   * failure this guards. */
  deepEqual(names(listable(catalog, {})), ['snake', 'clibs']);
  deepEqual(names(search(catalog, '', { hidden: false })), ['snake', 'clibs']);
});
