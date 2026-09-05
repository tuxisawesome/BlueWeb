/*
 * The App Store: the catalogue, one app's page, and the install flow.
 */

import { loadCatalog, loadManifest, search, reset } from '../catalog.js';
import { getChannel } from '../channel.js';
import {
  showHidden, setShowHidden, UNLOCK_TAPS, COUNTDOWN_FROM,
} from '../testing.js';
import { resolveInstall, DependencyError } from '../deps.js';
import { compareVersions } from '../version.js';
import { ask, progress, showMessages, notice, advancedLog, el } from '../ui.js';
import { runPlan } from '../progress.js';

let catalog = null;
let onChanged = null;
let redraw = null;
let getSession = null;
let exclusive = null;  /* run an operation with the calculator held */
let isBusy = null;

const KB = 1024;
const kb = (bytes) => `${(bytes / KB).toFixed(bytes < 10 * KB ? 1 : 0)} KB`;

/* ------------------------------------------------------------- the install */

/**
 * Show what installing would involve, and let the user decide.
 *
 * Everything the resolver pulled in is listed with the reason it is there. A
 * dialog that said only "install Snake?" and then quietly put three other
 * things on the calculator would be lying by omission.
 */
async function confirmPlan(entry, plan, session) {
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

  const answer = await ask({
    title: plan.order.length === 1
      ? `Install ${entry.name}?`
      : `Install ${entry.name} and ${plan.order.length - 1} more?`,
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

async function install(entry) {
  return exclusive(`Installing ${entry.name}`, () => installNow(entry));
}

async function installNow(entry) {
  const session = getSession();
  if (!session) {
    notice('Connect a calculator first.', 'bad');
    return;
  }

  let plan;
  try {
    /* Manifests for anything in the graph, so version ranges are real rather
     * than assumed from the catalogue index. */
    const manifests = new Map();
    for (const app of catalog.apps) {
      if (app.id === entry.id || (entry.deps || []).includes(app.id)) {
        manifests.set(app.id, await loadManifest(catalog, app.id));
      }
    }
    plan = resolveInstall(catalog, session.packages, entry.id, manifests);
  } catch (error) {
    notice(error instanceof DependencyError
      ? error.message
      : `Could not work out what ${entry.name} needs: ${error.message}`, 'bad');
    return;
  }

  if (!plan.order.length) {
    notice(`${entry.name} is already installed and up to date.`);
    return;
  }

  if (!await confirmPlan(entry, plan, session)) return;

  const bar = progress(`Installing ${entry.name}`);
  const log = advancedLog();
  bar.attach(log.node);
  session.messages.length = 0;

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
      explicitFor: (item) => item.id === entry.id,
    });
    log.stop();
    bar.close();
    await showMessages(session.messages);
    notice(`${entry.name} installed.`);
  } catch (error) {
    /*
     * The dialog stays up, because the log inside it is the only record of what
     * was happening and closing it throws that away at the worst moment.
     */
    bar.fail(`Could not install ${entry.name}: ${error.message}`, () => log.stop());
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

  button.addEventListener('click', () => install(entry));
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
    facts.append(el('dt', null, 'Largest file'), el('dd', null, kb(entry.maxFile)));
    detail.append(facts);
  }).catch((error) => {
    detail.append(el('p', 'bad', `Could not load the details: ${error.message}`));
  });

  return page;
}

/* ---------------------------------------------------------------- the list */

function card(entry) {
  const session = getSession();
  const installed = session?.find(entry.id);

  const node = el('button', 'card');
  node.append(el('span', 'card-name', entry.name));
  node.append(el('span', 'card-summary', entry.summary || ''));

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
  node.append(foot);

  node.addEventListener('click', () => show(appPage(entry)));
  return node;
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
  const unlocked = showHidden();

  const describe = () => {
    const revision = (catalog?.revision || '').replace('T', ' ').replace('Z', '');
    line.textContent = `Catalogue ${revision} · ${getChannel()} channel`
      + (unlocked ? ' · showing hidden packages' : '');
  };
  describe();

  line.addEventListener('click', () => {
    if (showHidden()) return;   /* Already on; Settings is where it goes off. */

    taps++;
    const left = UNLOCK_TAPS - taps;

    if (left <= 0) {
      taps = 0;
      if (setShowHidden(true)) {
        notice('Hidden packages are now in the Store. Settings has the switch '
          + 'to put them away again.');
      } else {
        notice('This browser will not let the page remember that, so hidden '
          + 'packages will be put away again when you reload.', 'warn');
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

  const box = el('input', 'search');
  box.type = 'search';
  box.placeholder = 'Search apps';
  box.value = query;
  box.addEventListener('input', () => render(box.value));
  wrap.append(box);

  const hidden = showHidden();
  const matches = search(catalog, query, { hidden });
  if (!matches.length) {
    wrap.append(el('p', 'placeholder', `Nothing matches "${query}".`));
    wrap.append(catalogueLine());
    show(wrap);
    return;
  }

  for (const category of catalog.categories) {
    const inCategory = matches.filter((a) => a.category === category.id);
    if (!inCategory.length) continue;

    wrap.append(el('h2', 'category', category.name));
    const grid = el('div', 'grid');
    for (const entry of inCategory) grid.append(card(entry));
    wrap.append(grid);
  }

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
