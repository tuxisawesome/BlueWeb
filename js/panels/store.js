/*
 * The App Store: the catalogue, one app's page, and the install flow.
 */

import { loadCatalog, loadManifest, search, reset } from '../catalog.js';
import { getChannel } from '../channel.js';
import {
  developerMode, setDeveloperMode, UNLOCK_TAPS, COUNTDOWN_FROM,
} from '../developer.js';
import { resolveInstallAll, DependencyError } from '../deps.js';
import { compareVersions } from '../version.js';
import { ask, progress, showMessage, notice, advancedLog, el } from '../ui.js';
import { runPlan } from '../progress.js';
import { InstallCancelled } from '../install.js';

let catalog = null;
let onChanged = null;
let redraw = null;
let getSession = null;
let exclusive = null;  /* run an operation with the calculator held */
let isBusy = null;

const KB = 1024;
const kb = (bytes) => `${(bytes / KB).toFixed(bytes < 10 * KB ? 1 : 0)} KB`;

/* What a batch is called in a title, a button and a notice. Named rather than
 * counted while there is one, because the name is the more useful of the two
 * and a count of one reads as a mistake. */
const batchName = (entries) =>
  (entries.length === 1 ? entries[0].name : `${entries.length} apps`);

/* ----------------------------------------------------------- the selection */

/*
 * Whether the Store is picking apps rather than browsing them.
 *
 * A mode with a button that turns it on, instead of a checkbox sitting on every
 * card all the time. Two reasons, and the second is the one that decided it.
 *
 * A checkbox in the corner of a card announces nothing. Somebody who has not
 * been told the Store can install several apps at once will not find out from
 * looking at it, and the whole feature is invisible to exactly the people it
 * would help. A button labelled "Select" says what is on offer, in the place
 * they are already looking.
 *
 * And once there is a mode, the target can be the whole card instead of an
 * 18-pixel box in the corner of it. In here a click picks the app up rather
 * than opening it, which is the same bargain every file manager makes.
 */
let selecting = false;

/*
 * Which apps are ticked, by id, in the order they were ticked.
 *
 * Module state rather than something read back off the cards, because render()
 * replaces the whole panel on every keystroke in the search box and on every
 * refresh of the page. A selection kept in the DOM would be thrown away by
 * typing a letter, and thrown away silently, which is the worst way to lose
 * one.
 */
const selected = new Set();

/** Whether the catalogue has nothing left to offer for this app. */
function upToDate(entry, session) {
  const installed = session?.find(entry.id);
  return !!installed && compareVersions(entry.version, installed.version) <= 0;
}

/**
 * The ticked apps, as catalogue entries, with anything the tick no longer means
 * dropped.
 *
 * Three things can hollow out a tick: the channel changing under it so the
 * package is not in the catalogue any more, the app being installed from its
 * own page, and the batch itself finishing. Pruning here rather than clearing
 * the selection at the end of an install answers all three the same way -- and
 * answers the install that only half succeeded without anyone having to work
 * out which half.
 */
