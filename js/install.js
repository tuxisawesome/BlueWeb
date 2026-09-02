/*
 * Running an action list against a calculator, and keeping the index honest
 * while it happens.
 *
 * ## The ordering that matters
 *
 * The package's row goes into the index *before* its files, marked as
 * mid-install and already listing what it is about to own. Only once every
 * action has succeeded is the row written again with that mark cleared.
 *
 * The obvious order -- install the files, then record them -- loses everything
 * if the cable comes out in between: the calculator ends up holding variables
 * nothing accounts for, under names nothing can map back to a package, and the
 * only way to clean up is by hand. Writing the claim first costs one extra
 * round trip and means an interrupted install leaves a row that says exactly
 * what was being attempted and what it would have owned.
 */

import { readVariable, TYPE_BY_NAME, TYPE_NAMES } from './tifile.js';
import { parseIndex, buildIndex, KIND_SYSTEM } from './blueidx.js';
import { loadManifest, loadFile } from './catalog.js';
import {
  installActions, updateActions, uninstallActions, effectsOf, messagesFor,
} from './actions.js';

export class InstallError extends Error {}

/*
 * Variables that cannot be written the ordinary way.
 *
 * BlueObject refuses any name beginning with BLUE through VAR_*, so that a
 * catalogue entry cannot name the index and have it deleted or name the running
 * program and have it overwritten. These are the ones that are supposed to be
 * written, and the staged path is how: each gets a slot in the archive.
 *
 * The order is the order they are sent in, and it matters. If a session dies
 * between the two, what is left is a calculator with a current updater and its
 * old BlueObject -- which still works, and can still be updated next time. The
 * other way round leaves an armed update and an updater too old to be trusted
 * with it.
 */
const SYSTEM_SLOTS = { BLUEUP: 1, BLUE: 0 };

export function isSystemVariable(name) {
  return name.startsWith('BLUE');
}

/**
 * One connected calculator, and what is on it.
 *
 * Holds the index across a series of operations so a plan of several packages
 * costs one read at the start rather than one per package.
 */
export class Session {
  constructor(calculator, catalog) {
    this.calculator = calculator;
    this.catalog = catalog;
    this.packages = [];
    this.messages = [];
  }

  /** Read the index off the calculator. */
  async load() {
    const bytes = await this.calculator.getIndex();
    this.packages = parseIndex(bytes).packages;
    return this.packages;
  }

  /** Write it back. The calculator splices its own device block in. */
  async save() {
    await this.calculator.putIndex(buildIndex(this.packages));
  }

  find(id) {
    return this.packages.find((p) => p.id === id);
  }

  /** Start a fresh index on a calculator that has none. */
  async initialise() {
    this.packages = [];
    await this.save();
  }

