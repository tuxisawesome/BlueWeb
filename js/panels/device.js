/*
 * What is on the calculator: its facts, and what is installed.
 *
 * The facts all come from one HELLO. The calculator gathers them before USB
 * starts, because asking the operating system anything mid-transfer is what
 * froze the link in the project this one is descended from.
 */

import { planRemoval, orphansAfter, dependentsOf } from '../deps.js';
import { ask, progress, showMessage, notice, advancedLog, el } from '../ui.js';
import {
  describeType, classifyVariables, deleteVariables, InstallCancelled,
} from '../install.js';

let getSession = null;
let onChanged = null;
let contents = null;   /* what LIST last reported, or null if unsupported */
let logBlock = null;   /* the Advanced disclosure, and its subscription */
let exclusive = null;  /* run an operation with the calculator held */
let isBusy = null;

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
async function confirmRemoval(target, blockedBy, protectedBy) {
  if (protectedBy.length) {
    /*
     * No option here is safe, so none is offered. Removing the libraries out
     * from under BlueObject stops BlueObject running, and BlueObject is what
     * installs things -- the way back is TI Connect and a cable, not this page.
     */
    const names = protectedBy.map((p) => p.name).join(' and ');
    await ask({
      title: `${target.name} cannot be removed`,
      body: `${names} needs it to run, and ${names} is what installs and `
        + `removes everything else. Taking it away would leave this page with `
        + `no way to put it back — you would need TI Connect and a cable.`,
      actions: [{ id: null, label: 'Close', kind: 'primary' }],
    });
    return null;
  }

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
  return exclusive('Removing', () => removeNow(id));
}

async function removeNow(id) {
  const session = getSession();
  const target = session.find(id);
  if (!target) return;

  const { blockedBy, protectedBy } = planRemoval(session.packages, id);
  const choice = await confirmRemoval(target, blockedBy, protectedBy);
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
  const removed = [];

  try {
    for (const item of order) {
      bar.say(item.name);
      bar.fraction(null);
      await session.remove(item.id, { onMessage: showMessage });
      removed.push(item.id);
    }
    bar.close();
  } catch (error) {
    bar.close();
    if (error instanceof InstallCancelled) {
      /*
       * A warning answered with "stop" -- so whatever had already been removed
       * is gone and the rest is untouched, which is what the count says.
       */
      notice(removed.length
        ? `Removal stopped after ${removed.length} of ${order.length}.`
        : 'Nothing was removed.', 'action');
    } else {
      notice(`Could not finish removing: ${error.message}`, 'bad');
    }
    await onChanged?.();
    return;
  }

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
  await onChanged?.();
}

/* ------------------------------------------------------------ stray files */

async function removeStray(variable) {
  return exclusive('Deleting a file', () => removeStrayNow(variable));
}

async function removeStrayNow(variable) {
  const session = getSession();
  const answer = await ask({
    title: `Delete ${variable.name}?`,
    body: `Nothing in the store put this here, so nothing else knows what it `
      + `is. It may be a saved game, or something sent across by hand. `
      + `Deleting it frees ${kb(variable.bytes)} and cannot be undone.`,
    actions: [
      { id: null, label: 'Keep it' },
      { id: 'go', label: 'Delete', kind: 'danger' },
    ],
  });
  if (answer !== 'go') return;

  try {
    await session.calculator.deleteVariable(variable.name, variable.type);
    notice(`${variable.name} deleted.`);
  } catch (error) {
    notice(`Could not delete ${variable.name}: ${error.message}`, 'bad');
  }
  await onChanged?.();
}

/**
 * Delete several at once.
 *
 * The dialog names every file rather than counting them. Ticking eleven boxes
 * and reading back "11 files" is not a confirmation of anything -- the whole
 * risk here is a box ticked by accident, and the only way to catch that is to
 * show what is actually about to go.
 */
async function removeStrays(variables) {
  if (!variables.length) return undefined;
  return exclusive('Deleting files', () => removeStraysNow(variables));
}

async function removeStraysNow(variables) {
  if (!variables.length) return;
  const session = getSession();
  const total = variables.reduce((sum, variable) => sum + variable.bytes, 0);

  const body = el('div');
  body.append(el('p', null,
    `These will be deleted from the calculator, freeing ${kb(total)}. Nothing `
    + `in the store put them there, so nothing can put them back.`));

  const names = el('ul', 'plain');
  for (const variable of variables) {
    names.append(el('li', 'dim small',
      `${variable.name} — ${describeType(variable.type)}, ${kb(variable.bytes)}`));
  }
  body.append(names);

  const answer = await ask({
    title: `Delete ${variables.length} files?`,
    body,
    actions: [
      { id: null, label: 'Keep them' },
      { id: 'go', label: `Delete ${variables.length}`, kind: 'danger' },
    ],
  });
  if (answer !== 'go') return;

  const bar = progress('Deleting');
  const { deleted, failed } = await deleteVariables(
    session.calculator, variables,
    ({ variable, done, total: count }) => {
      if (variable) bar.say(variable.name);
      bar.fraction(done / count);
    });
  bar.close();

  /*
   * One that would not go does not hide the ten that did. Naming the survivors
   * is the difference between trying again and trying again on everything.
   */
  if (failed.length) {
    notice(`Deleted ${deleted.length}. ${failed.map((f) => f.variable.name).join(', ')} `
      + `would not go: ${failed[0].error.message}`, 'bad');
  } else {
    notice(`Deleted ${deleted.length} file${deleted.length === 1 ? '' : 's'}.`);
  }
  await onChanged?.();
}

