/*
 * What is on the calculator: its facts, and what is installed.
 *
 * The facts all come from one HELLO. The calculator gathers them before USB
 * starts, because asking the operating system anything mid-transfer is what
 * froze the link in the project this one is descended from.
 */

import { planRemoval, orphansAfter, dependentsOf } from '../deps.js';
import { ask, progress, showMessages, notice, el } from '../ui.js';
import { describeType } from '../install.js';

let getSession = null;
let onChanged = null;

const KB = 1024;
const kb = (bytes) => `${(bytes / KB).toFixed(bytes < 10 * KB ? 1 : 0)} KB`;

function hardware(hello) {
  const model = hello.hardwareType === 0 ? 'TI-84 Plus CE' : 'TI-83 Premium CE';
  return `${model} (rev ${hello.hardwareVersion})`;
}

/* ------------------------------------------------------------- removing */

/**
 * Ask about a removal that would break something.
 *
 * Never a silent cascade, and never a bare "remove anyway" -- what would stop
 * working is named, and keeping the dependency while removing the things that
 * needed it is offered too, because that is very often what was actually meant.
 */
async function confirmRemoval(target, blockedBy) {
  if (!blockedBy.length) {
    return ask({
      title: `Remove ${target.name}?`,
      body: `${target.files.length} file${target.files.length === 1 ? '' : 's'} `
        + `will be deleted from the calculator.`,
      actions: [
        { id: null, label: 'Cancel' },
        { id: 'just-it', label: 'Remove', kind: 'danger' },
      ],
    });
  }

  const names = blockedBy.map((p) => p.name);
  const body = el('div');
  body.append(el('p', null,
    `${names.join(' and ')} need${names.length === 1 ? 's' : ''} ${target.name}. `
    + `Removing it will stop ${names.length === 1 ? 'it' : 'them'} working.`));

  return ask({
    title: `Remove ${target.name}?`,
    body,
    actions: [
      { id: null, label: 'Cancel' },
      { id: 'dependents', label: `Remove ${names.join(' and ')}, keep ${target.name}` },
      { id: 'all', label: `Remove all ${blockedBy.length + 1}`, kind: 'danger' },
    ],
  });
}

/** Offer the dependencies nothing needs any more. Never automatic. */
async function offerOrphans(session, removedIds) {
  const orphans = orphansAfter(session.packages, removedIds);
  if (!orphans.length) return [];

  const body = el('div');
  body.append(el('p', null,
    'These were installed only because something else needed them, and nothing '
    + 'needs them now.'));

  const boxes = new Map();
  const rows = el('ul', 'plain');
  for (const orphan of orphans) {
    const row = el('li');
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = true;
    boxes.set(orphan.id, box);
    label.append(box, el('span', null,
      ` ${orphan.name} ${orphan.version} — frees `
      + kb(orphan.files.reduce((sum, f) => sum + f.bytes, 0))));
    row.append(label);
    rows.append(row);
  }
  body.append(rows);

  const answer = await ask({
    title: 'Remove these too?',
    body,
    actions: [
      { id: 'keep', label: 'Keep them' },
      { id: 'remove', label: 'Remove selected', kind: 'primary' },
    ],
  });

  if (answer !== 'remove') return [];
  return orphans.filter((o) => boxes.get(o.id).checked).map((o) => o.id);
}

async function remove(id) {
  const session = getSession();
  const target = session.find(id);
  if (!target) return;

  const { blockedBy } = planRemoval(session.packages, id);
  const choice = await confirmRemoval(target, blockedBy);
  if (!choice) return;

  /*
   * Dependents first, so the calculator never holds an app whose dependency has
   * already gone. planRemoval works that order out; "keep it" is the same list
   * with the target itself taken off the end.
   */
  let order;
  if (choice === 'all') {
    order = planRemoval(session.packages, id, { cascade: true }).order;
  } else if (choice === 'dependents') {
    order = planRemoval(session.packages, id, { cascade: true })
      .order.filter((p) => p.id !== id);
  } else {
    order = [target];
  }

  const bar = progress('Removing');
  session.messages.length = 0;
  const removed = [];

  try {
    for (const item of order) {
      bar.say(item.name);
      bar.fraction(null);
      await session.remove(item.id);
      removed.push(item.id);
    }
    bar.close();
  } catch (error) {
    bar.close();
    notice(`Could not finish removing: ${error.message}`, 'bad');
    onChanged?.();
    return;
  }

  await showMessages(session.messages);

  const orphans = await offerOrphans(session, removed);
  if (orphans.length) {
    const second = progress('Removing');
    try {
      for (const orphanId of orphans) {
        second.say(session.find(orphanId)?.name || orphanId);
        second.fraction(null);
        await session.remove(orphanId);
      }
      second.close();
    } catch (error) {
      second.close();
      notice(`Could not finish: ${error.message}`, 'bad');
    }
  }

  notice('Removed.');
  onChanged?.();
}

