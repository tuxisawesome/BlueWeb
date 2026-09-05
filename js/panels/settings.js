/*
 * Settings: the build channel, the sync password, the clock and backups.
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

import { ask, notice, progress, el } from '../ui.js';
import { CHANNELS, getChannel, setChannel, channelName } from '../channel.js';
import { isAvailable } from '../sha256.js';
import { encrypt, decrypt } from '../crypt.js';
import { buildBackup, parseBackup, backupSize } from '../backup.js';
import { isSystemVariable, deleteVariables } from '../install.js';
import { parseIndex } from '../blueidx.js';

let getCalculator = null;
let getSession = null;
let onChanged = null;
let onChannelChanged = null;
let exclusive = null;  /* run an operation with the calculator held */
let isBusy = null;

const KB = 1024;
const kb = (bytes) => `${(bytes / KB).toFixed(bytes < 10 * KB ? 1 : 0)} KB`;

function passwordForm({ confirm, needsCurrent, labels = {} }) {
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

  const current = needsCurrent
    ? add(labels.current || 'Current password', 'current') : null;
  const next = confirm ? add(labels.next || 'New password', 'next') : null;
  const again = confirm
    ? add(labels.again || 'New password again', 'again') : null;

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

/* --------------------------------------------------------- backup files */

/*
 * Hand the finished file to the browser.
 *
 * The object URL is revoked on a timer rather than straight after the click:
 * revoking it synchronously can beat the download to it, and the failure is a
 * silently empty file rather than an error anybody would see.
 */
function save(bytes, filename) {
  const url = URL.createObjectURL(
    new Blob([bytes], { type: 'application/octet-stream' }));
  const link = el('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Ask for a file. Resolves null if the picker was dismissed. */
function pick() {
  return new Promise((resolve) => {
    const input = el('input');
    input.type = 'file';
    input.accept = '.bluebak';
    input.hidden = true;
    const finish = (file) => { input.remove(); resolve(file); };
    input.addEventListener('change', () => finish(input.files?.[0] || null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/**
 * The key for a backup file.
 *
 * Where the calculator has a sync password, that is the key, and a backup
 * verifies it against the calculator before writing anything -- a typo would
 * otherwise produce a file nobody on earth can open, and it would not be
 * discovered until the day it was needed.
 *
 * A restore does not verify: the file may have been made on another calculator,
 * or before this one's password was changed, and the file's key is whatever it
 * was made with. The only thing that can judge it is the decryption.
 *
 * Where there is no sync password, the key is a passphrase for the file alone.
 * It is asked for twice when making one, for the same reason, and labelled so
 * that nobody believes they have just set something on the calculator.
 */
async function askForKey(calculator, { title, intro, making }) {
  const locked = !!calculator.hello?.password;

  const form = passwordForm({
    confirm: making && !locked,
    needsCurrent: !(making && !locked),
    labels: {
      current: locked ? 'The calculator’s password' : 'Passphrase for this file',
      next: 'Passphrase for this file',
      again: 'The same passphrase again',
    },
  });
  form.body.prepend(el('p', 'dim', intro));

  const answer = await ask({
    title,
    body: form.body,
    actions: [
      { id: 'go', label: making ? 'Back up' : 'Continue', kind: 'primary' },
      { id: null, label: 'Cancel' },
    ],
  });
  if (answer !== 'go') return null;

  const value = form.current ? form.current.value : form.next.value;
  if (!value) {
    notice('That cannot be empty.', 'bad');
    return null;
  }
  if (form.again && value !== form.again.value) {
    notice('Those two do not match.', 'bad');
    return null;
  }

  if (making && locked) {
    try {
      await calculator.authenticate(value);
    } catch (error) {
      notice(`Could not check that password: ${error.message}`, 'bad');
      return null;
    }
  }

  return value;
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

async function backUp(calculator) {
  const key = await askForKey(calculator, {
    title: 'Back up this calculator',
    making: true,
    intro: calculator.hello?.password
      ? 'The backup file is encrypted with this calculator’s password. You '
        + 'will need it to restore.'
      : 'This calculator has no sync password, so choose a passphrase for the '
        + 'file itself. Nothing is stored on the calculator, and there is no '
        + 'way to recover the file without it.',
  });
  if (key === null) return;

  const bar = progress('Backing up');
  try {
    bar.say('Looking at what is there');
    bar.fraction(null);

    /*
     * BLUE, BLUEUP and BLUETMP are left out. The first two come from the store
     * and the third is staging litter; the index travels through INDEX_GET
     * below, with its device block already zeroed by the calculator, so the
     * password hash is not in a backup and never has been.
     */
    const present = (await calculator.listVariables())
      .filter((variable) => !isSystemVariable(variable.name));

    const index = await calculator.getIndex();

    const variables = [];
    for (let at = 0; at < present.length; at++) {
      const variable = present[at];
      bar.say(`${variable.name} (${at + 1} of ${present.length})`);
      bar.fraction(at / present.length);
      variables.push({
        name: variable.name,
        type: variable.type,
        archived: variable.archived,
        body: await calculator.readVariable(variable.name, variable.type),
      });
    }

    bar.say('Encrypting');
    bar.fraction(null);
    const file = await encrypt(buildBackup({
      calcId: calculator.hello?.calcId,
      blueObject: calculator.hello?.version,
      index,
      variables,
    }), key);

    bar.close();
    save(file, `blueobject-${calculator.hello?.calcId || 'calculator'}-${stamp()}.bluebak`);
    notice(`Backed up ${variables.length} file${variables.length === 1 ? '' : 's'}, `
      + `${kb(backupSize(variables))}.`);
  } catch (error) {
    bar.close();
    notice(`Could not finish the backup: ${error.message}`, 'bad');
  }
}

/*
 * Everything that could stop a restore, checked before a byte is deleted.
 *
 * The order matters more here than anywhere else in this page. A restore erases
 * the calculator first, so a failure discovered half way through costs the user
 * what they already had as well as what they were restoring. Anything knowable
 * in advance has to be known in advance.
 */
function whyNot(calculator, backup, freed) {
  const limit = calculator.hello?.maxVarBytes;
  const tooBig = backup.variables.filter((v) => limit && v.body.length > limit);
  if (tooBig.length) {
    return `${tooBig[0].name} holds ${tooBig[0].body.length} bytes and this `
      + `calculator can only build ${limit} at once. A variable has to fit in `
      + `RAM before it can be archived, so this backup cannot go on here.`;
  }

  /*
   * The archive figure is a floor -- deleted variables do not hand their space
   * back until the OS collects -- so this only catches what is plainly
   * impossible, and lets the marginal case try.
   */
  const room = (calculator.hello?.freeArchive || 0) + freed;
  const needed = backupSize(backup.variables);
  if (needed > room) {
    return `this backup needs ${kb(needed)} and this calculator will have `
      + `about ${kb(room)} once it is cleared.`;
  }

  return null;
}

async function restore(calculator) {
  const session = getSession?.();
  if (!session) {
    notice('This calculator is not set up, so nothing can be restored to it.', 'bad');
    return;
  }

  const file = await pick();
  if (!file) return;

  const key = await askForKey(calculator, {
    title: 'Restore from a backup',
    making: false,
    intro: 'The password or passphrase this backup was made with — which is '
      + 'not necessarily this calculator’s.',
  });
  if (key === null) return;

  let backup;
  try {
    backup = parseBackup(await decrypt(await file.arrayBuffer(), key));
  } catch (error) {
    notice(`Could not open that backup: ${error.message}`, 'bad');
    return;
  }

  let present;
  try {
    present = (await calculator.listVariables())
      .filter((variable) => !isSystemVariable(variable.name));
  } catch (error) {
    notice(`Could not read what is on the calculator: ${error.message}`, 'bad');
    return;
  }

  const freed = present.reduce((sum, variable) => sum + variable.bytes, 0);
  const refusal = whyNot(calculator, backup, freed);
  if (refusal) {
    notice(`This backup cannot be restored here: ${refusal}`, 'bad');
    return;
  }

  const body = el('div');
  body.append(el('p', null,
    `Everything on this calculator will be deleted first — ${present.length} `
    + `file${present.length === 1 ? '' : 's'}, ${kb(freed)} — and then the `
    + `${backup.variables.length} in this backup written in their place.`));
  body.append(el('p', 'dim',
    `The backup was made on ${(backup.manifest.created || '').slice(0, 10)}`
    + `${backup.manifest.calcId === calculator.hello?.calcId
      ? ', on this calculator.' : ', on a different calculator.'}`));
  body.append(el('p', 'dim',
    'BlueObject itself, its updater and its index are not touched — they are '
    + 'what is doing the restoring. This calculator keeps its own sync '
    + 'password.'));

  const answer = await ask({
    title: 'Erase this calculator and restore?',
    body,
    actions: [
      { id: null, label: 'Cancel' },
      { id: 'go', label: 'Erase and restore', kind: 'danger' },
    ],
  });
  if (answer !== 'go') return;

  /*
   * Which package each file belonged to, so the restored index and the restored
   * files agree about ownership. A backup whose index will not parse still has
   * its files, and unowned files are strays -- recoverable, and much better
   * than refusing to restore anything.
   */
  const owners = new Map();
  try {
    for (const pkg of parseIndex(backup.index).packages) {
      for (const item of pkg.files) owners.set(item.name, pkg.id);
    }
  } catch { /* the files matter more than the bookkeeping */ }

  const bar = progress('Restoring');
  try {
    bar.say('Clearing the calculator');
    bar.fraction(0);
    const cleared = await deleteVariables(calculator, present,
      ({ variable, done, total }) => {
        if (variable) bar.say(`Clearing ${variable.name}`);
        bar.fraction((done / total) * 0.2);
      });

    /*
     * The index before the files, which is the rule the install path already
     * follows: the claim is written first, so a restore cut off part way leaves
     * an index describing where the calculator was heading and the Device
     * panel's "Recorded but not there" names exactly what is still missing.
     *
     * The calculator splices its own live device block over whatever arrives,
     * so this calculator keeps its password and its failure count. That is what
     * makes restoring onto a replacement calculator work.
     */
    if (backup.index.length) {
      bar.say('Restoring the record of what is installed');
      bar.fraction(0.2);
      await calculator.putIndex(backup.index);
    }

    for (let at = 0; at < backup.variables.length; at++) {
      const variable = backup.variables[at];
      bar.say(`${variable.name} (${at + 1} of ${backup.variables.length})`);
      bar.fraction(0.25 + (at / backup.variables.length) * 0.75);
      await calculator.putVariable({
        name: variable.name,
        type: variable.type,
        body: variable.body,
        archive: variable.archived,
        owner: owners.get(variable.name) || '',
      });
    }

    await session.load();
    bar.close();

    if (cleared.failed.length) {
      notice(`Restored ${backup.variables.length} files. `
        + `${cleared.failed.map((f) => f.variable.name).join(', ')} could not be `
        + `cleared first and may still be there.`, 'bad');
    } else {
      notice(`Restored ${backup.variables.length} `
        + `file${backup.variables.length === 1 ? '' : 's'}.`);
    }
  } catch (error) {
    bar.close();
    /*
     * The calculator is now part way between two states, and saying so is the
     * useful thing: the index names what should be there, so the Device panel
     * will list what is missing and running the same restore again finishes it.
     */
    notice(`The restore stopped part way: ${error.message}. The calculator is `
      + `not as it was — run the restore again to finish it.`, 'bad');
  }

  onChanged?.();
}

/*
 * The calculator's clock.
 *
 * This used to be sent on every connect, quietly. It looks like one harmless
 * command, but the calculator stores the offset in the index -- so a drift of
 * more than a minute unarchives the index, rewrites it and archives it again,
 * which is a flash write that can trigger a garbage collect. That is a lot to
 * happen to somebody's calculator because they plugged it in.
 *
 * So it is a button. The drift is shown, because "your clock is wrong" is only
 * worth acting on if you can see by how much.
 */
function clockSection(calculator) {
  const wrap = el('div');
  wrap.append(el('h2', 'category', 'Clock'));

  const stored = calculator.hello?.calcUnixTime ?? 0;
  const drift = stored ? Math.abs(Math.floor(Date.now() / 1000) - stored) : null;

  wrap.append(el('p', null, !stored
    ? 'This calculator’s clock has never been set. The index records when '
      + 'things were installed, so those dates will be wrong until it is.'
    : drift < 60
      ? 'This calculator’s clock agrees with this computer.'
      : `This calculator’s clock is ${describeDrift(drift)} out. The index `
        + 'records when things were installed, so that is what this affects.'));

  const actions = el('div', 'app-actions');
  const button = el('button', stored && drift < 60 ? '' : 'primary',
    'Set the calculator’s clock');
  button.disabled = isBusy();
  button.addEventListener('click', () => exclusive('Setting the clock', async () => {
    try {
      await calculator.setClock();
      /* HELLO is where the stored offset came from, and it is now stale. */
      if (calculator.hello) {
        calculator.hello.calcUnixTime = Math.floor(Date.now() / 1000);
      }
      notice('Clock set.');
    } catch (error) {
      notice(`Could not set the clock: ${error.message}`, 'bad');
    }
  }));
  actions.append(button);
  wrap.append(actions);

  wrap.append(el('p', 'dim',
    'Setting it rewrites the index, which takes a moment and, on a full '
    + 'archive, may make the calculator ask to defragment.'));

  return wrap;
}

function describeDrift(seconds) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

/* ------------------------------------------------------------- the channel */

/*
 * Which build of BlueObject this page installs.
 *
 * This is a setting of the page rather than of the calculator, so unlike
 * everything else on this panel it is drawn whether or not one is connected --
 * and it has to be, because the commonest reason to come here is to switch
 * channel *before* plugging anything in.
 */
function channelSection() {
  const section = el('div');
  section.append(el('h2', 'category', 'Builds'));
  section.append(el('p', null,
    'BlueObject is the program on the calculator that does the installing, so a '
    + 'new one is worth trying before everybody gets it. This chooses which '
    + 'build this page offers.'));

  const chosen = getChannel();
  const list = el('div', 'field-group');

  for (const channel of CHANNELS) {
    const row = el('label', 'choice');

    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'channel';
    radio.value = channel.id;
    radio.checked = channel.id === chosen;
    radio.disabled = isBusy();
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      if (!setChannel(channel.id)) {
        notice('This browser will not let the page remember that, so it will '
          + 'go back to Release when you reload.', 'warn');
      }
      onChannelChanged();
    });

    const text = el('span');
    text.append(el('strong', null, channel.name));
    text.append(el('span', 'dim', ` — ${channel.summary}`));

    row.append(radio, text);
    list.append(row);
  }
  section.append(list);

  if (chosen !== 'release') {
    /*
     * Said plainly, because the consequence is not obvious and is not
     * reversible from this page. A development build that will not start takes
     * the store down with it -- BlueObject is what installs things, including
     * the BlueObject that would replace it.
     */
    section.append(el('p', 'warn',
      `You are on ${channelName(chosen)}. If a build here does not start, this `
      + 'page cannot reach the calculator to fix it — you would send a working '
      + 'BLUE.8xp back with TI Connect CE and a cable.'));
  }

  section.append(el('p', 'dim',
    'Changing this does not touch the calculator. It changes what the Store '
    + 'installs and what the Updates panel offers from now on; anything already '
    + 'installed stays where it is until you update it.'));

  return section;
}

export function render() {
  const panel = document.getElementById('panel-settings');
  const calculator = getCalculator();

  if (!calculator) {
    panel.replaceChildren(
      channelSection(),
      el('p', 'placeholder', 'Connect a calculator to change its settings.'));
    return;
  }

  const wrap = el('div');
  wrap.append(channelSection());
  wrap.append(el('h2', 'category', 'Sync password'));

  if (!isAvailable()) {
    wrap.append(el('p', 'bad',
      'This page is not running in a secure context, so it cannot hash a '
      + 'password. Open it over https, or as http://localhost.'));
    /* Only the password needs crypto. The clock does not, and a calculator
     * whose dates are wrong should still be fixable here. */
    wrap.append(clockSection(calculator));
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
  primary.disabled = isBusy();
  primary.addEventListener('click', () =>
    exclusive('Changing the password', () => setPassword(calculator, has)));
  actions.append(primary);

  if (has) {
    const clear = el('button', 'danger', 'Remove password');
    clear.disabled = isBusy();
    clear.addEventListener('click', () =>
      exclusive('Removing the password', () => clearPassword(calculator)));
    actions.append(clear);
  }
  wrap.append(actions);

  /* --------------------------------------------------------------- clock */

  wrap.append(clockSection(calculator));

  /* -------------------------------------------------------------- backup */

  wrap.append(el('h2', 'category', 'Backup'));
  wrap.append(el('p', null,
    'A backup holds every program and appvar on this calculator, and the '
    + 'record of which app each one belongs to, in one encrypted file.'));

  const backup = el('div', 'app-actions');
  const make = el('button', 'primary', 'Back up…');
  make.disabled = isBusy();
  make.addEventListener('click', () =>
    exclusive('Backing up', () => backUp(calculator)));
  backup.append(make);

  const put = el('button', 'danger', 'Restore…');
  put.disabled = isBusy();
  put.addEventListener('click', () =>
    exclusive('Restoring', () => restore(calculator)));
  backup.append(put);
  wrap.append(backup);

  wrap.append(el('p', 'dim',
    'Restoring erases the calculator first, then writes what the backup holds. '
    + 'BlueObject, its updater and its index are left alone — they are what '
    + 'does the restoring — and this calculator keeps its own sync password, '
    + 'whichever calculator the backup came from.'));

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
  explain.append(el('p', 'dim',
    'A backup file is the other way round: it is the calculator’s contents '
    + 'sitting on a disk, where nobody is holding it and nothing counts wrong '
    + 'guesses. So the file is encrypted, and the password is the key rather '
    + 'than the digest the calculator stores — and if you lose it, the backup '
    + 'is gone. There is no copy of it anywhere.'));
  wrap.append(explain);

  panel.replaceChildren(wrap);
}

export function init(hooks) {
  getCalculator = hooks.getCalculator;
  getSession = hooks.getSession;
  onChanged = hooks.onChanged;
  onChannelChanged = hooks.onChannelChanged;
  exclusive = hooks.exclusive;
  isBusy = hooks.isBusy;
}
