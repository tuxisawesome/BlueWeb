/*
 * Comparing version strings.
 *
 * Inequality alone is not enough, and the difference has teeth: a catalogue
 * that has *rolled back* an app would otherwise read as having an update, and
 * the Updates panel would offer to downgrade somebody. So versions are ordered,
 * not merely compared, and only a strictly greater catalogue version counts.
 *
 * The catalogue linter enforces the shape, so nothing here has to guess at
 * something like "1.0-beta.2+build7".
 */

const SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function isValidVersion(version) {
  return typeof version === 'string' && SHAPE.test(version);
}

function parts(version) {
  const [core, pre] = String(version).split('-', 2);
  const numbers = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (numbers.length < 3) numbers.push(0);
  return { numbers, pre };
}

/** -1, 0 or 1, ordering `a` against `b`. */
export function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);

  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) {
      return left.numbers[i] < right.numbers[i] ? -1 : 1;
    }
  }

  /* A pre-release sorts below the release it leads to: 1.2.0-rc1 < 1.2.0. */
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * Does `installed` satisfy a dependency range?
 *
 * Only the operators dependencies actually need. An unrecognised range is
 * refused rather than quietly treated as "anything", because a typo in a
 * manifest must not silently disable a version requirement.
 */
export function satisfies(installed, range) {
  if (!range || range === '*') return true;

  const match = /^(>=|<=|>|<|\^|=)?\s*(.+)$/.exec(String(range).trim());
  if (!match) throw new Error(`cannot understand version range "${range}"`);

  const [, operator = '=', wanted] = match;
  if (!isValidVersion(wanted)) {
    throw new Error(`"${wanted}" in range "${range}" is not a version`);
  }

  const order = compareVersions(installed, wanted);
  switch (operator) {
    case '=': return order === 0;
    case '>': return order > 0;
    case '>=': return order >= 0;
    case '<': return order < 0;
    case '<=': return order <= 0;
    /* Caret: no change to the leftmost non-zero component. */
    case '^': {
      if (order < 0) return false;
      const a = parts(installed).numbers;
      const b = parts(wanted).numbers;
      if (b[0] !== 0) return a[0] === b[0];
      if (b[1] !== 0) return a[0] === 0 && a[1] === b[1];
      return a[0] === 0 && a[1] === 0;
    }
    default: throw new Error(`cannot understand version range "${range}"`);
  }
}

/** Is the catalogue offering something strictly newer than what is installed? */
export function isUpgrade(installed, available) {
  return compareVersions(available, installed) > 0;
}
