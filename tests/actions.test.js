import { test, deepEqual, throws, equal } from './harness.js';
import {
  installActions, updateActions, uninstallActions,
  effectsOf, validateActions,
} from '../js/actions.js';

const snake = {
  id: 'snake',
  actions: {
    install: [
      { do: 'upload', file: 'SNAKE.8xp', archive: true },
      { do: 'upload', file: 'SNAKEDAT.8xv', archive: true },
    ],
  },
};

const installed = {
  id: 'snake',
  files: [
    { name: 'SNAKE', type: 0x06, archived: true, bytes: 12000 },
    { name: 'SNAKEDAT', type: 0x15, archived: false, bytes: 300 },
  ],
};

test('a package declares install and nothing else', () => {
  equal(installActions(snake).length, 2);
});

test('update falls back to install', () => {
  deepEqual(updateActions(snake), installActions(snake));
});

test('update can be overridden to keep saved data', () => {
  const oiram = {
    id: 'oiram',
    actions: {
      install: [
        { do: 'upload', file: 'OIRAM.8xp' },
        { do: 'upload', file: 'OIRAMLV.8xv' },
      ],
      update: [
        { do: 'upload', file: 'OIRAM.8xp' },
        { do: 'message', text: 'Your level packs were kept.' },
      ],
    },
  };
  deepEqual(effectsOf(updateActions(oiram)), [{ do: 'upload', file: 'OIRAM.8xp' }]);
});

test('uninstall comes from the calculator, not the manifest', () => {
  /*
   * The point of deriving from the index: this manifest only ever uploaded
   * SNAKE, but the calculator also holds SNAKEDAT from an older version. It has
   * to be removed too, and only the calculator knows about it.
   */
  const thinner = { id: 'snake', actions: { install: [{ do: 'upload', file: 'SNAKE.8xp' }] } };
  deepEqual(uninstallActions(thinner, installed), [
    { do: 'remove', name: 'SNAKE', type: 'protected program' },
    { do: 'remove', name: 'SNAKEDAT', type: 'appvar' },
  ]);
});

test('a manifest that only says something still removes the files', () => {
  /*
   * The bug this exists for: declaring an uninstall list used to *replace* the
   * removals rather than add to them, and every real manifest turned out to
   * want nothing more than a message. So the package vanished from the index
   * and its files stayed on the calculator -- files nothing could then account
   * for, which is worse than either outcome alone.
   */
  const chatty = {
    id: 'snake',
    actions: {
      install: [{ do: 'upload', file: 'SNAKE.8xp' }],
      uninstall: [{ do: 'message', when: 'post', text: 'Your save was kept.' }],
    },
  };

  const list = uninstallActions(chatty, installed);
  deepEqual(effectsOf(list), [
    { do: 'remove', name: 'SNAKE', type: 'protected program' },
    { do: 'remove', name: 'SNAKEDAT', type: 'appvar' },
  ], 'both files the calculator records are still removed');
  deepEqual(list[list.length - 1],
            { do: 'message', when: 'post', text: 'Your save was kept.' },
            'and the message is still there, after the removals it describes');
});

test('a manifest can remove extra things, but only extra', () => {
  const extra = {
    id: 'snake',
    actions: {
      install: [{ do: 'upload', file: 'SNAKE.8xp' }],
      uninstall: [
        /* Already owned: redundant, and must not be deleted twice. */
        { do: 'remove', name: 'SNAKE', type: 'protected program' },
        /* Not owned: something an older version left behind. */
        { do: 'remove', name: 'SNAKEOLD', type: 'appvar' },
      ],
    },
  };

  deepEqual(effectsOf(uninstallActions(extra, installed)), [
    { do: 'remove', name: 'SNAKE', type: 'protected program' },
    { do: 'remove', name: 'SNAKEDAT', type: 'appvar' },
    { do: 'remove', name: 'SNAKEOLD', type: 'appvar' },
  ]);
});

test('uninstall can be overridden, as Cesium needs', () => {
  const cesium = {
    id: 'cesium',
    actions: {
      install: [{ do: 'upload', file: 'CESIUM.8xp' }],
      uninstall: [
        { do: 'remove', name: 'CESIUM', type: 'program' },
        { do: 'message', when: 'post', level: 'action', text: 'Delete the app by hand.' },
      ],
    },
  };
  /* No index row, so the manifest's own remove is all there is. */
  const list = uninstallActions(cesium, { id: 'cesium', files: [] });
  deepEqual(effectsOf(list), [{ do: 'remove', name: 'CESIUM', type: 'program' }]);
  equal(list[1].text, 'Delete the app by hand.', 'the message comes after it');
});

