/*
 * The computer end of the BlueObject link.
 *
 * The calculator is a USB CDC serial port, so this is Web Serial rather than
 * WebUSB: no driver is needed on any platform, because the operating system's
 * own CDC driver claims the port and Chrome talks through that. On Linux the
 * user may need to be in the `dialout` group.
 *
 * Strict lockstep -- one request in flight at a time. The calculator has no
 * room to queue work, and a strict order makes recovery after an unplug simple.
 */

import {
  PROTO_VERSION, CMD, STATUS, STATUS_TEXT, FLAG,
  HEADER_SIZE, HELLO_SIZE, ARMED_RECORD, VERSION_CHARS,
  USB_VENDOR_ID, USB_PRODUCT_ID,
} from './proto.js';

const BAUD_RATE = 115200;
const REPLY_TIMEOUT_MS = 30000;

/*
 * How long to wait once the calculator says it is busy.
 *
 * An archive defragment prompts the user and then waits for a keypress, so it
 * takes as long as it takes. Giving up during one would abandon a variable
 * half-written and leave the two ends disagreeing about what is stored.
 */
const BUSY_TIMEOUT_MS = 15 * 60 * 1000;

export function isSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export class ProtocolError extends Error {
  constructor(cmd, status) {
    const detail = STATUS_TEXT[status] || `status ${status}`;
    super(`command 0x${cmd.toString(16).padStart(2, '0')}: ${detail}`);
    this.name = 'ProtocolError';
    this.cmd = cmd;
    this.status = status;
  }
}