function strayList(sorted) {
  const wrap = el('div');
  wrap.append(el('h2', 'category', 'Not from the store'));
  wrap.append(el('p', 'dim',
    'Files on the calculator that no installed package accounts for. Saved '
    + 'games live here, and so does anything sent across by hand — so read it '
    + 'before you empty it. Tick what you are sure of.'));

  const boxes = new Map();
  const rows = el('ul', 'plain installed');

  const actions = el('div', 'app-actions');
  const bulk = el('button', 'danger', 'Delete selected');
  bulk.disabled = isBusy();

  const chosen = () => sorted.filter((variable) => boxes.get(variable).checked);
  const update = () => {
    const picked = chosen();
    const freed = picked.reduce((sum, variable) => sum + variable.bytes, 0);
    bulk.disabled = picked.length === 0;
    bulk.textContent = picked.length
      ? `Delete ${picked.length} selected — frees ${kb(freed)}`
      : 'Delete selected';
  };

  for (const variable of sorted) {
    const row = el('li');

    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.addEventListener('change', update);
    boxes.set(variable, box);

    const main = el('div');
    main.append(el('strong', null, variable.name));
    main.append(el('span', 'dim',
      `  ${describeType(variable.type)}, ${kb(variable.bytes)}`
      + `${variable.archived ? '' : ', in RAM'}`));
    label.append(box, main);
    row.append(label);

    const button = el('button', 'danger small-button', 'Delete');
    button.disabled = isBusy();
    button.addEventListener('click', () => removeStray(variable));
    row.append(button);
    rows.append(row);
  }
  wrap.append(rows);

  bulk.addEventListener('click', () => removeStrays(chosen()));
  actions.append(bulk);
  update();
  wrap.append(actions);

  return wrap;
}

/* ------------------------------------------------- installs that did not end */

/*
 * Finish or clear a package whose row was written but whose files never all
 * arrived.
 *
 * This used to happen on connect, as a dialog per stuck package, before the
 * user had asked for anything -- and answering it installed or removed things.
 * Plugging a calculator in is not consent to change it, so it lives here now:
 * visible the moment you look at the Device tab, and inert until pressed.
 */
async function finishInstall(id) {
  return exclusive('Finishing an install', async () => {
    const session = getSession();
    const stuck = session.find(id);
    if (!stuck) return;

    const bar = progress(`Finishing ${stuck.name}`);
    try {
      /*
       * Verified now rather than at render time. It costs one round trip per
       * file, which is fine once somebody has asked, and would be a lot of
       * traffic to spend on drawing a list nobody may act on.
       */
      const { unsupported } = await session.verify(id);
      if (unsupported.length) {
        bar.close();
        notice(`The BlueObject on this calculator is too old to handle `
          + `${unsupported.join(', ')}, which is why the install stopped. `
          + `Update BlueObject from the Store, then install this again.`, 'bad');
        return;
      }

      await session.apply(id, {
        explicit: stuck.explicit,
        onMessage: showMessage,
      });
      bar.close();
      notice(`${stuck.name} finished installing.`);
    } catch (error) {
      bar.close();
      if (error instanceof InstallCancelled) {
        notice(`${stuck.name} was stopped again, and is still part-way.`,
               'action');
      } else {
        notice(`Could not finish ${stuck.name}: ${error.message}`, 'bad');
      }
    }
    await onChanged?.();
  });
}

async function clearInstall(id) {
  const session = getSession();
  const stuck = session.find(id);
  if (!stuck) return undefined;

  const answer = await ask({
    title: `Remove ${stuck.name}?`,
    body: `The install did not finish, so some of its files may not be there. `
      + `This deletes the ones that are, and takes the package out of the `
      + `index.`,
    actions: [
      { id: null, label: 'Leave it' },
      { id: 'go', label: 'Remove', kind: 'danger' },
    ],
  });
  if (answer !== 'go') return undefined;

  return exclusive('Removing', async () => {
    try {
      await session.remove(id);
      notice(`${stuck.name} removed.`);
    } catch (error) {
      notice(`Could not remove ${stuck.name}: ${error.message}`, 'bad');
    }
    await onChanged?.();
  });
}

/*
 * `present` is what LIST reported, or null on a BlueObject too old to have it.
 * Which files are absent is worked out from that rather than from a round trip
 * per file, so drawing this list costs nothing.
 */
