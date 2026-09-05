/*
 * Updates, in two groups.
 *
 * A **system** update is one that needs the user to go and run something on the
 * calculator when the transfer finishes -- BlueObject needs prgmBLUEUP, Cesium
 * needs prgmCESIUM. An **app** update is done when the transfer is done. That
 * is the whole of the distinction, and it is the one the user actually
 * experiences, so it is what the panel is split on.
 */

import { findUpdates, resolveInstall } from '../deps.js';
import { progress, showMessage, notice, advancedLog, el } from '../ui.js';
import { runPlan } from '../progress.js';
import { InstallCancelled } from '../install.js';
import { loadManifest } from '../catalog.js';

let getSession = null;
let getCatalog = null;
let onChanged = null;
let exclusive = null;  /* run an operation with the calculator held */
let isBusy = null;

const KB = 1024;
const kb = (bytes) => `${(bytes / KB).toFixed(bytes < 10 * KB ? 1 : 0)} KB`;

async function runUpdates(items) {
  return exclusive('Updating', () => runUpdatesNow(items));
}

async function runUpdatesNow(items) {
  const session = getSession();
  const catalog = getCatalog();
  const bar = progress(`Updating ${items.length} package${items.length === 1 ? '' : 's'}`);
  const log = advancedLog();
  bar.attach(log.node);

  const calculator = session.calculator;
  const wasBusy = calculator.onBusy;
  calculator.onBusy = () => {
    bar.detail('The calculator is defragmenting its archive.');
    bar.rate('This can take several minutes, and it may be asking you to '
      + 'confirm on its own screen.');
  };

  try {
    /*
     * An update may have picked up a new dependency since it was installed, so
     * each goes through the resolver rather than straight to apply(). Resolve
     * the lot first: one bar across everything needs to know everything, and
     * resolving costs manifests rather than transfers.
     */
    const order = [];
    const explicit = new Map();
    for (const item of items) {
      const manifests = new Map();
      for (const app of catalog.apps) {
        if (app.id === item.entry.id || (item.entry.deps || []).includes(app.id)) {
          manifests.set(app.id, await loadManifest(catalog, app.id));
        }
      }
      const plan = resolveInstall(catalog, session.packages, item.entry.id, manifests);
      for (const step of plan.order) {
        if (order.some((each) => each.id === step.id)) continue;
        order.push(step);
        explicit.set(step.id, step.id === item.entry.id
          ? session.find(step.id)?.explicit ?? true
          : false);
      }
    }

    await runPlan({
      session,
      items: order,
      bar,
      explicitFor: (item) => explicit.get(item.id) ?? false,
      onMessage: showMessage,
    });
    log.stop();
    bar.close();
    notice('Up to date.');
  } catch (error) {
    if (error instanceof InstallCancelled) {
      log.stop();
      bar.close();
      notice(session.interrupted().length
        ? 'Updating was stopped part-way. The Device panel can finish or undo it.'
        : 'Updating was stopped. Nothing else was changed.', 'action');
      await onChanged?.();
      return;
    }
    bar.fail(`Could not finish updating: ${error.message}`, () => log.stop());
    await onChanged?.();
    return;
  } finally {
    calculator.onBusy = wasBusy;
  }

  await onChanged?.();
}

function group(title, items, note, boxes) {
  const wrap = el('div');
  wrap.append(el('h2', 'category', title));
  if (note) wrap.append(el('p', 'dim', note));

  const rows = el('ul', 'plain installed');
  for (const item of items) {
    const row = el('li');
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = true;
    boxes.set(item.entry.id, { box, item });

    const text = el('div');
    text.append(el('strong', null, item.entry.name));
    text.append(el('span', 'dim', ` ${item.from} → ${item.to}`));
    text.append(el('div', 'dim small', `${kb(item.entry.bytes)} to transfer`));

    label.append(box, text);
    row.append(label);
    rows.append(row);
  }
  wrap.append(rows);
  return wrap;
}

export function render() {
  const panel = document.getElementById('panel-updates');
  const session = getSession();
  const catalog = getCatalog();

  if (!session || !catalog) {
    panel.replaceChildren(
      el('p', 'placeholder', 'Connect a calculator to check for updates.'));
    return;
  }

  const updates = findUpdates(catalog, session.packages);
  const armed = session.calculator.hello?.armedItems || [];

  const wrap = el('div');

  /*
   * Something already transferred and waiting on the calculator. It is not an
   * update any more -- there is nothing left to send -- but the user has not
   * finished it, and saying nothing would leave them wondering why the version
   * has not moved.
   */
  if (armed.length) {
    const box = el('div', 'callout');
    box.append(el('strong', null, 'Waiting for you'));
    box.append(el('p', null,
      `${armed.map((a) => `${a.name} ${a.version}`).join(', ')} has been `
      + `transferred. Quit BlueObject and run prgmBLUEUP on the calculator to `
      + `finish installing it.`));
    wrap.append(box);
  }

  if (!updates.length) {
    wrap.append(el('p', 'placeholder', 'Everything is up to date.'));
    panel.replaceChildren(wrap);
    return;
  }

  const boxes = new Map();
  const system = updates.filter((u) => u.kind === 'system');
  const apps = updates.filter((u) => u.kind !== 'system');

  if (system.length) {
    wrap.append(group('System updates', system,
      'These finish on the calculator: when the transfer is done you will need '
      + 'to quit BlueObject and run a program.', boxes));
  }
  if (apps.length) {
    wrap.append(group('App updates', apps, null, boxes));
  }

  const actions = el('div', 'app-actions');

  const all = el('button', 'primary', `Install all ${updates.length}`);
  all.disabled = isBusy();
  all.addEventListener('click', () => runUpdates(updates));
  actions.append(all);

  const selected = el('button', null, 'Install selected');
  selected.disabled = isBusy();
  selected.addEventListener('click', () => {
    const chosen = [...boxes.values()].filter((b) => b.box.checked).map((b) => b.item);
    if (!chosen.length) {
      notice('Nothing is selected.');
      return;
    }
    runUpdates(chosen);
  });
  actions.append(selected);

  wrap.append(actions);
  panel.replaceChildren(wrap);
}

export function init(hooks) {
  exclusive = hooks.exclusive;
  isBusy = hooks.isBusy;
  getSession = hooks.getSession;
  getCatalog = hooks.getCatalog;
  onChanged = hooks.onChanged;
}
