/*
 * Working out what has to be installed, and what would break if something were
 * removed.
 *
 * Two graphs, and they are not the same graph. Installing walks the
 * *catalogue*, which is the current truth about what an app needs. Removing
 * walks the *index*, which records what each installed package needed when it
 * actually went on -- possibly an older version with different dependencies, or
 * a package the catalogue has since dropped. Using the catalogue for removal
 * would mean telling somebody it is safe to remove something three apps are
 * still using.
 */

import { satisfies, compareVersions, isUpgrade } from './version.js';

export class DependencyError extends Error {}

/*
 * Packages that must never be removed, even as collateral.
 *
 * Removing BlueObject leaves nothing on the calculator that can install or
 * remove anything else, so there is no route back from this page -- only TI
 * Connect and a cable. The calculator also refuses to delete its own running
 * program whatever it is asked, so the removal would fail half-finished and
 * report an error about a name.
 *
 * This used to protect clibs too, by proxy: BlueObject loaded five of the
 * shared libraries, so a cascading removal of them swept BlueObject up and was
 * refused here. No published build depends on them any more -- 2.0.0 onwards
 * carries the two drivers it cannot do without, see BlueObject's
 * docs/LIBLINK.md -- so clibs is an ordinary package now, kept for the other
 * apps and removable like any of them.
 *
 * Not quite for everybody, and that is deliberate rather than an oversight. The
 * resolver works from the dependencies the *index on the calculator* records,
 * not from the catalogue, so a calculator still holding an older BlueObject
 * still has clibs protected by proxy -- which is right, because removing them
 * from that calculator really would stop it running. The protection follows
 * what is actually installed instead of being asserted about a package whose
 * answer has changed.
 */
export const PROTECTED = new Set(['blueobject']);

function catalogEntry(catalog, id) {
  const entry = catalog.byId.get(id);
  if (!entry) throw new DependencyError(`"${id}" is not in the catalogue`);
  return entry;
}

/*
 * Dependency ranges live in the per-app manifest; the catalogue index carries
 * only the ids, which is enough to shape the plan and size it with one fetch.
 * A range is checked once the manifest is in hand.
 */
function requirementsOf(entry, manifests) {
  const manifest = manifests?.get(entry.id);
  if (manifest?.dependencies) {
    return manifest.dependencies.map((dep) =>
      (typeof dep === 'string' ? { id: dep, version: null } : dep));
  }
  return (entry.deps || []).map((id) => ({ id, version: null }));
}

/**
 * What installing `rootId` would mean.
 *
 * Returns `{ order, reasons, upgrades, satisfied }`. `order` is what to install,
 * dependencies first; `reasons` says why each one is in there.
 */
export function resolveInstall(catalog, installed, rootId, manifests = null) {
  const installedById = new Map(installed.map((p) => [p.id, p]));

  const order = [];
  const reasons = new Map();
  const upgrades = [];
  const satisfied = [];

  const visiting = new Set();
  const done = new Set();

  const visit = (id, requiredBy, range) => {
    if (done.has(id)) return;

    /*
     * The catalogue linter makes cycles impossible in this repository, but the
     * resolver must never hang on a catalogue that has been hand-edited or
     * partially fetched.
     */
    if (visiting.has(id)) {
      throw new DependencyError(
        `"${id}" depends on itself, through ${[...visiting].join(' -> ')}`);
    }
    visiting.add(id);

    const entry = catalogEntry(catalog, id);
    const have = installedById.get(id);

    for (const need of requirementsOf(entry, manifests)) {
      visit(need.id, id, need.version);
    }

    visiting.delete(id);
    done.add(id);

    if (range && !satisfies(entry.version, range)) {
      throw new DependencyError(
        `${requiredBy} needs ${entry.name} ${range}, but the store has `
        + `${entry.version}`);
    }

    if (have) {
      if (range && !satisfies(have.version, range)) {
        /* Installed, but too old for whatever is asking. */
        upgrades.push({ entry, from: have.version });
      } else if (isUpgrade(have.version, entry.version) && id === rootId) {
        /* Only the app actually asked for is upgraded on the way past;
         * silently upgrading a dependency that already works is not ours to
         * decide. */
        upgrades.push({ entry, from: have.version });
      } else {
        satisfied.push({ entry, installed: have.version });
        return;
      }
    }

    order.push(entry);
    reasons.set(id, requiredBy ? { requiredBy } : { requested: true });
  };

  visit(rootId, null, null);
  return { order, reasons, upgrades, satisfied };
}

/** Installed packages that name `id` among their dependencies. */
export function dependentsOf(installed, id) {
  return installed.filter((p) => (p.deps || []).includes(id));
}

/**
 * What removing `id` would mean.
 *
 * Never cascades on its own. `blockedBy` is what the user has to be shown and
 * asked about; `order` is only filled in once they have chosen to take the
 * dependents with it, and it removes dependents *first* so the calculator never
 * holds an app whose dependency has already gone.
 */
