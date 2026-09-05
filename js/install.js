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
  installActions, updateActions, uninstallActions, effectsOf,
} from './actions.js';

export class InstallError extends Error {}

/*
 * The user read a message and said stop.
 *
 * Not an InstallError: nothing went wrong, and a panel that reports it as a
 * failure is telling somebody their own decision was a fault. Anything already
 * written stays written -- the index row is left marked mid-install, which is
 * the same state a pulled cable leaves and is already understood everywhere
 * that matters.
 */
export class InstallCancelled extends Error {}

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
    /*
     * Manifests and preflighted files, kept between planSteps() and apply() so
     * drawing a progress bar does not cost a second download of the package.
     */
    this.prepared = new Map();
  }

  /**
   * Point this session at a different catalogue.
   *
   * Which happens when the build channel changes with a calculator still
   * connected. Everything prepared so far was preflighted against the old
   * channel -- the manifest, and the actual file bytes -- so it is thrown away
   * rather than reused: keeping it would draw a plan for one build and send
   * another, and nothing downstream would notice.
   */
  useCatalog(catalog) {
    this.catalog = catalog;
    this.prepared.clear();
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

  /*
   * Run one `message` action, where it stands in the list.
   *
   * `remaining` is how many uploads and removals are still to come. Whether the
   * reader is offered a way out is the message's own `stop`, which defaults to
   * "yes if there is anything left to stop" -- a warning about what is coming
   * can be declined unless the manifest says otherwise, and a note at the end
   * has nothing to decline. A handler returning false is the user saying so.
   */
  async #tell(onMessage, action, remaining, id) {
    const stop = action.stop ?? remaining > 0;

    if (!onMessage) {
      /*
       * Without a handler a message has nowhere to go. That is only tolerable
       * where the message carries no decision: one that can be stopped at is
       * being asked, and running past it unasked would be taking the answer on
       * the user's behalf. Anything else is a note, and a dropped note costs
       * only the note.
       */
      if (!stop) return;
      throw new InstallError(
        `${id}: an action list stops to ask something here, and nothing was `
        + `given to ask it with`);
    }

    const go = await onMessage({
      text: action.text,
      level: action.level || 'info',
      remaining,
      stop,
    });

    /*
     * The answer is only binding where the message said it could be stopped at.
     * `stop: false` is the package declaring that this one is not a choice, and
     * that has to hold whatever is showing it -- otherwise the guarantee is
     * only as good as the handler that happens to be wired up, which is the
     * kind of promise that survives until the second caller.
     */
    if (stop && !go) throw new InstallCancelled(`${id}: stopped at a message`);
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

  /*
   * Everything apply() needs, worked out once.
   *
   * planSteps() and apply() both want the manifest, the action list and the
   * preflighted files, and preflight fetches every file in the package -- so
   * doing it twice would download the whole of KhiCAS to draw a progress bar.
   * The result is cached against the id and consumed by apply().
   */
  async #prepare(id) {
    const held = this.prepared.get(id);
    if (held) return held;

    const entry = this.catalog.byId.get(id);
    if (!entry) throw new InstallError(`"${id}" is not in the store`);

    const manifest = await loadManifest(this.catalog, id);
    const existing = this.find(id);
    const actions = existing ? updateActions(manifest) : installActions(manifest);
    const uploads = await this.#preflight(id, actions);

    const bundle = { entry, manifest, actions, uploads };
    this.prepared.set(id, bundle);
    return bundle;
  }

  /**
   * What applying this package will do, in order, before any of it happens.
   *
   * Each step is `{ label, bytes }`; `bytes` is 0 for the ones that move none.
   * The index write at either end and the removals are steps too -- they take
   * real time, most of it a flash write, and a bar that ignores them stands
   * still through exactly the parts that look most like a hang.
   *
   * The indices line up with the `step` that apply()'s `onProgress` reports, so
   * a caller can lay several packages end to end and get one bar across all of
   * them.
   */
  async planSteps(id) {
    const { actions, uploads } = await this.#prepare(id);

    const steps = [{ label: 'Recording the install', bytes: 0 }];
    for (const action of effectsOf(actions)) {
      if (action.do === 'upload') {
        const found = uploads.find((u) => u.action === action);
        steps.push({
          label: found ? found.variable.name : action.file,
          bytes: found ? found.variable.body.length : 0,
        });
      } else if (action.do === 'remove') {
        steps.push({ label: `Removing ${action.name}`, bytes: 0 });
      }
    }
    steps.push({ label: 'Finishing', bytes: 0 });
    return steps;
  }

  /**
   * Install or update one package.
   *
   * `explicit` records whether the user asked for this by name or the resolver
   * pulled it in -- which is what decides, much later, whether it is ever
   * offered for cleanup as an orphan.
   */
  async apply(id, { explicit = true, onProgress = null, onMessage = null } = {}) {
    const { entry, actions, uploads } = await this.#prepare(id);
    const existing = this.find(id);

    /*
     * A bundle describes a decision taken before this ran -- install or update,
     * and which files that implies. Once it has been acted on, or failed part
     * way, it is out of date: the package may now be installed when it was not.
     * So it is consumed here, and a later attempt works it out again.
     */
    this.prepared.delete(id);

    /*
     * Step 0 is the claim below, and every action gets the next index, so these
     * line up one for one with what planSteps() described.
     */
    const report = (step, file, sent, size) => onProgress?.({
      package: entry.name, file, sent, size, step,
    });

    /*
     * The claim, written before the first file. Its file list is what the
     * uploads below are about to create, so an interrupted install leaves a row
     * that names them even though they are not all there yet.
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

    /*
     * Claimed on the way past the first real action rather than up front, so a
     * message written before everything else -- the one that says what this is
     * about to do to the calculator -- can be answered with "stop" and leave
     * nothing behind at all.
     */
    let claimed = false;
    const claim = async () => {
      if (claimed) return;
      claimed = true;
      report(0, null, 0, 0);
      const at = this.packages.findIndex((p) => p.id === id);
      if (at >= 0) this.packages[at] = row; else this.packages.push(row);
      await this.save();
    };

    /*
     * Uploads for a system package go in the order the manifest lists them,
     * which for BlueObject means the updater before the program it installs.
     * See SYSTEM_SLOTS.
     *
     * Messages are in that same order and are run where they stand, so one
     * between two files stops there and waits.
     */
    const effects = effectsOf(actions).length;
    let step = 0;
    for (const action of actions) {
      if (action.do === 'message') {
        await this.#tell(onMessage, action, effects - step, id);
        continue;
      }
      await claim();
      step++;
      if (action.do === 'upload') {
        const { variable } = uploads.find((u) => u.action === action);
        const here = step;
        const onBytes = (sent, size) => report(here, variable.name, sent, size);
        onBytes(0, variable.body.length);

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
          }, onBytes);
        } else {
          await this.calculator.putVariable({
            name: variable.name,
            type: variable.type,
            body: variable.body,
            archive: action.archive !== false,
            owner: id,
          }, onBytes);
        }
      } else if (action.do === 'remove') {
        report(step, action.name, 0, 0);
        await this.calculator.deleteVariable(action.name, TYPE_BY_NAME[action.type]);
        row.files = row.files.filter((f) => f.name !== action.name);
      }
    }

    /* A package that is nothing but messages still gets its row. */
    await claim();

    report(step + 1, null, 0, 0);
    row.installing = false;
    await this.save();

    return row;
  }

  /**
   * Remove one package.
   *
   * What gets deleted comes from the index, not from the manifest, unless the
   * manifest overrides it -- so a package installed by an older version whose
   * file list has since changed still goes completely.
   */
  async remove(id, { onMessage = null } = {}) {
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

    /*
     * The row goes as soon as the last variable has, and before any message
     * that follows. Those messages are written in the past tense -- what has
     * been removed, and what has to be done by hand -- so the index has to
     * agree with them by the time they are read. It also means stopping at one
     * stops nothing half-done: there is nothing left to do.
     */
    let dropped = false;
    const drop = async () => {
      if (dropped) return;
      dropped = true;
      this.packages = this.packages.filter((p) => p.id !== id);
      await this.save();
    };

    const effects = effectsOf(actions).length;
    let step = 0;

    for (const action of actions) {
      if (action.do === 'message') {
        await this.#tell(onMessage, action, effects - step, id);
        continue;
      }
      if (action.do === 'upload') {
        throw new InstallError(`${id}: an uninstall cannot upload anything`);
      }
      await this.calculator.deleteVariable(action.name, TYPE_BY_NAME[action.type]);
      step++;
      if (step === effects) await drop();
    }

    await drop();
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
