/*
 * What is on the calculator.
 *
 * Everything here comes from one HELLO. The calculator gathers all of it before
 * USB starts, because asking the operating system anything mid-transfer is what
 * froze the link in the project this one is descended from.
 */

const KB = 1024;

function kb(bytes) {
  return `${(bytes / KB).toFixed(bytes < 10 * KB ? 1 : 0)} KB`;
}

function hardware(hello) {
  const model = hello.hardwareType === 0 ? 'TI-84 Plus CE' : 'TI-83 Premium CE';
  return `${model} (rev ${hello.hardwareVersion})`;
}

export function render(hello) {
  const empty = document.getElementById('device-empty');
  const facts = document.getElementById('device-facts');

  if (!hello) {
    empty.hidden = false;
    facts.hidden = true;
    return;
  }

  const rows = [
    ['Model', hardware(hello)],
    ['Operating system', `${hello.os} (build ${hello.osBuild})`],
    ['BlueObject', hello.version || 'unknown'],
    ['Link protocol', String(hello.protocol)],
    ['Archive free', kb(hello.freeArchive)],
    ['RAM free', kb(hello.freeRam)],
    /*
     * The number that decides whether an app can be installed at all: a TI
     * variable has to exist whole in RAM before it can be archived, so this is
     * the real ceiling on a single file -- not the 64 KB format limit.
     */
    ['Largest installable file', kb(hello.maxVarBytes)],
    ['Updater', hello.helper ? 'installed' : 'not installed'],
    ['Index', hello.hasIndex ? 'present' : 'not set up yet'],
    ['Calculator ID', hello.calcId],
  ];

  if (hello.armedItems.length) {
    rows.push(['Waiting for prgmBLUEUP',
      hello.armedItems.map((a) => `${a.name} ${a.version}`).join(', ')]);
  }

  facts.replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  }));

  empty.hidden = true;
  facts.hidden = false;
}