function decodeAscii(bytes) {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

export class Calculator {
  constructor(port) {
    this.port = port;
    this.seq = 0;
    this.pending = new Uint8Array(0);
    this.hello = null;
    /* Called when the calculator says it is defragmenting, so the UI can
     * explain why nothing is happening for possibly quite a while. */
    this.onBusy = null;
  }

  /** Prompt for the calculator's serial port, or reuse one already granted. */
  static async request() {
    if (!isSupported()) {
      throw new Error('This browser has no Web Serial. Use Chrome, Edge or '
        + 'another Chromium browser.');
    }

    const filters = [{ usbVendorId: USB_VENDOR_ID, usbProductId: USB_PRODUCT_ID }];
    const granted = await navigator.serial.getPorts();
    const known = granted.find((port) => {
      const info = port.getInfo();
      return info.usbVendorId === USB_VENDOR_ID
        && info.usbProductId === USB_PRODUCT_ID;
    });

    return new Calculator(known || await navigator.serial.requestPort({ filters }));
  }

  async open() {
    await this.port.open({ baudRate: BAUD_RATE });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.pending = new Uint8Array(0);
    this.seq = 0;
  }

  async close() {
    try {
      if (this.reader) { await this.reader.cancel(); this.reader.releaseLock(); }
      if (this.writer) { await this.writer.close(); }
    } catch { /* the cable may already be out; closing is best effort */ }
    this.reader = null;
    this.writer = null;
    try { await this.port.close(); } catch { /* as above */ }
  }

  static #withTimeout(promise, what, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the calculator did not answer ${what}`)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); });
    });
  }

  /*
   * Read exactly `length` bytes.
   *
   * A serial read lands wherever it lands -- it has no idea what a message is
   * -- so anything that wants a fixed-size header has to buffer and re-slice.
   */
  async #receive(length, what, limit = REPLY_TIMEOUT_MS) {
    while (this.pending.length < length) {
      const { value, done } = await Calculator.#withTimeout(
        this.reader.read(), what, limit);
      if (done) throw new Error('the calculator closed the connection');
      if (!value || !value.length) continue;

      const merged = new Uint8Array(this.pending.length + value.length);
      merged.set(this.pending, 0);
      merged.set(value, this.pending.length);
      this.pending = merged;
    }

    const out = this.pending.slice(0, length);
    this.pending = this.pending.slice(length);
    return out;
  }

  async #send(bytes) {
    await this.writer.write(bytes);
  }

  async request(cmd, payload = new Uint8Array(0), arg = 0) {
    const seq = (this.seq = (this.seq + 1) & 0xff);
    const what = `command 0x${cmd.toString(16).padStart(2, '0')}`;

    const message = new Uint8Array(HEADER_SIZE + payload.length);
    const view = new DataView(message.buffer);
    view.setUint8(0, cmd);
    view.setUint8(1, seq);
    view.setUint16(2, arg, true);
    view.setUint32(4, payload.length, true);
    message.set(payload, HEADER_SIZE);
    await this.#send(message);

    let limit = REPLY_TIMEOUT_MS;
    for (;;) {
      const reply = await this.#receive(HEADER_SIZE, what, limit);
      const replyView = new DataView(reply.buffer);
      const replyCmd = replyView.getUint8(0);
      const replySeq = replyView.getUint8(1);
      const status = replyView.getUint16(2, true);
      const length = replyView.getUint32(4, true);

      if (replyCmd === CMD.BUSY) {
        limit = BUSY_TIMEOUT_MS;
        if (this.onBusy) this.onBusy();
        continue;
      }

      const body = length
        ? await this.#receive(length, what, limit)
        : new Uint8Array(0);

      /*
       * A late answer -- to a request we already gave up on -- is discarded
       * rather than treated as a fault, so a link that does get out of step
       * recovers on its own instead of failing every command after it.
       */
      if (replySeq !== seq) continue;
      if (status !== STATUS.OK) throw new ProtocolError(replyCmd, status);
      return body;
    }
  }

  /* ------------------------------------------------------------- commands */

  async sayHello() {
    const body = await this.request(CMD.HELLO, new Uint8Array([PROTO_VERSION]));
    if (body.length < HELLO_SIZE) {
      throw new Error('the calculator sent a HELLO this page cannot read');
    }
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

    const read24 = (at) => body[at] | (body[at + 1] << 8) | (body[at + 2] << 16);

    const flags = body[1];
    const hello = {
      protocol: body[0],
      flags,
      helper: (flags & FLAG.HELPER) !== 0,
      armed: (flags & FLAG.ARMED) !== 0,
      password: (flags & FLAG.PASSWORD) !== 0,
      hasIndex: (flags & FLAG.INDEX) !== 0,
      swept: (flags & FLAG.SWEPT) !== 0,
      freeArchive: read24(2),
      freeRam: read24(5),
      maxVarBytes: view.getUint16(8, true),
      chunkSize: view.getUint16(10, true),
      os: `${body[12]}.${body[13]}.${body[14]}`,
      osBuild: view.getUint16(15, true),
      hardwareType: body[17],
      hardwareVersion: body[18],
      calcId: Array.from(body.subarray(19, 27))
        .map((b) => b.toString(16).padStart(2, '0')).join(''),
      authFailures: body[27],
      calcUnixTime: view.getUint32(28, true),
      version: decodeAscii(body.subarray(32, 32 + VERSION_CHARS)),
      armedItems: [],
    };

    let at = HELLO_SIZE;
    for (let i = 0; i < body[40] && at + ARMED_RECORD <= body.length; i++) {
      hello.armedItems.push({
        slot: body[at],
        type: body[at + 1],
        name: decodeAscii(body.subarray(at + 2, at + 10)),
        version: decodeAscii(body.subarray(at + 10, at + 18)),
      });
      at += ARMED_RECORD;
    }

    this.hello = hello;
    return hello;
  }

  async space() {
    const body = await this.request(CMD.SPACE);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const read24 = (at) => body[at] | (body[at + 1] << 8) | (body[at + 2] << 16);
    return {
      freeArchive: read24(0),
      freeRam: read24(3),
      maxVarBytes: view.getUint16(6, true),
    };
  }

  async bye() {
    await this.request(CMD.BYE);
  }
}
