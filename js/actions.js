/*
 * What installing, updating and uninstalling a package actually does.
 *
 * A manifest declares an ordered list of actions rather than a list of files.
 * There are three verbs and no more:
 *
 *   upload   put a file from the package directory onto the calculator
 *   remove   delete a variable from the calculator
 *   message  say something to the person doing this
 *
 * A package declares `install` and nothing else unless it needs to. `update`
 * and `uninstall` are derived from it, so an ordinary app names each of its
 * files exactly once.
 *
 * The one derivation worth reading twice is `uninstall`: it is built from what
 * the *index* records the package as owning, not from the manifest. An app
 * installed by an older version whose file list has since changed still
 * uninstalls completely, because the calculator is the authority on what is
 * actually on it.
 */

import { TYPE_BY_NAME, TYPE_NAMES } from './tifile.js';

export const VERBS = ['upload', 'remove', 'message'];

export class ActionError extends Error {}

function checkUpload(action, where) {
  if (typeof action.file !== 'string' || !action.file) {
    throw new ActionError(`${where}: an "upload" needs a "file"`);
  }
  if (action.file.includes('..') || action.file.startsWith('/')) {
    throw new ActionError(`${where}: "${action.file}" is not a valid file name`);
  }
}

function checkRemove(action, where) {
  if (typeof action.name !== 'string' || !action.name) {
    throw new ActionError(`${where}: a "remove" needs a "name"`);
  }
  /* Mixed case after the first letter: see isValidName in tifile.js. */
  if (!/^[A-Z][A-Za-z0-9]{0,7}$/.test(action.name)) {
    throw new ActionError(
      `${where}: "${action.name}" is not a name the calculator will accept`);
  }
  if (action.type !== undefined && !(action.type in TYPE_BY_NAME)) {
    throw new ActionError(
      `${where}: "${action.type}" is not a variable type `
      + `(try ${Object.keys(TYPE_BY_NAME).join(', ')})`);
  }
}

function checkMessage(action, where) {
  if (typeof action.text !== 'string' || !action.text.trim()) {
    throw new ActionError(`${where}: a "message" needs some "text"`);
  }
  if (action.when !== undefined && !['pre', 'post'].includes(action.when)) {
    throw new ActionError(`${where}: "when" is "pre" or "post", not "${action.when}"`);
  }
  if (action.level !== undefined && !['info', 'action'].includes(action.level)) {
    throw new ActionError(
      `${where}: "level" is "info" or "action", not "${action.level}"`);
  }
}

/** Check one action list, throwing with the offending entry named. */
export function validateActions(list, where) {
  if (!Array.isArray(list)) throw new ActionError(`${where} is not a list`);

  list.forEach((action, i) => {
    const at = `${where}[${i}]`;
    if (!VERBS.includes(action.do)) {
      throw new ActionError(
        `${at}: "${action.do}" is not one of ${VERBS.join(', ')}`);
    }
    if (action.do === 'upload') checkUpload(action, at);
    if (action.do === 'remove') checkRemove(action, at);
    if (action.do === 'message') checkMessage(action, at);
  });

  return list;
}

export function installActions(manifest) {
  const list = manifest.actions?.install;
  if (!Array.isArray(list) || !list.length) {
    throw new ActionError(
      `${manifest.id}: a package needs an "actions.install" list`);
  }
  return validateActions(list, `${manifest.id} actions.install`);
}

/**
 * Updating defaults to installing again -- re-upload everything, overwriting in
 * place. A package overrides it to keep a save file across an upgrade, or to
 * clear one whose format has changed.
 */
export function updateActions(manifest) {
  const list = manifest.actions?.update;
  if (list) return validateActions(list, `${manifest.id} actions.update`);
  return installActions(manifest);
}

/**
 * Uninstalling defaults to removing what the index says the package owns.
 *
 * `installedPackage` is the row out of BLUEIDX. Deriving from it rather than
 * from the manifest is what makes an app installed by an older version -- whose
 * file list has since changed -- still uninstall completely.
 */
export function uninstallActions(manifest, installedPackage) {
  const list = manifest?.actions?.uninstall;
  if (list) return validateActions(list, `${manifest.id} actions.uninstall`);

  if (!installedPackage) {
    throw new ActionError(
      'nothing to uninstall: no manifest list and no record on the calculator');
  }

  return installedPackage.files.map((file) => ({
    do: 'remove',
    name: file.name,
    type: TYPE_NAMES[file.type],
  }));
}

/** The messages for one phase, in declaration order. */
export function messagesFor(list, when) {
  return list
    .filter((a) => a.do === 'message' && (a.when || 'post') === when)
    .map((a) => ({ text: a.text, level: a.level || 'info' }));
}

/** Just the work, with the talking taken out. */
export function effectsOf(list) {
  return list.filter((a) => a.do !== 'message');
}