/* -------------------------------------------------------------- rendering */

function installedList(session) {
  const wrap = el('div');
  wrap.append(el('h2', 'category', 'Installed'));

  if (!session.packages.length) {
    wrap.append(el('p', 'placeholder', 'Nothing installed through BlueWeb yet.'));
    return wrap;
  }

  const rows = el('ul', 'plain installed');
  for (const pkg of [...session.packages].sort((a, b) =>
    a.name.localeCompare(b.name))) {
    const row = el('li');

    const main = el('div');
    main.append(el('strong', null, pkg.name));
    main.append(el('span', 'dim', ` ${pkg.version}`));

    if (pkg.installing) {
      /*
       * Written before its files and never cleared, so this install was cut off
       * part-way. The row names what it would have owned, which is enough to
       * either finish it or clean it up.
       */
      main.append(el('span', 'tag bad-tag', 'incomplete'));
    }
    if (!pkg.explicit) main.append(el('span', 'tag', 'dependency'));
    if (pkg.kind === 1) main.append(el('span', 'tag', 'system'));

    const files = pkg.files
      .map((f) => `${f.name} (${describeType(f.type)}, ${kb(f.bytes)})`)
      .join(', ');
    main.append(el('div', 'dim small', files || 'no files recorded'));

    const needs = dependentsOf(session.packages, pkg.id);
    if (needs.length) {
      main.append(el('div', 'dim small',
        `needed by ${needs.map((n) => n.name).join(', ')}`));
    }

    row.append(main);

    const button = el('button', 'danger small-button', 'Remove');
    if (pkg.id === 'blueobject') {
      button.disabled = true;
      button.title = 'BlueObject is what does the removing';
    }
    button.addEventListener('click', () => remove(pkg.id));
    row.append(button);

    rows.append(row);
  }
  wrap.append(rows);
  return wrap;
}

export function render(hello, session) {
  const panel = document.getElementById('panel-device');

  if (!hello) {
    panel.replaceChildren(
      el('p', 'placeholder', 'Connect a calculator to see what is on it.'));
    return;
  }

  const wrap = el('div');

  const rows = [
    ['Model', hardware(hello)],
    ['Operating system', `${hello.os} (build ${hello.osBuild})`],
    ['BlueObject', hello.version || 'unknown'],
    ['Link protocol', String(hello.protocol)],
    ['Archive free', kb(hello.freeArchive)],
    ['RAM free', kb(hello.freeRam)],
    /*
     * The number that decides whether an app can be installed at all: a TI
     * variable must exist whole in RAM before it can be archived, so this is
     * the real ceiling on a single file, not the 64 KB format limit.
     */
    ['Largest installable file', kb(hello.maxVarBytes)],
    ['Updater', hello.helper ? 'installed' : 'not installed'],
    ['Calculator ID', hello.calcId],
  ];

  if (hello.armedItems.length) {
    rows.push(['Waiting for prgmBLUEUP',
      hello.armedItems.map((a) => `${a.name} ${a.version}`).join(', ')]);
  }

  const facts = el('dl');
  for (const [label, value] of rows) {
    facts.append(el('dt', null, label), el('dd', null, value));
  }
  wrap.append(facts);

  if (session) wrap.append(installedList(session));

  panel.replaceChildren(wrap);
}

export function init(hooks) {
  getSession = hooks.getSession;
  onChanged = hooks.onChanged;
}
