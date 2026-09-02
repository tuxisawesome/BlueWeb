/*
 * BlueWeb: the page half of an app store for the TI-84 Plus CE.
 *
 * No build step and no dependencies -- plain ES modules, served as files. It
 * needs a real origin though: fetch() of a relative path fails from file://, so
 * a double-clicked index.html would show an empty catalogue and no reason why.
 * That case is detected below and explained rather than left to look broken.
 */

import { Calculator, isSupported } from './link.js';
import * as device from './panels/device.js';

let calculator = null;

/* ------------------------------------------------------------------- chrome */

function notice(text, bad = false) {
  const el = document.getElementById('notice');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  el.hidden = false;
}

function clearNotice() {
  document.getElementById('notice').hidden = true;
}

function setStatus(text, state = '') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = `status ${state}`;
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

/* --------------------------------------------------------------- connecting */

/*
 * Turn a Web Serial failure into something actionable.
 *
 * These arrive as bare DOMExceptions whose messages say nothing about
 * calculators, and the commonest one on Linux is a permissions problem with a
 * fix the user would never guess.
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

async function connect() {
  const button = document.getElementById('connect');

  if (calculator) {
    await calculator.close();
    calculator = null;
    device.render(null);
    setStatus('Not connected');
    button.textContent = 'Connect calculator';
    return;
  }

  button.disabled = true;
  clearNotice();
  setStatus('Connecting...');

  try {
    calculator = await Calculator.request();
    await calculator.open();

    calculator.onBusy = () => notice(
      'The calculator is tidying its archive. It may be asking you to confirm '
      + 'that on its own screen. This can take a while.');

    const hello = await calculator.sayHello();
    device.render(hello);

    setStatus(`BlueObject ${hello.version || '?'}`, 'connected');
    button.textContent = 'Disconnect';
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
  } catch (error) {
    if (calculator) { await calculator.close(); calculator = null; }
    device.render(null);
    setStatus('Not connected', 'error');
    notice(describeConnectError(error), true);
  } finally {
    button.disabled = false;
  }
}

/* --------------------------------------------------------------------- boot */

function start() {
  for (const button of document.querySelectorAll('#tabs button')) {
    button.addEventListener('click', () => showPanel(button.dataset.panel));
  }
  document.getElementById('connect').addEventListener('click', connect);

  const wanted = location.hash.slice(1);
  showPanel(['store', 'updates', 'device', 'settings'].includes(wanted)
    ? wanted : 'store');

  if (location.protocol === 'file:') {
    notice('Opened from a file rather than a server, so the app catalogue '
      + 'cannot load. Run "python3 -m http.server" in this folder and open '
      + 'http://localhost:8000 instead.', true);
    document.getElementById('connect').disabled = true;
    return;
  }

  if (!isSupported()) {
    notice('This browser has no Web Serial, so it cannot talk to a calculator. '
      + 'Use Chrome or Edge.', true);
    document.getElementById('connect').disabled = true;
  }
}

start();
