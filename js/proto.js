/*
 * The BlueObject link protocol, as the browser sees it.
 *
 * This mirrors BlueObject's calc/src/proto.h. The two files are the same
 * agreement written twice, in two languages that cannot include each other's
 * headers, so they can drift -- and a constant edited on one side only is the
 * likeliest regression this project has. BlueObject's
 * tools/hosttest/check_wire.py reads both as text and fails if they disagree.
 *
 * Everything is little-endian.
 */

export const PROTO_VERSION = 1;

/* The shared V-USB CDC identifiers that srl_GetCDCStandardDescriptors presents. */
export const USB_VENDOR_ID = 0x16c0;
export const USB_PRODUCT_ID = 0x05e1;

export const HEADER_SIZE = 8;
export const CHUNK_SIZE = 8192;
export const ARG_BYTES = 16;
export const MAX_PAYLOAD = CHUNK_SIZE + ARG_BYTES;

export const HELLO_SIZE = 41;
export const ARMED_RECORD = 18;
export const VERSION_CHARS = 8;

export const CMD = {
  HELLO: 0x01,
  AUTH_BEGIN: 0x02,
  AUTH: 0x03,
  INDEX_GET: 0x04,
  INDEX_PUT: 0x05,
  VAR_BEGIN: 0x06,
  VAR_CHUNK: 0x07,
  VAR_END: 0x08,
  VAR_ABORT: 0x09,
  VAR_DEL: 0x0a,
  VAR_STAT: 0x0b,
  SPACE: 0x0c,
  LIST: 0x0d,
  SWEEP: 0x0e,
  CLOCK_SET: 0x0f,
  SYS_BEGIN: 0x10,
  SYS_CHUNK: 0x11,
  SYS_END: 0x12,
  PW_SET: 0x13,
  BYE: 0x1f,
  BUSY: 0xfe,
};

export const STATUS = {
  OK: 0,
  BAD_CMD: 1,
  BAD_LENGTH: 2,
  NO_ROOM: 3,
  WRITE_FAIL: 4,
  NOT_FOUND: 5,
  TRUNCATED: 6,
  BAD_STATE: 7,
  BAD_CRC: 8,
  AUTH_REQUIRED: 9,
  AUTH_FAILED: 10,
  NO_INDEX: 11,
  BAD_NAME: 12,
  TOO_LARGE: 13,
};

export const FLAG = {
  HELPER: 0x01,
  ARMED: 0x02,
  PASSWORD: 0x04,
  INDEX: 0x08,
  SWEPT: 0x10,
};

/*
 * What each status means to somebody who has to do something about it.
 *
 * NO_ROOM and WRITE_FAIL are both "no room" and they are not the same room:
 * one is the archive and uninstalling apps fixes it, the other is RAM and
 * uninstalling apps does nothing at all. Sending a user to delete apps that
 * were never the problem is exactly the failure this table exists to avoid.
 */
export const STATUS_TEXT = {
  [STATUS.BAD_CMD]: 'the calculator does not know that command -- it may need updating',
  [STATUS.BAD_LENGTH]: 'the calculator rejected the length of that request',
  [STATUS.NO_ROOM]: 'the archive is full -- uninstall something to make room',
  [STATUS.WRITE_FAIL]: 'the calculator ran out of RAM building the variable',
  [STATUS.NOT_FOUND]: 'not found on the calculator',
  [STATUS.TRUNCATED]: 'the transfer ended early',
  [STATUS.BAD_STATE]: 'the calculator was not expecting that just then',
  [STATUS.BAD_CRC]: 'what arrived is not what was sent',
  [STATUS.AUTH_REQUIRED]: 'this calculator needs its password first',
  [STATUS.AUTH_FAILED]: 'that password is not right',
  [STATUS.NO_INDEX]: 'this calculator has no BlueObject index yet',
  [STATUS.BAD_NAME]: 'that is not a name the calculator will accept',
  [STATUS.TOO_LARGE]: 'too big to install on this calculator',
};
