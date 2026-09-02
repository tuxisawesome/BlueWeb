/*
 * BlueWeb: the page half of an app store for the TI-84 Plus CE.
 *
 * No build step and no dependencies -- plain ES modules, served as files. It
 * does need a real origin though: fetch() of a relative path fails from
 * file://, so a double-clicked index.html would show an empty catalogue and no
 * reason why. That case is detected below and explained rather than left
 * looking broken.
 */

import { Calculator, isSupported } from './link.js';
import { Session } from './install.js';
import { notice, clearNotice, ask, el } from './ui.js';

import * as store from './panels/store.js';
import * as device from './panels/device.js';
import * as updates from './panels/updates.js';

let calculator = null;
let session = null;

const PANELS = ['store', 'updates', 'device', 'settings'];

/* ------------------------------------------------------------------ chrome */

function setStatus(text, state = '') {
  const node = document.getElementById('status');
  node.textContent = text;
  node.className = `status ${state}`;
}

function showPanel(name) {
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('active', button.dataset.panel === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.id === `panel-${name}`);
  }
  location.hash = name;
}

/** Redraw everything that depends on what is installed. */
function refresh() {
  device.render(calculator?.hello ?? null, session);
  updates.render();
  store.render();
}

/* -------------------------------------------------------------- connecting */

/*
 * Turn a Web Serial failure into something actionable.
 *
 * These arrive as bare DOMExceptions whose messages say nothing about
 * calculators, and the commonest one on Linux has a fix the user would never
 * guess from "NetworkError".
 */
function describeConnectError(error) {
  if (error?.name === 'NotFoundError') {
    return 'No port chosen. Put BlueObject on its Connect screen, plug the '
      + 'cable in, and pick the calculator from the list.';
  }
  if (error?.name === 'InvalidStateError') {
    return 'That port is already open, possibly in another tab.';
  }
  if (error?.name === 'NetworkError') {
    return 'The port could not be opened. On Linux your user usually needs to '
      + 'be in the "dialout" group; log out and back in after adding it.';
  }
  return error?.message || String(error);
}

/*
 * A calculator with no index cannot be installed to, deliberately: the index is
 * the only record of which variable belongs to which package, so files written
 * without one could never be uninstalled. Starting a fresh one is allowed,
 * because at that point there is nothing left to protect.
 */
async function offerToInitialise() {
  const answer = await ask({
    title: 'Set this calculator up?',
    body: 'This calculator has no BlueObject index yet, so nothing can be '
      + 'installed to it. Setting it up creates an empty one. Anything already '
      + 'on the calculator is left alone.',
    actions: [
      { id: 'go', label: 'Set it up', kind: 'primary' },
      { id: null, label: 'Not now' },
    ],
  });
  if (answer !== 'go') return false;

  await session.initialise();
  return true;
}

/*
 * A package whose row was written but whose files never all arrived. The row
 * names what it would have owned, so both ways out are possible -- and only the
 * user can say which they want.
 */
async function offerToRepair() {
  for (const stuck of session.interrupted()) {
    const { missing } = await session.verify(stuck.id);
    const answer = await ask({
      title: `${stuck.name} did not finish installing`,
      body: missing.length
        ? `${missing.join(', ')} never arrived. You can finish the install or `
          + `remove what did arrive.`
        : `Everything arrived, but the install was interrupted before it could `
          + `be recorded. You can finish it now.`,
      actions: [
        { id: 'finish', label: 'Finish installing', kind: 'primary' },
        { id: 'remove', label: 'Remove it', kind: 'danger' },
        { id: null, label: 'Leave it' },
      ],
    });

    try {
      if (answer === 'finish') await session.apply(stuck.id, { explicit: stuck.explicit });
      else if (answer === 'remove') await session.remove(stuck.id);
    } catch (error) {
      notice(`Could not fix ${stuck.name}: ${error.message}`, 'bad');
    }
  }
}

async function connect() {
  const button = document.getElementById('connect');

  if (calculator) {
    await calculator.close();
    calculator = null;
    session = null;
    setStatus('Not connected');
    button.textContent = 'Connect calculator';
    refresh();
    return;
  }

  button.disabled = true;
  clearNotice();
  setStatus('Connecting…');

  try {
    calculator = await Calculator.request();
    await calculator.open();

    calculator.onBusy = () => notice(
      'The calculator is tidying its archive. It may be asking you to confirm '
      + 'that on its own screen. This can take a while.');

    const hello = await calculator.sayHello();
    session = new Session(calculator, store.getCatalog());

    setStatus(`BlueObject ${hello.version || '?'}`, 'connected');
    button.textContent = 'Disconnect';

    if (hello.hasIndex) {
      await session.load();
    } else if (!await offerToInitialise()) {
      /* Connected but unusable for installing. The Device panel still works,
       * and saying so is better than a Store whose buttons all fail. */
      notice('This calculator is not set up, so nothing can be installed to it.');
    }

    /* The clock is very often unset, and the index records when things were
     * installed. One command, and only written if it has really moved. */
    try { await calculator.setClock(); } catch { /* not fatal */ }

    refresh();
    showPanel('device');

    /*
     * A protocol mismatch is reported, never fatal. The update that would fix
     * an out-of-date calculator travels over this same link, so a page that
     * hung up here would be unable to fix exactly the calculators that need it.
     */
    if (hello.protocol !== 1) {
      notice(`This calculator speaks link protocol ${hello.protocol} and this `
        + 'page speaks 1. Some things may not work; updating BlueObject should '
        + 'fix it.');
    } else if (hello.swept) {
      notice('An interrupted install was cleaned up on this calculator. '
        + 'Nothing was left half-written.');
    }

    if (session.packages.length) await offerToRepair();
    refresh();
  } catch (error) {
    if (calculator) { await calculator.close(); calculator = null; }
    session = null;
    setStatus('Not connected', 'error');
    notice(describeConnectError(error), 'bad');
    refresh();
  } finally {
    button.disabled = false;
  }
}

/* --------------------------------------------------------------------- boot */

function start() {
  const hooks = {
    getSession: () => session,
    getCatalog: () => store.getCatalog(),
    onChanged: refresh,
  };
  device.init(hooks);
  updates.init(hooks);

  for (const button of document.querySelectorAll('#tabs button')) {
    button.addEventListener('click', () => showPanel(button.dataset.panel));
  }
  document.getElementById('connect').addEventListener('click', connect);

  const wanted = location.hash.slice(1);
  showPanel(PANELS.includes(wanted) ? wanted : 'store');

  document.getElementById('panel-settings').replaceChildren(
    el('p', 'placeholder', 'The sync password arrives in the next phase.'));

  if (location.protocol === 'file:') {
    notice('Opened from a file rather than a server, so the app catalogue '
      + 'cannot load. Run "python3 -m http.server" in this folder and open '
      + 'http://localhost:8000 instead.', 'bad');
    document.getElementById('connect').disabled = true;
    return;
  }

  if (!isSupported()) {
    notice('This browser has no Web Serial, so it cannot talk to a calculator. '
      + 'Use Chrome or Edge.', 'bad');
    document.getElementById('connect').disabled = true;
  }

  store.init(hooks).then(refresh);
}

start();
