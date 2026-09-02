/*
 * Settings: the sync password.
 *
 * Worth being plain about what it does. It does not protect what is stored on
 * the calculator -- anyone holding it can read its variables from the operating
 * system's own menus. It protects the *relationship* between the calculator and
 * a computer: without it, nothing can be installed, removed or updated.
 *
 * The way past it is to delete the index, and that costs the whole record of
 * what is installed and which variable belongs to what. That cost is the
 * deterrent, and the panel says so rather than implying more than it delivers.
 */

import { ask, notice, el } from '../ui.js';
import { isAvailable } from '../sha256.js';

let getCalculator = null;
let onChanged = null;

function passwordForm({ title, confirm, needsCurrent }) {
  const body = el('div');
  const fields = [];

  const add = (label, name) => {
    const wrap = el('div', 'field');
    wrap.append(el('label', null, label));
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.name = name;
    wrap.append(input);
    body.append(wrap);
    fields.push(input);
    return input;
  };

  const current = needsCurrent ? add('Current password', 'current') : null;
  const next = confirm ? add('New password', 'next') : null;
  const again = confirm ? add('New password again', 'again') : null;

  return { body, current, next, again, first: fields[0] };
}

async function setPassword(calculator, existing) {
  const form = passwordForm({
    confirm: true,
    needsCurrent: existing,
  });

  form.body.prepend(el('p', 'dim',
    'You will be asked for this whenever you connect this calculator.'));

  const answer = await ask({
    title: existing ? 'Change the sync password' : 'Set a sync password',
    body: form.body,
    actions: [
      { id: 'save', label: 'Save', kind: 'primary' },
      { id: null, label: 'Cancel' },
    ],
  });
  if (answer !== 'save') return;

  if (!form.next.value) {
    notice('A password cannot be empty.', 'bad');
    return;
  }
  if (form.next.value !== form.again.value) {
    notice('Those two do not match.', 'bad');
    return;
  }

  try {
    /*
     * Changing one needs the current password first, because the calculator
     * gates PW_SET behind a successful AUTH once a password exists.
     */
    if (existing) await calculator.authenticate(form.current.value);
    await calculator.setPassword(form.next.value);
    notice('Password set.');
    onChanged?.();
  } catch (error) {
    notice(`Could not set the password: ${error.message}`, 'bad');
  }
}

async function clearPassword(calculator) {
  const form = passwordForm({ confirm: false, needsCurrent: true });
  form.body.prepend(el('p', 'dim',
    'Anyone with this page and a cable will be able to change what is on the '
    + 'calculator.'));

  const answer = await ask({
    title: 'Remove the sync password?',
    body: form.body,
    actions: [
      { id: null, label: 'Cancel' },
      { id: 'clear', label: 'Remove it', kind: 'danger' },
    ],
  });
  if (answer !== 'clear') return;

  try {
    await calculator.authenticate(form.current.value);
    await calculator.setPassword(null);
    notice('Password removed.');
    onChanged?.();
  } catch (error) {
    notice(`Could not remove the password: ${error.message}`, 'bad');
  }
}

export function render() {
  const panel = document.getElementById('panel-settings');
  const calculator = getCalculator();

  if (!calculator) {
    panel.replaceChildren(
      el('p', 'placeholder', 'Connect a calculator to change its settings.'));
    return;
  }

  const wrap = el('div');
  wrap.append(el('h2', 'category', 'Sync password'));

  if (!isAvailable()) {
    wrap.append(el('p', 'bad',
      'This page is not running in a secure context, so it cannot hash a '
      + 'password. Open it over https, or as http://localhost.'));
    panel.replaceChildren(wrap);
    return;
  }

  const has = calculator.hello?.password;

  wrap.append(el('p', null, has
    ? 'This calculator asks for a password when you connect it.'
    : 'This calculator does not ask for a password.'));

  const failures = calculator.hello?.authFailures ?? 0;
  if (failures) {
    /*
     * Tamper evidence, not a rate limit -- the calculator cannot enforce one,
     * since pulling the batteries would defeat it. What it can do is count, and
     * tell whoever does get in.
     */
    wrap.append(el('p', 'warn',
      `${failures} wrong password${failures === 1 ? '' : 's'} since the last `
      + `time someone got in.`));
  }

  const actions = el('div', 'app-actions');
  const primary = el('button', 'primary', has ? 'Change password' : 'Set a password');
  primary.addEventListener('click', () => setPassword(calculator, has));
  actions.append(primary);

  if (has) {
    const clear = el('button', 'danger', 'Remove password');
    clear.addEventListener('click', () => clearPassword(calculator));
    actions.append(clear);
  }
  wrap.append(actions);

  const explain = el('div', 'explain');
  explain.append(el('h2', 'category', 'What this does'));
  explain.append(el('p', 'dim',
    'It does not protect what is stored on the calculator. Anyone holding it '
    + 'can read its files from the calculator’s own memory menu.'));
  explain.append(el('p', 'dim',
    'What it protects is this: without the password, nothing can install, '
    + 'remove or update anything. The way past it is to delete BlueObject’s '
    + 'index on the calculator — and that costs the whole record of what is '
    + 'installed and which files belong to which app, leaving a calculator full '
    + 'of files nothing can account for. That cost is the point.'));
  wrap.append(explain);

  panel.replaceChildren(wrap);
}

export function init(hooks) {
  getCalculator = hooks.getCalculator;
  onChanged = hooks.onChanged;
}
