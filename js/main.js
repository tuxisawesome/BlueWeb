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
import { startLog, logEvent } from './log.js';
import { createLock, BusyError } from './lock.js';

import * as store from './panels/store.js';
import * as device from './panels/device.js';
import * as updates from './panels/updates.js';
import * as settings from './panels/settings.js';

let calculator = null;
let session = null;

/*
 * Everything that touches the calculator goes through this, and only one thing
 * holds it at a time. See lock.js for why a refusal beats a queue.
 *
 * It is deliberately the whole flow that is held, not each command: an install
 * is a VAR_BEGIN, forty chunks and a VAR_END, and letting a removal slip in
 * between two of them is the bug this closes, not a lesser version of it.
 */
const link = createLock({ onChange: () => refresh() });

/**
 * Run an operation with the calculator held, and say so if something else has
 * it rather than letting the click do nothing.
 *
 * Panels use this for anything that installs, removes or writes the index.
 */
async function exclusive(label, fn) {
  try {
    return await link.run(label, fn);
  } catch (error) {
    if (error instanceof BusyError) {
      notice(error.message, 'bad');
      return undefined;
    }
    throw error;
  }
}

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
  settings.render();
  store.render();
}

/*
 * Re-read what the calculator is actually holding, then redraw.
 *
 * Separate from refresh() because it costs a round trip or several: it is worth
 * doing after something changes, and not on every redraw.
 */
async function rescan() {
  await device.scan(calculator);
  refresh();
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
 * Ask for the password, and keep asking until it is right or the user gives up.
 *
 * The calculator counts wrong answers and keeps the count across power cycles.
 * It cannot rate-limit anybody -- pulling the batteries would defeat that -- so
 * what it does instead is tell whoever does get in how many there have been,
 * which is the useful thing a calculator can actually offer.
 */
async function askForPassword(hello) {
  for (;;) {
    const field = el('input');
    field.type = 'password';
    field.autocomplete = 'off';

    const body = el('div');
    body.append(el('p', null, 'This calculator asks for a password before it '
      + 'will let anything be changed.'));
    const wrap = el('div', 'field');
    wrap.append(el('label', null, 'Password'), field);
    body.append(wrap);

    const answer = await ask({
      title: 'Password',
      body,
      actions: [
        { id: 'go', label: 'Unlock', kind: 'primary' },
        { id: null, label: 'Cancel' },
      ],
    });
    if (answer !== 'go') return false;

    try {
      const failures = await calculator.authenticate(field.value);
      if (failures) {
        notice(`Unlocked. There have been ${failures} wrong `
          + `password${failures === 1 ? '' : 's'} since the last time someone `
          + `got in.`, 'action');
      }
      hello.authFailures = 0;
      return true;
    } catch (error) {
      notice(error.message, 'bad');
    }
  }
}

async function connect() {
  const button = document.getElementById('connect');

  if (link.isBusy()) {
    notice(`${link.label()} is still going. Wait for it to finish.`, 'bad');
    return;
  }

  if (calculator) {
    await calculator.close();
    calculator = null;
    session = null;
    logEvent('\u00b7', 'disconnected');
    setStatus('Not connected');
    button.textContent = 'Connect calculator';
    refresh();
    return;
  }

  button.disabled = true;
  clearNotice();
  setStatus('Connecting…');

  /*
   * Held for the whole of connecting, not just the port opening.
   *
   * refresh() runs part way through so the calculator appears as soon as it is
   * known, and every panel it draws is disabled until this releases. Without
   * that, the Store is live and clickable while the index has not been read
   * yet, and an install started there races the rest of connecting.
   */
  await exclusive('Connecting', async () => {
    try {
      calculator = await Calculator.request();

      /*
       * Recording starts before the port is open, so a session that fails at
       * HELLO still leaves something to read. The clock runs from here.
       */
      startLog();
      calculator.onLog = logEvent;

      await calculator.open();
      logEvent('\u00b7', 'port open');

      calculator.onBusy = () => notice(
        'The calculator is tidying its archive. It may be asking you to confirm '
        + 'that on its own screen. This can take a while.');

      const hello = await calculator.sayHello();
      session = new Session(calculator, store.getCatalog());

      setStatus(`BlueObject ${hello.version || '?'}`, 'connected');
      button.textContent = 'Disconnect';

      /*
       * Before anything else that would be refused. HELLO is deliberately not
       * gated, so the page can find out a password is wanted rather than
       * sitting there until every later command times out.
       */
      if (hello.password && !await askForPassword(hello)) {
        notice('Not unlocked, so nothing on this calculator can be changed.');
        refresh();
        return;
      }

      if (hello.hasIndex) {
        await session.load();
      } else {
        /*
         * Connected but unusable for installing. Setting one up writes to the
         * archive, so it waits to be asked for on the Device panel rather than
         * opening a dialog over a page the user has only just connected.
         */
        notice('This calculator is not set up, so nothing can be installed to '
          + 'it. The Device tab can set it up.');
      }

      refresh();
      showPanel('device');

      /*
       * A protocol mismatch is reported, never fatal. The update that would fix
       * an out-of-date calculator travels over this same link, so a page that
       * hung up here would be unable to fix exactly the calculators that need
       * it.
       */
      if (hello.protocol !== 1) {
        notice(`This calculator speaks link protocol ${hello.protocol} and `
          + 'this page speaks 1. Some things may not work; updating BlueObject '
          + 'should fix it.');
      } else if (hello.swept) {
        notice('An interrupted install was cleaned up on this calculator. '
          + 'Nothing was left half-written.');
      }

      /*
       * Read-only: what the calculator is actually holding. Anything that would
       * *change* it -- finishing an interrupted install, setting the clock,
       * writing a first index -- is left for the user to ask for on a panel.
       * Connecting a calculator is not consent to modify it.
       */
      await rescan();
    } catch (error) {
      if (calculator) { await calculator.close(); calculator = null; }
      session = null;
      setStatus('Not connected', 'error');
      notice(describeConnectError(error), 'bad');
      refresh();
    } finally {
      button.disabled = false;
    }
  });
}

/*
 * Pick up a new build channel.
 *
 * The catalogue is refetched rather than filtered, because the channel decides
 * which version of a package the index describes and every panel is drawn from
 * that. The session holds a reference to the catalogue, so it is pointed at the
 * new one before anything redraws -- otherwise the Store would offer one build
 * and an install would send another.
 */
async function reloadCatalog() {
  const loaded = await store.load();
  if (session && loaded) session.useCatalog(loaded);
  refresh();
}

/* --------------------------------------------------------------------- boot */

function start() {
  const hooks = {
    getSession: () => session,
    getCatalog: () => store.getCatalog(),
    getCalculator: () => calculator,
    onChanged: rescan,
    onChannelChanged: reloadCatalog,
    /* Redraw every panel without asking the calculator or the network
     * anything. Switching tabs does not re-render, so a setting changed on one
     * panel is not visible on another until something says so. */
    redraw: refresh,
    exclusive,
    isBusy: () => link.isBusy(),
    busyLabel: () => link.label(),
  };
  device.init(hooks);
  updates.init(hooks);
  settings.init(hooks);

  for (const button of document.querySelectorAll('#tabs button')) {
    button.addEventListener('click', () => showPanel(button.dataset.panel));
  }
  document.getElementById('connect').addEventListener('click', connect);

  const wanted = location.hash.slice(1);
  showPanel(PANELS.includes(wanted) ? wanted : 'store');

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