function chosen() {
  const session = getSession();
  const entries = [];
  for (const id of [...selected]) {
    const entry = catalog?.byId.get(id);
    if (!entry || upToDate(entry, session)) {
      selected.delete(id);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/* ------------------------------------------------------------- the install */

/**
 * Show what installing would involve, and let the user decide.
 *
 * Everything the resolver pulled in is listed with the reason it is there. A
 * dialog that said only "install Snake?" and then quietly put three other
 * things on the calculator would be lying by omission.
 *
 * Which is also why the list does not collapse to a count when several apps
 * were ticked. Reading back "11 apps" confirms nothing, and a box ticked by
 * accident is the whole of what this is here to catch.
 */
async function confirmPlan(entries, plan, session) {
  const body = el('div');

  const rows = el('ul', 'plain');
  for (const item of plan.order) {
    const why = plan.reasons.get(item.id);
    const existing = session.find(item.id);

    const row = el('li');
    row.append(el('strong', null, `${item.name} ${item.version}`));
    if (existing) {
      row.append(el('span', 'dim', `  updating from ${existing.version}`));
    } else if (why?.requiredBy) {
      const needed = catalog.byId.get(why.requiredBy);
      row.append(el('span', 'dim', `  required by ${needed?.name || why.requiredBy}`));
    }
    rows.append(row);
  }
  body.append(rows);

  const total = plan.order.reduce((sum, item) => sum + (item.bytes || 0), 0);
  const free = session.calculator.hello?.freeArchive ?? 0;
  body.append(el('p', 'dim',
    `${kb(total)} to transfer. ${kb(free)} free, ${kb(Math.max(0, free - total))} after.`));

  /* A system package ends with the user having to leave the page and do
   * something on the calculator, which is worth saying before they start. */
  if (plan.order.some((item) => item.kind === 'system')) {
    body.append(el('p', 'warn',
      'This includes a system update. When it finishes you will need to quit '
      + 'BlueObject and run a program on the calculator to complete it.'));
  }

  const tooBig = plan.order.filter((item) =>
    item.maxFile > (session.calculator.hello?.maxVarBytes ?? Infinity));
  if (tooBig.length) {
    body.append(el('p', 'bad',
      `${tooBig.map((t) => t.name).join(', ')} contains a file larger than this `
      + `calculator can build in RAM, and cannot be installed.`));
  }

  /*
   * What was asked for by name, and then how much else came with it. Everything
   * ticked is in `order` -- chosen() has already dropped anything with nothing
   * to send -- so the remainder is exactly the dependencies.
   */
  const what = batchName(entries);
  const extra = Math.max(0, plan.order.length - entries.length);

  const answer = await ask({
    title: extra ? `Install ${what} and ${extra} more?` : `Install ${what}?`,
    body,
    actions: tooBig.length
      ? [{ id: null, label: 'Close' }]
      : [
        { id: 'go', label: 'Install', kind: 'primary' },
        { id: null, label: 'Cancel' },
      ],
  });
  return answer === 'go';
}

/**
 * Install one app or a batch of them. `entries` is catalogue entries.
 *
 * One function for both because there is nothing about a batch that a single
 * app does not also have: the resolver already returned several packages for
 * one app, and the bar already spanned however many it returned. All that
 * changes with a second root is the wording.
 */
async function install(entries) {
  if (!entries.length) return undefined;
  return exclusive(`Installing ${batchName(entries)}`, () => installNow(entries));
}

/*
 * Manifests for the version ranges.
 *
 * The catalogue index carries dependency ids but not the ranges, so the shape
 * of the graph comes from the index and the ranges come from here. One level
 * deep, as it has always been: what was asked for, and what it names.
 */
async function manifestsFor(entries) {
  const wanted = new Set();
  for (const entry of entries) {
    wanted.add(entry.id);
    for (const dep of entry.deps || []) wanted.add(dep);
  }

  const manifests = new Map();
  for (const id of wanted) {
    if (catalog.byId.has(id)) manifests.set(id, await loadManifest(catalog, id));
  }
  return manifests;
}

async function installNow(entries) {
  const session = getSession();
  if (!session) {
    notice('Connect a calculator first.', 'bad');
    return;
  }

  const what = batchName(entries);

  let plan;
  try {
    plan = resolveInstallAll(
      catalog, session.packages, entries.map((entry) => entry.id),
      await manifestsFor(entries));
  } catch (error) {
    notice(error instanceof DependencyError
      ? error.message
      : `Could not work out what ${what} needs: ${error.message}`, 'bad');
    return;
  }

  if (!plan.order.length) {
    notice(entries.length === 1
      ? `${entries[0].name} is already installed and up to date.`
      : 'Those are all already installed and up to date.');
    return;
  }

  if (!await confirmPlan(entries, plan, session)) return;

  const bar = progress(`Installing ${what}`);
  const log = advancedLog();
  bar.attach(log.node);

  /*
   * A defragment stops the bytes for as long as it takes, and the calculator
   * may be waiting to be told to go ahead. Silence here is what made this look
   * like a dead link.
   */
  const calculator = session.calculator;
  const wasBusy = calculator.onBusy;
  calculator.onBusy = () => {
    bar.detail('The calculator is defragmenting its archive.');
    bar.rate('This can take several minutes, and it may be asking you to '
      + 'confirm on its own screen.');
  };

  try {
    await runPlan({
      session,
      items: plan.order,
      bar,
      explicitFor: (item) => plan.requested.has(item.id),
      onMessage: showMessage,
    });
    log.stop();
    bar.close();
    notice(entries.length === 1
      ? `${entries[0].name} installed.`
      : `${entries.length} apps installed.`);
  } catch (error) {
    /*
     * Stopping at a message is a decision, not a fault, so it does not get the
     * failure dialog. What it does get is an honest account of where it
     * stopped: before anything was sent, or part-way, which the Device panel
     * can then finish or undo.
     */
    if (error instanceof InstallCancelled) {
      log.stop();
      bar.close();
      /* Whatever it stopped in the middle of, not whatever was asked for:
       * stopping a batch at the fourth app leaves the fourth one half-written
       * and the three before it finished. */
      const stuck = session.interrupted()
        .map((p) => catalog.byId.get(p.id)?.name || p.id);
      notice(stuck.length
        ? `${stuck.join(', ')} was stopped part-way. The Device panel can `
          + `finish or undo it.`
        : `${what} was not installed.`, 'action');
      await onChanged?.();
      return;
    }
    /*
     * The dialog stays up, because the log inside it is the only record of what
     * was happening and closing it throws that away at the worst moment.
     */
    bar.fail(`Could not install ${what}: ${error.message}`, () => log.stop());
    await onChanged?.();
    return;
  } finally {
    calculator.onBusy = wasBusy;
  }

  await onChanged?.();
}

/* ---------------------------------------------------------------- the page */

function appPage(entry) {
  const page = el('div', 'app-page');

  const back = el('button', 'link', '← All apps');
  back.addEventListener('click', () => render());
  page.append(back);

  const head = el('div', 'app-head');
  head.append(el('h2', null, entry.name));
  head.append(el('span', 'dim', `${entry.version} · ${kb(entry.bytes)}`));
  page.append(head);

  const session = getSession();
  const installed = session?.find(entry.id);

  const actions = el('div', 'app-actions');
  const button = el('button', 'primary');

  if (!session) {
    button.textContent = 'Install';
    button.disabled = true;
    button.title = 'Connect a calculator first';
  } else if (!installed) {
    button.textContent = 'Install';
  } else if (compareVersions(entry.version, installed.version) > 0) {
    button.textContent = `Update to ${entry.version}`;
  } else {
    button.textContent = 'Installed';
    button.disabled = true;
  }
  /* Whatever the button says, it cannot be pressed while the link is held. */
  if (isBusy()) {
    button.disabled = true;
    button.title = 'Something else is using the calculator';
  }

  button.addEventListener('click', () => install([entry]));
  actions.append(button);

  if (installed) {
    actions.append(el('span', 'dim', `Version ${installed.version} is on the calculator.`));
  }
  page.append(actions);

  page.append(el('p', null, entry.summary || ''));

  /* The full description lives in the package manifest, so it arrives after
   * the page does. */
  const detail = el('div', 'app-detail');
  page.append(detail);
  loadManifest(catalog, entry.id).then((manifest) => {
    if (manifest.description) {
      for (const paragraph of manifest.description.split('\n\n')) {
        detail.append(el('p', null, paragraph));
      }
    }
    const facts = el('dl');
    if (manifest.author) facts.append(el('dt', null, 'Author'), el('dd', null, manifest.author));
    if (entry.deps?.length) {
      facts.append(el('dt', null, 'Needs'), el('dd', null, entry.deps
        .map((id) => catalog.byId.get(id)?.name || id).join(', ')));
    }
    /*
     * What the package can use but starts without, and what for.
     *
     * Worth a line of its own rather than being folded in with "Needs": the
     * difference decides whether somebody has to install something else before
     * this is any use, and Cesium reads a USB drive with the C Libraries and
     * runs perfectly well without them. It comes from the manifest rather than
     * the index because nothing has to resolve it -- an optional dependency is
     * never installed for you, which is the whole of what makes it optional.
     */
    for (const dep of manifest.optionalDependencies || []) {
      const id = typeof dep === 'string' ? dep : dep.id;
      const name = catalog.byId.get(id)?.name || id;
      const reason = typeof dep === 'string' ? null : dep.reason;
      facts.append(el('dt', null, 'Can use'),
                   el('dd', null, reason ? `${name} — ${reason}` : name));
    }
    facts.append(el('dt', null, 'Largest file'), el('dd', null, kb(entry.maxFile)));
    detail.append(facts);
  }).catch((error) => {
    detail.append(el('p', 'bad', `Could not load the details: ${error.message}`));
  });

  return page;
}

/* ---------------------------------------------------------------- the list */

/*
 * One app in the grid, in whichever of the two modes the Store is in.
 *
 * Browsing, it is what it always was: one button, and pressing it opens the
 * app. Selecting, the same button picks the app up instead, and the card grows
 * a tick box to show it. The box is a decoration -- `aria-hidden`, no click
 * handler -- because the button it sits on already carries the state as
 * `aria-pressed`, and two things reporting one fact is how they come to
 * disagree.
 *
 * `onPick` redraws the bar at the foot of the panel, so ticking a card does not
 * re-render the grid underneath the click.
 */
function card(entry, onPick) {
  const session = getSession();
  const installed = session?.find(entry.id);

  const node = el('div', 'card');
  const open = el('button', 'card-open');

  if (selecting) {
    node.classList.add('selectable');

    /*
     * Nothing left to send, so nothing to pick up. Shown and disabled rather
     * than left out: the grid keeps its shape as things are installed, instead
     * of closing the gap under whatever somebody was reaching for.
     */
    if (upToDate(entry, session)) {
      node.classList.add('unavailable');
      open.disabled = true;
      open.title = `${entry.name} is already installed and up to date`;
    } else {
      const mark = () => {
        const on = selected.has(entry.id);
        node.classList.toggle('picked', on);
        open.setAttribute('aria-pressed', String(on));
      };
      mark();
      open.addEventListener('click', () => {
        if (selected.has(entry.id)) selected.delete(entry.id);
        else selected.add(entry.id);
        mark();
        onPick();
      });
    }

    const tick = el('span', 'card-pick');
    tick.setAttribute('aria-hidden', 'true');
    node.append(tick);
  } else {
    open.addEventListener('click', () => show(appPage(entry)));
  }

  open.append(el('span', 'card-name', entry.name));
  open.append(el('span', 'card-summary', entry.summary || ''));

  const foot = el('span', 'card-foot');
  foot.append(el('span', 'dim', entry.version));
  if (entry.disabled) {
    /* Visible on the card, not just in the list it came from. Somebody who
     * unlocked these a week ago should not have to remember which is which. */
    foot.append(el('span', 'tag hidden', 'Hidden'));
  }
  if (installed) {
    foot.append(el('span',
      compareVersions(entry.version, installed.version) > 0 ? 'tag update' : 'tag',
      compareVersions(entry.version, installed.version) > 0 ? 'Update' : 'Installed'));
  }
  open.append(foot);

  node.append(open);
  return node;
}

/*
 * What is picked, and the button that installs it.
 *
 * Up the moment Select is pressed, empty count and all, rather than appearing
 * once something is ticked. It is the answer to "I pressed Select, now what":
 * the mode says what it wants, and where the way out of it is.
 *
 * Stuck to the bottom of the window, because the grid is taller than the
 * viewport on most screens and a bar you have to scroll back up to find is a
 * bar people stop believing in. The count is also the only place a card picked
 * twenty rows down is visible at all.
 */
function selectionBar(picked, query) {
  const bar = el('div', 'selection-bar');
  bar.append(picked.length
    ? el('span', null, `${batchName(picked)} selected`)
    : el('span', 'dim', 'Pick the apps you want, then install them together.'));

  const actions = el('div', 'selection-actions');

  const go = el('button', 'primary',
    picked.length > 1 ? `Install ${picked.length}` : 'Install');

  /* Nothing picked, then the same two reasons an app page's Install button is
   * dead, said the same way. Picking apps with nothing plugged in is allowed --
   * it is choosing, not installing -- and this is where that stops. */
  if (!picked.length) {
    go.disabled = true;
  } else if (!getSession()) {
    go.disabled = true;
    go.title = 'Connect a calculator first';
  } else if (isBusy()) {
    go.disabled = true;
    go.title = 'Something else is using the calculator';
  }

  go.addEventListener('click', async () => {
    await install(chosen());
    /*
     * Everything that went on is pruned from the selection, so an empty one
     * means it worked, and a mode with nothing left to do in it should not have
     * to be dismissed by hand. Anything still picked failed or was stopped, and
     * staying in here is what makes trying again one press.
     */
    if (!chosen().length) selecting = false;
    render(query);
  });
  actions.append(go);

  bar.append(actions);
  return bar;
}

function show(node) {
  const panel = document.getElementById('panel-store');
  panel.replaceChildren(node);
}

/*
 * The catalogue line at the foot of the Store, and the way in to the hidden
 * packages.
 *
 * It earns its place on its own: when the Store is showing something
 * unexpected, the first question is which catalogue it came from and which
 * build channel is selected, and until now neither was written down anywhere.
 * That it is also the thing to tap twenty times is the same trick as tapping a
 * phone's build number, and for the same reason -- it is a line nobody presses
 * by accident.
 *
 * Which is why it is a paragraph and not a button. Anything that looks pressable
 * invites pressing, and a footnote that announces itself as a way in is not
 * hidden at all -- a phone's build number is ordinary text too. It costs the
 * keyboard route in, which is the intended trade: this is for whoever already
 * knows it is here.
 */
let taps = 0;

function catalogueLine() {
  const line = el('p', 'footnote');
  const unlocked = developerMode();

  const describe = () => {
    const revision = (catalog?.revision || '').replace('T', ' ').replace('Z', '');
    line.textContent = `Catalogue ${revision} · ${getChannel()} channel`
      + (unlocked ? ' · developer options on' : '');
  };
  describe();

  line.addEventListener('click', () => {
    if (developerMode()) return;  /* Already on; Settings is where it goes off. */

    taps++;
    const left = UNLOCK_TAPS - taps;

    if (left <= 0) {
      taps = 0;
      if (setDeveloperMode(true)) {
        notice('Developer options are on. Settings has the build channel and '
          + 'the switch to turn all this off again.');
      } else {
        notice('This browser will not let the page remember that, so developer '
          + 'options will be off again when you reload.', 'warn');
      }
      /* Settings grows a section the moment this goes on, and switching tabs
       * does not redraw on its own. */
      redraw();
      return;
    }

    if (left <= COUNTDOWN_FROM) {
      line.textContent = left === 1
        ? '1 more' : `${left} more`;
    }
  });

  return line;
}

export function render(query = '') {
  const panel = document.getElementById('panel-store');
  if (!catalog) {
    panel.replaceChildren(el('p', 'placeholder', 'Loading the catalogue…'));
    return;
  }

  const wrap = el('div');

  const tools = el('div', 'store-tools');

  const box = el('input', 'search');
  box.type = 'search';
  box.placeholder = 'Search apps';
  box.value = query;
  box.addEventListener('input', () => render(box.value));
  tools.append(box);

  /*
   * The way in and the way out of picking several at once. Cancel rather than
   * Done, because leaving throws the selection away and a button called Done
   * would be claiming the opposite.
   */
  const toggle = el('button', null, selecting ? 'Cancel' : 'Select');
  toggle.title = selecting
    ? 'Stop picking apps'
    : 'Pick several apps and install them in one go';
  toggle.addEventListener('click', () => {
    selecting = !selecting;
    if (!selecting) selected.clear();
    render(query);
  });
  tools.append(toggle);

  wrap.append(tools);

  /*
   * The bar lives in a box of its own and is replaced inside it, rather than
   * the panel being re-rendered every time a card is picked. Redrawing the grid
   * under a click would take the search box's caret and the scroll position
   * with it, and picking three in a row is the ordinary case here.
   */
  const selection = el('div');
  const drawSelection = () => {
    selection.replaceChildren(
      ...(selecting ? [selectionBar(chosen(), query)] : []));
  };

  const hidden = developerMode();
  const matches = search(catalog, query, { hidden });

  if (!matches.length) {
    /* A selection made before the search box narrowed to nothing is still a
     * selection, so the bar stays below this. */
    wrap.append(el('p', 'placeholder', `Nothing matches "${query}".`));
  } else {
    for (const category of catalog.categories) {
      const inCategory = matches.filter((a) => a.category === category.id);
      if (!inCategory.length) continue;

      wrap.append(el('h2', 'category', category.name));
      const grid = el('div', 'grid');
      for (const entry of inCategory) grid.append(card(entry, drawSelection));
      wrap.append(grid);
    }
  }

  drawSelection();
  wrap.append(selection);
  wrap.append(catalogueLine());
  show(wrap);
  /* Put the caret back where it was; replaceChildren threw the old box away. */
  if (query) {
    const fresh = wrap.querySelector('.search');
    fresh.focus();
    fresh.setSelectionRange(query.length, query.length);
  }
}

export async function init(hooks) {
  getSession = hooks.getSession;
  onChanged = hooks.onChanged;
  redraw = hooks.redraw;
  exclusive = hooks.exclusive;
  isBusy = hooks.isBusy;

  return load();
}

/*
 * Fetch the catalogue for whichever channel is selected.
 *
 * Called again when the channel changes. What is cached in catalog.js is one
 * channel's resolved answer rather than the raw index, so the cache is dropped
 * first -- keeping it would serve the old channel's versions under the new
 * channel's name, which is the one mistake here that would install the wrong
 * build without saying anything.
 */
export async function load() {
  reset();
  try {
    catalog = await loadCatalog(getChannel());
    render();
  } catch (error) {
    catalog = null;
    document.getElementById('panel-store').replaceChildren(
      el('p', 'bad', `Could not load the catalogue: ${error.message}`));
  }
  return catalog;
}

export function getCatalog() {
  return catalog;
}
