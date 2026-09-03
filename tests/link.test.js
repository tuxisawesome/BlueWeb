import { test, equal, deepEqual } from './harness.js';
import { Calculator } from '../js/link.js';

/*
 * One page of a LIST reply: a 16-bit total, a count, then 12 bytes per entry --
 * eight of name, the type, the flags, and a 16-bit size.
 */
function listPage(total, entries) {
  const reply = new Uint8Array(3 + entries.length * 12);
  const view = new DataView(reply.buffer);
  view.setUint16(0, total, true);
  reply[2] = entries.length;
  entries.forEach(({ name, type = 0x05, archived = false, bytes = 100 }, i) => {
    const at = 3 + i * 12;
    for (let c = 0; c < name.length && c < 8; c++) reply[at + c] = name.charCodeAt(c);
    reply[at + 8] = type;
    reply[at + 9] = archived ? 1 : 0;
    view.setUint16(at + 10, bytes, true);
  });
  return reply;
}

/** A calculator whose LIST replies are canned, recording the offsets asked for. */
function listing(pages) {
  const calculator = new Calculator(null);
  calculator.asked = [];
  calculator.request = async (cmd, payload, arg) => {
    calculator.asked.push(arg);
    return pages.shift() || listPage(0, []);
  };
  return calculator;
}

test('the two files TI-OS keeps for itself are never reported', async () => {
  /*
   * `#` and `!` are the operating system's, belong to no package and cannot be
   * deleted. Left in, the Device panel would offer a removal that always fails.
   */
  const calculator = listing([listPage(4, [
    { name: 'SNAKE' }, { name: '#' }, { name: '!' }, { name: 'OiramPK' },
  ])]);

  deepEqual((await calculator.listVariables()).map((v) => v.name),
    ['SNAKE', 'OiramPK']);
});

test('paging still counts the hidden ones', async () => {
  /*
   * The offset is the calculator's, not the page's. Asking for entry 2 after
   * dropping two would hand back entries this page has already seen, forever.
   */
  const calculator = listing([
    listPage(4, [{ name: 'SNAKE' }, { name: '#' }, { name: '!' }]),
    listPage(4, [{ name: 'OiramPK' }]),
  ]);

  const all = await calculator.listVariables();
  deepEqual(all.map((v) => v.name), ['SNAKE', 'OiramPK']);
  deepEqual(calculator.asked, [0, 3], 'the second page starts after all three');
});

test('a calculator holding nothing else still finishes', async () => {
  const calculator = listing([listPage(2, [{ name: '#' }, { name: '!' }])]);
  equal((await calculator.listVariables()).length, 0);
  deepEqual(calculator.asked, [0], 'the count is reached, so it stops asking');
});
