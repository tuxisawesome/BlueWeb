import { test, deepEqual, throws, equal } from './harness.js';
import {
  installActions, updateActions, uninstallActions,
  messagesFor, effectsOf, validateActions,
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
  const list = uninstallActions(cesium, null);
  equal(list.length, 2);
  deepEqual(messagesFor(list, 'post'),
    [{ text: 'Delete the app by hand.', level: 'action' }]);
});

test('messages are separated from work by phase', () => {
  const list = [
    { do: 'message', when: 'pre', text: 'This will take a minute.' },
    { do: 'upload', file: 'A.8xp' },
    { do: 'message', text: 'Run prgmCESIUM.' },
  ];
  equal(messagesFor(list, 'pre').length, 1);
  equal(messagesFor(list, 'post').length, 1, 'when defaults to post');
  equal(effectsOf(list).length, 1);
});

test('a package with no install list is refused', () => {
  throws(() => installActions({ id: 'x' }), 'actions.install');
  throws(() => installActions({ id: 'x', actions: { install: [] } }), 'actions.install');
});

test('bad actions are named, not silently skipped', () => {
  throws(() => validateActions([{ do: 'frobnicate' }], 'x'), 'not one of');
  throws(() => validateActions([{ do: 'upload' }], 'x'), 'needs a "file"');
  throws(() => validateActions([{ do: 'remove', name: 'lower' }], 'x'), 'will accept');
  throws(() => validateActions([{ do: 'message' }], 'x'), 'needs some "text"');
  throws(() => validateActions([{ do: 'message', text: 'x', when: 'later' }], 'x'),
    '"pre" or "post"');
});

test('a file path cannot escape its package directory', () => {
  throws(() => validateActions([{ do: 'upload', file: '../../secret' }], 'x'),
    'not a valid file name');
  throws(() => validateActions([{ do: 'upload', file: '/etc/passwd' }], 'x'),
    'not a valid file name');
});