test('an install list keeps its messages where they were written', () => {
  /*
   * The bug: messages used to be lifted out of the list and shown together at
   * the end, so KhiCAS's warning about erasing every flash application on the
   * calculator arrived once it had been erased.
   */
  const list = validateActions([
    { do: 'message', text: 'This erases your apps.' },
    { do: 'upload', file: 'A.8xp' },
    { do: 'message', text: 'Run prgmCESIUM.' },
  ], 'x');
  equal(list[0].do, 'message', 'the warning is still first');
  equal(list[2].text, 'Run prgmCESIUM.');
  equal(effectsOf(list).length, 1);
});

test('"stop" has to have something left to stop', () => {
  /* A Stop button on the last message would stop nothing, so it is refused
   * rather than drawn and ignored. */
  throws(() => validateActions([
    { do: 'upload', file: 'A.8xp' },
    { do: 'message', stop: true, text: 'Too late.' },
  ], 'x'), 'nothing runs after this message');

  /* Trailing messages do not count as work for this. */
  throws(() => validateActions([
    { do: 'upload', file: 'A.8xp' },
    { do: 'message', stop: true, text: 'Too late.' },
    { do: 'message', text: 'Also too late.' },
  ], 'x'), 'nothing runs after this message');

  validateActions([
    { do: 'message', stop: true, text: 'This erases your apps.' },
    { do: 'upload', file: 'A.8xp' },
  ], 'x');

  throws(() => validateActions(
    [{ do: 'message', stop: 'yes', text: 'x' }], 'x'), '"stop" is true or false');
});

test('an uninstall message can only stop before the removals', () => {
  /* The removals come from the index, so position cannot say which side a
   * message is on -- "when" does, and only "pre" has anything after it. */
  validateActions([{ do: 'message', when: 'pre', stop: true, text: 'x' }], 'x',
                  { ordered: false });
  throws(() => validateActions(
    [{ do: 'message', when: 'post', stop: true, text: 'x' }], 'x',
    { ordered: false }), 'nothing runs after this message');
});

test('an install message cannot ask for a phase it does not have', () => {
  /*
   * Accepting "when" here and ignoring it is the trap: KhiCAS declared
   * when: "pre" at the end of a 46-entry list and got it last, silently.
   */
  throws(() => validateActions(
    [{ do: 'message', when: 'pre', text: 'x' }], 'x'), 'takes no "when"');
  /* An uninstall list is placed around removals the index chooses, so there it
   * is the only way to say which side. */
  validateActions([{ do: 'message', when: 'pre', text: 'x' }], 'x',
                  { ordered: false });
});

test('an uninstall message goes on the side its "when" asks for', () => {
  const list = uninstallActions({
    id: 'snake',
    actions: {
      install: [{ do: 'upload', file: 'SNAKE.8xp' }],
      uninstall: [
        { do: 'message', when: 'post', text: 'Gone.' },
        { do: 'message', when: 'pre', text: 'This cannot be undone.' },
      ],
    },
  }, installed);

  equal(list[0].text, 'This cannot be undone.', 'the warning is before');
  equal(list[list.length - 1].text, 'Gone.', 'the account of it is after');
  equal(effectsOf(list).length, 2, 'with the removals in between');
});

test('a package with no install list is refused', () => {
  throws(() => installActions({ id: 'x' }), 'actions.install');
  throws(() => installActions({ id: 'x', actions: { install: [] } }), 'actions.install');
});

test('bad actions are named, not silently skipped', () => {
  throws(() => validateActions([{ do: 'frobnicate' }], 'x'), 'not one of');
  throws(() => validateActions([{ do: 'upload' }], 'x'), 'needs a "file"');
  throws(() => validateActions([{ do: 'remove', name: 'lower' }], 'x'), 'will accept');
  /* A remove with no type would look for an appvar and quietly find nothing
   * when the variable is a program. */
  throws(() => validateActions([{ do: 'remove', name: 'SNAKE' }], 'x'),
    'needs a "type"');
  throws(() => validateActions([{ do: 'message' }], 'x'), 'needs some "text"');
  throws(() => validateActions([{ do: 'message', text: 'x', when: 'later' }], 'x',
                               { ordered: false }),
    '"pre" or "post"');
});

test('a file path cannot escape its package directory', () => {
  throws(() => validateActions([{ do: 'upload', file: '../../secret' }], 'x'),
    'not a valid file name');
  throws(() => validateActions([{ do: 'upload', file: '/etc/passwd' }], 'x'),
    'not a valid file name');
});
