/*
 * What installing, updating and uninstalling a package actually does.
 *
 * A manifest declares an ordered list of actions rather than a list of files.
 * There are three verbs and no more:
 *
 *   upload   put a file from the package directory onto the calculator
 *   remove   delete a variable from the calculator
 *   message  stop and say something to the person doing this
 *
 * The list is ordered and a message is an action like the other two: it runs
 * where it is written, and `stop` says whether the reader may call the whole
 * thing off there. A message before the first upload is a warning about
 * what is coming, one in the middle stops between two files, one at the end is
 * what to go and do now. The person reading it can say stop, and then nothing
 * after it runs.
 *
 * It used to be that messages were pulled out of the list, sorted into "pre"
 * and "post" and shown together once the work had finished -- which meant a
 * warning about what an install was going to do arrived after it had done it.
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
  /*
   * Required, not optional. There is no file to read the type out of here, and
   * defaulting to one would mean looking for an appvar of that name and quietly
   * finding nothing when the variable is a program.
   */
  if (!(action.type in TYPE_BY_NAME)) {
    throw new ActionError(
      `${where}: a "remove" needs a "type" `
      + `(one of ${Object.keys(TYPE_BY_NAME).join(', ')})`);
  }
}

function checkMessage(action, where, ordered) {
  if (typeof action.text !== 'string' || !action.text.trim()) {
    throw new ActionError(`${where}: a "message" needs some "text"`);
  }
  if (action.stop !== undefined && typeof action.stop !== 'boolean') {
    throw new ActionError(`${where}: "stop" is true or false`);
  }
  /*
   * "when" is refused where position already answers it, rather than accepted
   * and ignored. An author who writes `when: "pre"` at the end of an install
   * list means it to run first, and silently running it last is the whole bug
   * this rule exists to make impossible.
   */
  if (action.when !== undefined) {
    if (ordered) {
      throw new ActionError(
        `${where}: this list runs in order, so a "message" takes no "when" -- `
        + `move it to where it should happen`);
    }
    if (!['pre', 'post'].includes(action.when)) {
      throw new ActionError(`${where}: "when" is "pre" or "post", not "${action.when}"`);
    }
  }
  if (action.level !== undefined && !['info', 'action'].includes(action.level)) {
    throw new ActionError(
      `${where}: "level" is "info" or "action", not "${action.level}"`);
  }
}

/**
 * Check one action list, throwing with the offending entry named.
 *
 * `ordered` is true for a list that is run exactly as written -- install and
 * update. An uninstall list is not: what it removes comes from the index, and
 * the manifest's own entries are placed around that, so there "when" is the
 * only way to say which side.
 */
export function validateActions(list, where, { ordered = true } = {}) {
  if (!Array.isArray(list)) throw new ActionError(`${where} is not a list`);

  list.forEach((action, i) => {
    const at = `${where}[${i}]`;
    if (!VERBS.includes(action.do)) {
      throw new ActionError(
        `${at}: "${action.do}" is not one of ${VERBS.join(', ')}`);
    }
    if (action.do === 'upload') checkUpload(action, at);
    if (action.do === 'remove') checkRemove(action, at);
    if (action.do === 'message') checkMessage(action, at, ordered);
  });

  /*
   * "stop": true has to have something left to stop, or the button is a lie.
   * In an ordered list that means work written after it; in an uninstall list,
   * where the removals come from the index, it means the message is a "pre"
   * one -- a "post" message runs when there is nothing left by definition.
   */
  list.forEach((action, i) => {
    if (action.do !== 'message' || action.stop !== true) return;
    const canStop = ordered
      ? list.slice(i + 1).some((later) => later.do !== 'message')
      : action.when === 'pre';
    if (!canStop) {
      throw new ActionError(
        `${where}[${i}]: "stop" is true, but nothing runs after this message `
        + `for stopping to prevent`);
    }
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
 * Uninstalling removes what the index says the package owns -- always.
 *
 * `installedPackage` is the row out of BLUEIDX, and deriving from it rather
 * than from the manifest is what makes an app installed by an older version --
 * whose file list has since changed -- still uninstall completely.
 *
 * A manifest's `uninstall` list **adds** to that; it does not replace it. That
 * distinction is the whole of this function and it was originally the other way
 * round, which was a bug with no symptom at the time: every real manifest turned
 * out to want nothing more than a message, so declaring one silently replaced
 * every removal with nothing. The package vanished from the index and its files
 * stayed on the calculator, which is worse than either outcome on its own --
 * they were now files nothing could account for.
 *
 * So a manifest can say things and can remove *extra* things, but it cannot
 * quietly decline to clean up after itself. Anything that should survive an
 * uninstall -- saved games, settings -- is simply never recorded as owned,
 * because the package did not install it.
 */
export function uninstallActions(manifest, installedPackage) {
  const declared = manifest?.actions?.uninstall
    ? validateActions(manifest.actions.uninstall,
                      `${manifest.id} actions.uninstall`, { ordered: false })
    : [];

  const owned = (installedPackage?.files ?? []).map((file) => ({
    do: 'remove',
    name: file.name,
    type: TYPE_NAMES[file.type],
  }));

  /* A manifest naming something the index already owns is not an error, just
   * redundant -- Cesium does it. Deleting twice would only waste a round trip. */
  const already = new Set(owned.map((action) => action.name));
  const extra = declared.filter(
    (action) => action.do === 'remove' && !already.has(action.name));

  /*
   * The removals are the index's, so a manifest cannot write itself into the
   * middle of them the way an install list can. "when" is what places a message
   * either side: a warning about what is about to go, or an account of what has
   * gone and what is left to do by hand. Most are the second, so that is the
   * default.
   */
  const messages = declared.filter((action) => action.do === 'message');
  const before = messages.filter((action) => action.when === 'pre');
  const after = messages.filter((action) => (action.when || 'post') === 'post');

  if (!owned.length && !extra.length && !installedPackage) {
    throw new ActionError(
      'nothing to uninstall: no record of this package on the calculator');
  }

  return [...before, ...owned, ...extra, ...after];
}

/** Just the work, with the talking taken out. */
export function effectsOf(list) {
  return list.filter((a) => a.do !== 'message');
}