  #say(text, level = 'info') {
    this.messages.push({ text, level });
  }

  /*
   * Check the whole package before sending any of it.
   *
   * A file too large to build in RAM cannot be installed at all, and finding
   * that out after transferring the ones before it wastes a minute and leaves
   * the package half on.
   */
  async #preflight(id, actions) {
    const uploads = [];
    let total = 0;

    for (const action of effectsOf(actions)) {
      if (action.do !== 'upload') continue;

      const raw = await loadFile(this.catalog, id, action.file);
      const variable = readVariable(raw);
      uploads.push({ action, variable });
      total += variable.body.length;

      const limit = this.calculator.hello?.maxVarBytes;
      if (limit && variable.body.length > limit) {
        throw new InstallError(
          `${action.file} holds ${variable.body.length} bytes, and this `
          + `calculator can only build ${limit} at once. A variable has to fit `
          + `in RAM before it can be archived, so this cannot be installed here.`);
      }
    }

    const free = this.calculator.hello?.freeArchive;
    if (free && total > free) {
      throw new InstallError(
        `this needs ${total} bytes and the archive has ${free} free. `
        + `Uninstall something first.`);
    }

    return uploads;
  }

  /**
   * Install or update one package.
   *
   * `explicit` records whether the user asked for this by name or the resolver
   * pulled it in -- which is what decides, much later, whether it is ever
   * offered for cleanup as an orphan.
   */
  async apply(id, { explicit = true, onProgress = null } = {}) {
    const entry = this.catalog.byId.get(id);
    if (!entry) throw new InstallError(`"${id}" is not in the store`);

    const manifest = await loadManifest(this.catalog, id);
    const existing = this.find(id);
    const actions = existing ? updateActions(manifest) : installActions(manifest);

    for (const message of messagesFor(actions, 'pre')) {
      this.#say(message.text, message.level);
    }

    const uploads = await this.#preflight(id, actions);

    /*
     * The claim, written first. Its file list is what the uploads below are
     * about to create, so an interrupted install leaves a row that names them
     * even though they are not all there yet.
     */
    const row = {
      id,
      version: entry.version,
      name: entry.name,
      kind: entry.kind === 'system' ? KIND_SYSTEM : 0,
      explicit: existing ? existing.explicit || explicit : explicit,
      installing: true,
      deps: entry.deps || [],
      files: uploads.map(({ action, variable }) => ({
        name: variable.name,
        type: variable.type,
        archived: action.archive !== false,
        bytes: variable.body.length,
      })),
    };

    const at = this.packages.findIndex((p) => p.id === id);
    if (at >= 0) this.packages[at] = row; else this.packages.push(row);
    await this.save();

    /*
     * Uploads for a system package go in the order the manifest lists them,
     * which for BlueObject means the updater before the program it installs.
     * See SYSTEM_SLOTS.
     */
    let done = 0;
    for (const action of effectsOf(actions)) {
      if (action.do === 'upload') {
        const { variable } = uploads.find((u) => u.action === action);
        const report = (sent, size) => onProgress?.({
          package: entry.name, file: variable.name, sent, size,
          step: done, steps: uploads.length,
        });

        if (isSystemVariable(variable.name)) {
          const slot = SYSTEM_SLOTS[variable.name];
          if (slot === undefined) {
            throw new InstallError(
              `${variable.name} is a name BlueObject reserves, and this page `
              + `does not know how to install it`);
          }
          await this.calculator.putSystemPayload({
            name: variable.name,
            type: variable.type,
            body: variable.body,
            archive: action.archive !== false,
            slot,
            version: entry.version,
          }, report);
        } else {
          await this.calculator.putVariable({
            name: variable.name,
            type: variable.type,
            body: variable.body,
            archive: action.archive !== false,
            owner: id,
          }, report);
        }
        done++;
      } else if (action.do === 'remove') {
        await this.calculator.deleteVariable(action.name, TYPE_BY_NAME[action.type]);
        row.files = row.files.filter((f) => f.name !== action.name);
      }
    }

    row.installing = false;
    await this.save();

    for (const message of messagesFor(actions, 'post')) {
      this.#say(message.text, message.level);
    }

    return row;
  }

  /**
   * Remove one package.
   *
   * What gets deleted comes from the index, not from the manifest, unless the
   * manifest overrides it -- so a package installed by an older version whose
   * file list has since changed still goes completely.
   */
  async remove(id) {
    const installed = this.find(id);
    if (!installed) throw new InstallError(`"${id}" is not installed`);

    /*
     * The manifest is a nicety here and its absence must not stop a removal:
     * the store may have dropped the package entirely, and that is exactly when
     * somebody wants it off their calculator.
     */
    let manifest = null;
    try {
      manifest = await loadManifest(this.catalog, id);
    } catch { /* removal falls back to what the index records */ }

    const actions = uninstallActions(manifest, installed);

    for (const message of messagesFor(actions, 'pre')) {
      this.#say(message.text, message.level);
    }

    for (const action of effectsOf(actions)) {
      if (action.do === 'remove') {
        await this.calculator.deleteVariable(action.name, TYPE_BY_NAME[action.type]);
      } else if (action.do === 'upload') {
        throw new InstallError(
          `${id}: an uninstall cannot upload anything`);
      }
    }

    this.packages = this.packages.filter((p) => p.id !== id);
    await this.save();

    for (const message of messagesFor(actions, 'post')) {
      this.#say(message.text, message.level);
    }
  }

  /**
   * Packages that were part-way through installing when something stopped.
   *
   * Their files may be partly there and partly not, so they are neither
   * installed nor absent, and only the user can say which they would rather
   * have. The row records what was being attempted, which is enough to do
   * either.
   */
  interrupted() {
    return this.packages.filter((p) => p.installing);
  }

  /** Check what the index claims against what the calculator actually holds. */
  async verify(id) {
    const installed = this.find(id);
    if (!installed) throw new InstallError(`"${id}" is not installed`);

    const missing = [];
    const unsupported = [];
    for (const file of installed.files) {
      const stat = await this.calculator.statVariable(file.name, file.type);
      if (!stat.present) missing.push(file.name);
      /* Not merely absent: this BlueObject is too old to name it at all, which
       * is a different problem with a different fix. */
      if (stat.unsupported) unsupported.push(file.name);
    }
    return { ok: missing.length === 0, missing, unsupported };
  }
}

