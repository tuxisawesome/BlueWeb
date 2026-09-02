/*
 * A test runner small enough to read.
 *
 * There is no node on the machine this was written on and no test framework in
 * this repository, deliberately: BlueWeb has no build step, and adding a
 * runtime to test it would be the wrong trade. So the tests run in the browser
 * that runs the app, against the real modules, with no bundler in between.
 */

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

export function equal(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message || 'not equal'}: got ${JSON.stringify(actual)}, `
      + `expected ${JSON.stringify(expected)}`);
  }
}

export function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'not equal'}:\n  got      ${a}\n  expected ${b}`);
}

export function bytesEqual(actual, expected, message) {
  if (actual.length !== expected.length) {
    throw new Error(`${message || 'bytes differ'}: got ${actual.length} bytes, `
      + `expected ${expected.length}`);
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${message || 'bytes differ'}: first difference at ${i} `
        + `(got 0x${actual[i].toString(16)}, expected 0x${expected[i].toString(16)})`);
    }
  }
}

/** Assert that `fn` throws, and optionally that the message mentions `match`. */
export function throws(fn, match, message) {
  let threw = null;
  try {
    fn();
  } catch (error) {
    threw = error;
  }
  if (!threw) throw new Error(`${message || 'expected a throw'}: nothing was thrown`);
  if (match && !String(threw.message).includes(match)) {
    throw new Error(`${message || 'wrong error'}: expected something mentioning `
      + `"${match}", got "${threw.message}"`);
  }
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export async function run() {
  const results = document.getElementById('results');
  let passed = 0;
  const failures = [];

  for (const { name, fn } of tests) {
    const row = document.createElement('div');
    row.className = 'row';
    try {
      await fn();
      passed++;
      row.innerHTML = `<span class="ok">PASS</span> ${name}`;
    } catch (error) {
      failures.push({ name, error });
      row.innerHTML = `<span class="bad">FAIL</span> ${name}`;
      const detail = document.createElement('pre');
      detail.textContent = error.message;
      row.appendChild(detail);
    }
    results.appendChild(row);
  }

  const summary = document.getElementById('summary');
  if (failures.length) {
    summary.textContent = `${failures.length} failed, ${passed} passed`;
    summary.className = 'bad';
    /* In the tab title too, so the result is visible without reading the page. */
    document.title = `FAIL ${failures.length}`;
  } else {
    summary.textContent = `all ${passed} passed`;
    summary.className = 'ok';
    document.title = 'PASS';
  }
}