export function planRemoval(installed, id, { cascade = false } = {}) {
  const byId = new Map(installed.map((p) => [p.id, p]));
  const target = byId.get(id);
  if (!target) throw new DependencyError(`"${id}" is not installed`);

  /* The transitive closure of things that would stop working. */
  const doomed = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const pkg of installed) {
      if (doomed.has(pkg.id)) continue;
      if ((pkg.deps || []).some((dep) => doomed.has(dep))) {
        doomed.add(pkg.id);
        changed = true;
      }
    }
  }

  const blockedBy = [...doomed].filter((d) => d !== id).map((d) => byId.get(d));

  /*
   * Something in the fallout must not be removed at all, so no version of this
   * is safe -- not even the cascade. The caller has to offer cancelling.
   */
  const protectedBy = [...doomed]
    .filter((d) => PROTECTED.has(d))
    .map((d) => byId.get(d));

  if (protectedBy.length) {
    return { order: [], blockedBy, protectedBy };
  }

  if (blockedBy.length && !cascade) {
    return { order: [], blockedBy, protectedBy: [] };
  }

  /*
   * Dependents first, then what they depended on. Depth from the target, so
   * anything that needs something else in the set goes before it.
   */
  const depth = new Map();
  const measure = (pkgId, seen = new Set()) => {
    if (depth.has(pkgId)) return depth.get(pkgId);
    if (seen.has(pkgId)) return 0;
    seen.add(pkgId);
    const pkg = byId.get(pkgId);
    let best = 0;
    for (const dep of pkg?.deps || []) {
      if (doomed.has(dep)) best = Math.max(best, measure(dep, seen) + 1);
    }
    depth.set(pkgId, best);
    return best;
  };

  const order = [...doomed]
    .map((d) => byId.get(d))
    .sort((a, b) => measure(b.id) - measure(a.id));

  return { order, blockedBy, protectedBy: [] };
}

/**
 * Dependencies nothing needs any more.
 *
 * Only packages the resolver pulled in are ever offered -- something the user
 * asked for by name stays until they say otherwise, however unreferenced it is.
 * System packages are never offered at all.
 */
export function orphansAfter(installed, removedIds) {
  const removed = new Set(removedIds);
  const remaining = installed.filter((p) => !removed.has(p.id));

  return remaining.filter((pkg) =>
    !pkg.explicit
    && pkg.kind !== 1
    && !remaining.some((other) =>
      other.id !== pkg.id && (other.deps || []).includes(pkg.id)));
}

/** Newest-first ordering for the Updates panel. */
export function findUpdates(catalog, installed) {
  const updates = [];
  for (const pkg of installed) {
    const entry = catalog.byId.get(pkg.id);
    if (entry && isUpgrade(pkg.version, entry.version)) {
      updates.push({ entry, from: pkg.version, to: entry.version, kind: entry.kind });
    }
  }
  return updates.sort((a, b) => compareVersions(b.to, a.to));
}

/**
 * What installing several things at once would mean.
 *
 * Each root is resolved in turn against what is on the calculator *now*, and
 * the orders are laid end to end with anything already in the list dropped.
 * Two apps that share a dependency must not send it twice, and the second
 * resolve has no way of knowing the first one already accounted for it.
 *
 * Dropping duplicates cannot spoil the ordering: within one plan a dependency
 * always precedes what needs it, and a skip only ever happens because the
 * package is already *earlier* in the combined list.
 *
 * Resolving one root at a time rather than teaching visit() about several is
 * deliberate. The single-root walk is what every word of the confirmation
 * dialog is written against, and a second traversal order would be a second set
 * of answers to explain.
 */
export function resolveInstallAll(catalog, installed, rootIds, manifests = null) {
  const order = [];
  const reasons = new Map();
  const upgrades = [];
  const satisfied = [];

  for (const rootId of rootIds) {
    const plan = resolveInstall(catalog, installed, rootId, manifests);

    for (const entry of plan.order) {
      if (reasons.has(entry.id)) continue;
      order.push(entry);
      reasons.set(entry.id, plan.reasons.get(entry.id));
    }
    for (const item of plan.upgrades) {
      if (!upgrades.some((each) => each.entry.id === item.entry.id)) upgrades.push(item);
    }
    for (const item of plan.satisfied) {
      if (!satisfied.some((each) => each.entry.id === item.entry.id)) satisfied.push(item);
    }
  }

  /*
   * Asked for by name beats pulled in, whatever reached it first. Somebody who
   * ticks the C libraries and Cesium is owed a dialog saying they asked for the
   * libraries, not that Cesium did -- and the difference decides whether the
   * libraries are later offered up as an orphan.
   */
  const requested = new Set(rootIds);
  for (const id of requested) {
    if (reasons.has(id)) reasons.set(id, { requested: true });
  }

  return {
    order,
    reasons,
    upgrades,
    /* One root can find a package acceptable while another needs it upgraded.
     * It is being installed, so it is not also being left alone. */
    satisfied: satisfied.filter((each) => !reasons.has(each.entry.id)),
    requested,
  };
}
