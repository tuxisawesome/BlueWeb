/*
 * Dialogs, progress and notices.
 *
 * Nothing here knows what a calculator is. It exists so the panels can ask a
 * question and wait for the answer without each of them inventing a modal.
 */

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

/** A modal that cannot be dismissed, for work in flight. */
export function progress(title) {
  const backdrop = el('div', 'backdrop');
  const dialog = el('div', 'dialog');
  dialog.append(el('h2', null, title));

  const label = el('p', 'progress-label', 'Starting…');
  const track = el('div', 'progress-track');
  const bar = el('div', 'progress-bar');
  track.append(bar);
  dialog.append(label, track);

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
 * Show whatever a package's action list had to say.
 *
 * An "action" message is one telling the user to go and run something on the
 * calculator, so it gets a dialog rather than a toast that slides away while
 * they are looking at the calculator.
 */
export async function showMessages(messages) {
  const urgent = messages.filter((m) => m.level === 'action');
  const rest = messages.filter((m) => m.level !== 'action');

  for (const message of urgent) {
    await ask({
      title: 'One more step',
      body: message.text,
      actions: [{ id: 'ok', label: 'Got it', kind: 'primary' }],
      dismissable: false,
    });
  }

  if (rest.length) notice(rest.map((m) => m.text).join(' '));
}

export { el };
