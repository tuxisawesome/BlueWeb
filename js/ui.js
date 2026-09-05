/*
 * Dialogs, progress and notices.
 *
 * Nothing here knows what a calculator is. It exists so the panels can ask a
 * question and wait for the answer without each of them inventing a modal.
 */

import { formatLog, subscribeLog } from './log.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Ask a question with named answers. Resolves to the chosen action's id, or
 * null if the user backed out.
 *
 * `body` may be a string or a node. Actions are `{ id, label, kind }`, and the
 * first is focused -- so the safe choice goes first anywhere the wrong answer
 * would delete something.
 */
export function ask({ title, body, actions, dismissable = true }) {
  return new Promise((resolve) => {
    const backdrop = el('div', 'backdrop');
    const dialog = el('div', 'dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    dialog.append(el('h2', null, title));

    const content = el('div', 'dialog-body');
    if (typeof body === 'string') content.append(el('p', null, body));
    else if (body) content.append(body);
    dialog.append(content);

    const row = el('div', 'dialog-actions');
    const finish = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    for (const action of actions) {
      const button = el('button', action.kind || '', action.label);
      button.addEventListener('click', () => finish(action.id));
      row.append(button);
    }
    dialog.append(row);

    function onKey(event) {
      if (event.key === 'Escape' && dismissable) finish(null);
    }
    document.addEventListener('keydown', onKey);

    if (dismissable) {
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) finish(null);
      });
    }

    backdrop.append(dialog);
    document.body.append(backdrop);
    row.querySelector('button')?.focus();
  });
}

/**
 * A modal that cannot be dismissed, for work in flight.
 *
 * One bar for the whole job, a line naming the step inside it, and a line for
 * the speed. The bar only ever goes forward: a per-file bar that finished forty
 * times during one install never answered the question being asked of it.
 */
export function progress(title) {
  const backdrop = el('div', 'backdrop');
  const dialog = el('div', 'dialog');
  dialog.append(el('h2', null, title));

  const label = el('p', 'progress-label', 'Starting…');
  const track = el('div', 'progress-track');
  const bar = el('div', 'progress-bar');
  track.append(bar);

  const detail = el('p', 'progress-detail');
  const rate = el('p', 'progress-rate');
  dialog.append(label, track, detail, rate);

  backdrop.append(dialog);
  document.body.append(backdrop);

  return {
    say(text) { label.textContent = text; },
    fraction(value) {
      /*
       * Indeterminate until there is something real to show. A bar that sits at
       * zero looks stuck, and most of the wait here is a flash write with no
       * progress to report.
       */
      bar.style.width = value === null ? '100%' : `${Math.round(value * 100)}%`;
      bar.classList.toggle('indeterminate', value === null);
    },
    /** The step inside the job, and where it is up to. */
    detail(text) { detail.textContent = text || ''; },
    /*
     * Speed and time remaining. Both are omitted rather than zeroed when there
     * is not enough signal yet -- `0.0 KB/s` beside a bar that is visibly moving
     * reads as a bug in the page.
     */
    rate(text) { rate.textContent = text || ''; },
    /** Hang the Advanced log off the bottom of the dialog. */
    attach(node) { dialog.append(node); },
    /*
     * Let the dialog stay up after a failure, with a way out. The log is the
     * reason: closing it at the moment something went wrong throws away the
     * only record of what was happening.
     */
    fail(text, onClose) {
      label.textContent = text;
      label.classList.add('bad');
      bar.classList.remove('indeterminate');
      rate.textContent = '';

      const actions = el('div', 'dialog-actions');
      const button = el('button', null, 'Close');
      button.addEventListener('click', () => { backdrop.remove(); onClose?.(); });
      actions.append(button);
      dialog.append(actions);
      button.focus();
    },
    close() { backdrop.remove(); },
  };
}

let noticeTimer = null;

export function notice(text, level = 'info') {
  const node = document.getElementById('notice');
  node.textContent = text;
  node.className = level === 'bad' ? 'bad' : level === 'action' ? 'action' : '';
  node.hidden = false;

  clearTimeout(noticeTimer);
  /* An "action" notice tells the user to go and do something on the calculator,
   * so it stays until they dismiss it. */
  if (level !== 'action' && level !== 'bad') {
    noticeTimer = setTimeout(() => { node.hidden = true; }, 6000);
  }
}

export function clearNotice() {
  clearTimeout(noticeTimer);
  document.getElementById('notice').hidden = true;
}

/**
 * Show one `message` action, at the point in the list where it stands.
 *
 * Resolves true to carry on and false to stop, which is what the runner turns
 * into a cancelled install.
 *
 * `stop` is whether this one may be called off -- the manifest's own answer,
 * defaulted by the runner to "yes if there is anything left to stop". A message
 * warning that an install is about to erase every flash application on the
 * calculator has to be declinable, or the person is being told rather than
 * asked; one that would leave a package half-written is better acknowledged
 * than abandoned, and a package can say so.
 *
 * `remaining` decides only what an unstoppable message looks like: work still
 * to come makes it something to read before carrying on, and nothing left makes
 * it a parting instruction. An "action" message gets a dialog either way,
 * because it sends the user off to the calculator; anything else at the end is
 * a toast.
 */
export async function showMessage({
  text, level = 'info', remaining = 0, stop = false,
}) {
  if (!stop) {
    if (!remaining && level !== 'action') {
      notice(text);
      return true;
    }
    await ask({
      title: remaining ? 'Before this goes on' : 'One more step',
      body: text,
      actions: [{
        id: 'ok', label: remaining ? 'Continue' : 'Got it', kind: 'primary',
      }],
      /* No way out of this one: not being able to stop is the point of it. */
      dismissable: false,
    });
    return true;
  }

  /*
   * Continue goes first because it is focused, and it is the safe answer here:
   * stopping part-way through leaves the calculator mid-install. Backing out
   * with escape or the backdrop counts as stopping -- the cautious reading of
   * someone dismissing a warning they were asked to agree to.
   */
  const answer = await ask({
    title: 'Before this goes on',
    body: text,
    actions: [
      { id: 'go', label: 'Continue', kind: 'primary' },
      { id: 'stop', label: 'Stop' },
    ],
  });
  return answer === 'go';
}

/**
 * The Advanced disclosure: everything that crossed the cable, and a button that
 * puts it on the clipboard.
 *
 * Native `<details>`, so it needs no script to open and closes by default --
 * this is for the session that went wrong, and it should cost nothing to the
 * far more common one that did not. Returns `{ node, stop }`; call `stop` when
 * the thing holding it goes away, or it keeps redrawing into a detached tree.
 */
export function advancedLog() {
  const box = el('details', 'advanced');
  const summary = el('summary', null, 'Advanced');
  const copy = el('button', 'advanced-copy', 'Copy');
  const body = el('pre', 'advanced-log');

  summary.append(copy);
  box.append(summary, body);

  copy.addEventListener('click', async (event) => {
    /* Inside a <summary>, so without this the click also toggles the box. */
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(formatLog());
      copy.textContent = 'Copied';
    } catch {
      /* Clipboard permission can be refused, and the log is still readable
       * on screen -- say so rather than failing silently. */
      copy.textContent = 'Select and copy';
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  });

  const draw = () => {
    body.textContent = formatLog() || 'Nothing yet.';
    /* Follow the tail while it is open, which is what a live log is for. */
    if (box.open) body.scrollTop = body.scrollHeight;
  };

  draw();
  const stop = subscribeLog(draw);
  return { node: box, stop };
}

export { el };
