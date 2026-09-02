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
  HEADER_SIZE, HELLO_SIZE, ARMED_RECORD, VERSION_CHARS, CHUNK_SIZE,
  USB_VENDOR_ID, USB_PRODUCT_ID,
} from './proto.js';
import { crc32 } from './crc32.js';
import { challengeResponse, storedHash, randomSalt } from './sha256.js';

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
    this.authed = false;
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

  /* ---------------------------------------------------------------- auth */

  /**
   * Answer the calculator's challenge.
   *
   * The salt comes back in the clear, which is fine: a salt's job is to defeat
   * precomputed tables and to stop the same password producing the same bytes
   * on two calculators. The hash is the sensitive half and it never leaves the
   * device -- INDEX_GET zeroes the device block -- so knowing the salt alone
   * buys nothing. A guess has to be submitted, one at a time, into a counter
   * the calculator records.
   *
   * Returns the number of failed attempts the calculator has seen, which is
   * worth showing to whoever does get in.
   */
  async authenticate(password) {
    const challenge = await this.request(CMD.AUTH_BEGIN);
    if (challenge.length < 32) {
      throw new Error('the calculator sent a challenge this page cannot read');
    }
    const salt = challenge.subarray(0, 16);
    const nonce = challenge.subarray(16, 32);

    const reply = await this.request(
      CMD.AUTH, await challengeResponse(salt, nonce, password));
    this.authed = true;
    return reply[0] ?? 0;
  }

  /** Set the sync password, or clear it. */
  async setPassword(password) {
    if (password === null) {
      await this.request(CMD.PW_SET, new Uint8Array(0), 0);
      if (this.hello) this.hello.password = false;
      return;
    }

    const salt = randomSalt();
    const hash = await storedHash(salt, password);

    const payload = new Uint8Array(salt.length + hash.length);
    payload.set(salt, 0);
    payload.set(hash, salt.length);

    await this.request(CMD.PW_SET, payload, 1);
    if (this.hello) this.hello.password = true;
    this.authed = true;
  }

  /* --------------------------------------------------------------- index */

  /**
   * The index as the calculator holds it, with its device block zeroed.
   *
   * Empty means the calculator has no index yet, which is an ordinary state --
   * a calculator that has never been set up -- and not an error.
   */
  async getIndex() {
    return this.request(CMD.INDEX_GET);
  }

  /**
   * Replace the index.
   *
   * The device block being sent is ignored: the calculator splices its own live
   * one over it, so the password hash never has to travel in either direction.
   */
  async putIndex(bytes) {
    await this.request(CMD.INDEX_PUT, bytes);
  }

  async setClock(unixSeconds = Math.floor(Date.now() / 1000)) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, unixSeconds, true);
    await this.request(CMD.CLOCK_SET, payload);
  }

  /* ----------------------------------------------------------- variables */

  /**
   * Send one variable, chunk by chunk.
   *
   * The calculator builds it under a staging name and only gives it the real
   * one once every byte has arrived and the checksum agrees, so an interrupted
   * transfer cannot leave a half-written program behind under a name somebody
   * might run. If this throws part-way, nothing on the calculator changed.
   *
   * `onProgress` is called with bytes sent so far.
   */
  async putVariable({ name, type, body, archive = true, owner = '' },
                    onProgress = null) {
    const chunkSize = this.hello?.chunkSize || CHUNK_SIZE;

    if (this.hello && body.length > this.hello.maxVarBytes) {
      /*
       * Refused here rather than by the calculator, so the message can name the
       * file and the limit. A variable must exist whole in RAM before it can be
       * archived, and there is nowhere near 64 KB of that free.
       */
      throw new Error(`${name} is ${body.length} bytes and this calculator can `
        + `only build ${this.hello.maxVarBytes}`);
    }

    const ownerBytes = new TextEncoder().encode(owner);
    const begin = new Uint8Array(18 + ownerBytes.length);
    const view = new DataView(begin.buffer);
    for (let i = 0; i < name.length && i < 8; i++) begin[i] = name.charCodeAt(i);
    begin[8] = type;
    view.setUint32(9, body.length, true);
    view.setUint32(13, crc32(body), true);
    begin[17] = ownerBytes.length;
    begin.set(ownerBytes, 18);

    await this.request(CMD.VAR_BEGIN, begin, archive ? 1 : 0);

    try {
      let index = 0;
      for (let at = 0; at < body.length; at += chunkSize) {
        await this.request(CMD.VAR_CHUNK, body.subarray(at, at + chunkSize), index++);
        if (onProgress) onProgress(Math.min(at + chunkSize, body.length), body.length);
      }

      const reply = await this.request(CMD.VAR_END);
      const replyView = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      return {
        bytes: replyView.getUint16(0, true),
        crc: replyView.getUint32(2, true),
      };
    } catch (error) {
      /*
       * Let the calculator drop the staging variable now rather than leaving it
       * for the next session to sweep. Best effort: if the link is already gone
       * this cannot work, and the startup sweep is the backstop.
       */
      try { await this.request(CMD.VAR_ABORT); } catch { /* already gone */ }
      throw error;
    }
  }

  async deleteVariable(name, type) {
    const payload = new Uint8Array(8);
    for (let i = 0; i < name.length && i < 8; i++) payload[i] = name.charCodeAt(i);
    try {
      const reply = await this.request(CMD.VAR_DEL, payload, type);
      return reply[0] === 1;
    } catch (error) {
      /* Already gone is the outcome that was wanted, not a failure. */
      if (error instanceof ProtocolError && error.status === STATUS.NOT_FOUND) {
        return false;
      }
      throw error;
    }
  }

  async statVariable(name, type) {
    const payload = new Uint8Array(8);
    for (let i = 0; i < name.length && i < 8; i++) payload[i] = name.charCodeAt(i);
    try {
      const reply = await this.request(CMD.VAR_STAT, payload, type);
      const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      return {
        present: (reply[0] & 1) !== 0,
        archived: (reply[0] & 2) !== 0,
        bytes: view.getUint16(1, true),
        crc: view.getUint32(3, true),
      };
    } catch (error) {
      if (error instanceof ProtocolError && error.status === STATUS.NOT_FOUND) {
        return { present: false, archived: false, bytes: 0, crc: 0 };
      }
      throw error;
    }
  }

  /* ----------------------------------------------------- system payloads */

  /**
   * Send a payload that replaces a variable the calculator may be running.
   *
   * A CE program lives inside its own variable and cannot overwrite itself, so
   * BlueObject refuses any name beginning with BLUE through the ordinary
   * variable path. This is the only way one gets written: the image is staged
   * in the archive a chunk at a time, checked where it lies, and then either
   * installed straight away -- if it is not the program currently running -- or
   * armed for prgmBLUEUP to finish.
   *
   * So the two rules are the same rule. A reserved name is exactly a name that
   * has to come this way.
   */
  async putSystemPayload({ name, type, body, archive = true, slot, version },
                         onProgress = null) {
    const chunkSize = this.hello?.chunkSize || CHUNK_SIZE;
    const chunks = Math.ceil(body.length / chunkSize);

    const begin = new Uint8Array(28);
    const view = new DataView(begin.buffer);
    for (let i = 0; i < name.length && i < 8; i++) begin[i] = name.charCodeAt(i);
    begin[8] = type;
    begin[9] = archive ? 1 : 0;
    view.setUint32(10, body.length, true);
    view.setUint16(14, chunks, true);
    view.setUint32(16, crc32(body), true);
    for (let i = 0; i < version.length && i < 8; i++) {
      begin[20 + i] = version.charCodeAt(i);
    }

    await this.request(CMD.SYS_BEGIN, begin, slot);

    let index = 0;
    for (let at = 0; at < body.length; at += chunkSize) {
      await this.request(CMD.SYS_CHUNK, body.subarray(at, at + chunkSize),
                         slot | (index++ << 8));
      if (onProgress) onProgress(Math.min(at + chunkSize, body.length), body.length);
    }

    await this.request(CMD.SYS_END, new Uint8Array(0), slot);
  }

  async sweep() {
    const reply = await this.request(CMD.SWEEP);
    return new DataView(reply.buffer, reply.byteOffset, reply.byteLength)
      .getUint16(0, true);
  }
}