function unfinishedList(stuck, present) {
  const wrap = el('div');
  wrap.append(el('h2', 'category', 'Unfinished installs'));
  wrap.append(el('p', 'dim',
    'These were interrupted part way. The index records what each one would '
    + 'have owned, so either finishing or removing it is possible — and only '
    + 'you can say which.'));

  const here = present ? new Set(present.map((v) => v.name)) : null;

  const rows = el('ul', 'plain installed');
  for (const pkg of stuck) {
    const row = el('li');

    const main = el('div');
    main.append(el('strong', null, `${pkg.name} ${pkg.version}`));

    const absent = here ? pkg.files.filter((f) => !here.has(f.name)) : [];
    main.append(el('div', 'dim small', here
      ? (absent.length
        ? `${absent.map((f) => f.name).join(', ')} never arrived`
        : 'everything arrived, but the install was not recorded as finished')
      : `${pkg.files.length} file${pkg.files.length === 1 ? '' : 's'} claimed`));
    row.append(main);

    const actions = el('div', 'app-actions');
    const finish = el('button', 'primary small-button', 'Finish');
    finish.disabled = isBusy();
    finish.addEventListener('click', () => finishInstall(pkg.id));
    const drop = el('button', 'danger small-button', 'Remove');
    drop.disabled = isBusy();
    drop.addEventListener('click', () => clearInstall(pkg.id));
    actions.append(finish, drop);
    row.append(actions);

    rows.append(row);
  }
  wrap.append(rows);
  return wrap;
}

/*
 * A calculator with no index cannot be installed to, deliberately: the index is
 * the only record of which variable belongs to which package, so files written
 * without one could never be uninstalled. Starting a fresh one is allowed,
 * because at that point there is nothing left to protect -- but it writes to the
 * archive, so it is a button rather than something connecting does for you.
 */
function setupSection() {
  const wrap = el('div');
  wrap.append(el('h2', 'category', 'Not set up'));
  wrap.append(el('p', null,
    'This calculator has no BlueObject index yet, so nothing can be installed '
    + 'to it. Setting it up creates an empty one. Anything already on the '
    + 'calculator is left alone.'));

  const actions = el('div', 'app-actions');
  const button = el('button', 'primary', 'Set it up');
  button.disabled = isBusy();
  button.addEventListener('click', () => exclusive('Setting up', async () => {
    try {
      await getSession().initialise();
      notice('Set up. You can install things now.');
    } catch (error) {
      notice(`Could not set it up: ${error.message}`, 'bad');
    }
    await onChanged?.();
  }));
  actions.append(button);
  wrap.append(actions);
  return wrap;
}

function missingList(missing) {
  const wrap = el('div');
  wrap.append(el('h2', 'category', 'Recorded but not there'));
  wrap.append(el('p', 'dim',
    'The index says these were installed, but the calculator does not have '
    + 'them. Reinstalling the package puts them back.'));

  const rows = el('ul', 'plain installed');
  for (const entry of missing) {
    const row = el('li');
    const main = el('div');
    main.append(el('strong', null, entry.package.name));
    main.append(el('div', 'dim small',
      `missing ${entry.files.map((f) => f.name).join(', ')}`));
    row.append(main);
    rows.append(row);
  }
  wrap.append(rows);
  return wrap;
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
    button.disabled = isBusy();
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

  /*
   * Above the installed list on purpose. An unfinished install is the one thing
   * here that is actively wrong, and it is what somebody who has just watched a
   * transfer fail has come to this tab to deal with.
   */
  const stuck = session ? session.interrupted() : [];
  if (stuck.length) wrap.append(unfinishedList(stuck, contents));

  if (session && !hello.hasIndex) wrap.append(setupSection());

  if (session) wrap.append(installedList(session));

  if (session && contents) {
    const { stray, missing } = classifyVariables(contents, session.packages);
    const sorted = [...stray].sort((a, b) => b.bytes - a.bytes);
    if (sorted.length) wrap.append(strayList(sorted));

    /*
     * Packages already listed as unfinished are not repeated here. They are the
     * same files, but a different problem with a different fix: this section is
     * for a package that finished installing and then lost files afterwards.
     */
    const unfinished = new Set(stuck.map((p) => p.id));
    const lost = missing.filter((m) => !unfinished.has(m.package.id));
    if (lost.length) wrap.append(missingList(lost));
  }

  /*
   * Everything that has crossed the cable this session, kept after whatever
   * dialog was showing it has gone. This is where somebody comes when an
   * install failed and the one-line reason did not explain it, and a log they
   * can copy is the difference between "it crashed" and a bug report.
   *
   * The panel is rebuilt wholesale on every redraw, so the previous block's
   * subscription has to be let go or it redraws into a detached tree for ever.
   */
  logBlock?.stop();
  logBlock = advancedLog();
  wrap.append(logBlock.node);

  panel.replaceChildren(wrap);
}

/**
 * Ask the calculator what it is actually holding.
 *
 * Optional in both directions: an older BlueObject does not know the command
 * and says so, which is not a failure worth reporting -- the rest of the panel
 * is unaffected and the extra sections simply do not appear.
 */
export async function scan(calculator) {
  contents = null;
  if (!calculator) return;
  try {
    contents = await calculator.listVariables();
  } catch {
    contents = null;
  }
}

export function init(hooks) {
  getSession = hooks.getSession;
  onChanged = hooks.onChanged;
  exclusive = hooks.exclusive;
  isBusy = hooks.isBusy;
}