/**
 * Delete a list of variables, and keep going when one of them will not go.
 *
 * One failure must not abandon the rest. Somebody clearing out a dozen
 * leftovers has already said what they want done with all twelve, and stopping
 * at the third would leave them to work out which nine are still there and ask
 * again. What comes back names both halves, so the panel can say so.
 *
 * `deleteVariable` returns false rather than throwing for a variable that was
 * already gone, which is the outcome that was wanted and not a failure.
 */
export async function deleteVariables(calculator, variables, onProgress = null) {
  const deleted = [];
  const failed = [];

  for (let at = 0; at < variables.length; at++) {
    const variable = variables[at];
    onProgress?.({ variable, done: at, total: variables.length });
    try {
      await calculator.deleteVariable(variable.name, variable.type);
      deleted.push(variable);
    } catch (error) {
      failed.push({ variable, error });
    }
  }

  onProgress?.({ variable: null, done: variables.length, total: variables.length });
  return { deleted, failed };
}

/**
 * Sort what is on the calculator against what the index claims.
 *
 * Three kinds, and only the third is interesting. `owned` is what a package
 * installed and the index knows about. `system` is BlueObject's own furniture,
 * which is reserved and never a package's business. `stray` is everything else
 * -- files an interrupted install left behind, things sent across by hand,
 * saves a game made for itself.
 *
 * Strays are not a fault and are not offered for deletion wholesale. A saved
 * game is a stray, and so is a program somebody sent over with TI Connect and
 * would be annoyed to lose. They are shown so the user can decide.
 */
export function classifyVariables(present, packages) {
  const owners = new Map();
  for (const pkg of packages) {
    for (const file of pkg.files) owners.set(file.name, pkg);
  }

  const owned = [];
  const system = [];
  const stray = [];

  for (const variable of present) {
    if (owners.has(variable.name)) {
      owned.push({ ...variable, owner: owners.get(variable.name) });
    } else if (variable.name.startsWith('BLUE')) {
      system.push(variable);
    } else {
      stray.push(variable);
    }
  }

  /* And the other direction: the index claims files the calculator does not
   * have. That is a package that was interrupted, or one whose files were
   * deleted from the calculator's own menus. */
  const here = new Set(present.map((v) => v.name));
  const missing = [];
  for (const pkg of packages) {
    const gone = pkg.files.filter((f) => !here.has(f.name));
    if (gone.length) missing.push({ package: pkg, files: gone });
  }

  return { owned, system, stray, missing };
}

/** Human-readable name for a variable type, for the Device panel. */
export function describeType(type) {
  return TYPE_NAMES[type] || `type 0x${type.toString(16)}`;
}
