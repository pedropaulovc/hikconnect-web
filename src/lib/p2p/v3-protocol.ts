// V3 Protocol - Wire format reverse-engineered from libezstreamclient.so via Ghidra
// See docs/re/v3-protocol-opcodes.md for full specification

import { createCipheriv, createDecipheriv } from 'node:crypto'

// --- Constants ---

export const V3_MAGIC = 0xe2

export const V3_HEADER_LEN = 12

// Opcodes
export const Opcode = {
  TRANSFOR_SETUP: 0x0b00,
  P2P_SETUP: 0x0b02,
  TRANSFOR_CTRL: 0x0b03,
  TRANSFOR_DATA: 0x0b04,
  TRANSFOR_DATA2: 0x0b05,
  PUNCH_REQUEST: 0x0c00,   // Device → Client: hole-punch request
  PUNCH_RESPONSE: 0x0c01,  // Client → Device: hole-punch response
  PLAY_REQUEST: 0x0c02,
  TEARDOWN: 0x0c04,
  VOICE_TALK: 0x0c07,
  CT_CHECK: 0x0c08,
  STREAM_CTRL: 0x0c0a,
  DATA_LINK: 0x0c0b,
  PLAYBACK_PAUSE: 0x0c10,
  PLAYBACK_RESUME: 0x0c12,
  PLAYBACK_SEEK: 0x0c14,
  PLAYBACK_SEARCH: 0x0c16,
  PLAYBACK_CTRL3: 0x0c18,
  TRANSPARENT: 0x0d00,
  TRANSPARENT2: 0x0d02,
} as const

// Attribute tags
export const AttrTag = {
  TRANSFOR_DATA: 0x00,
  EXPAND_KEY_VERSION: 0x01,
  CLIENT_ID: 0x02,
  DEVICE_CHANNEL: 0x03,
  BUS_TYPE_ENC: 0x04,
  SESSION_KEY: 0x05,
  SESSION_INFO: 0x06,
  LARGE_DATA: 0x07,
  CT_STEP: 0x09,
  CT_DATA: 0x0a,
  BUS_TYPE_PREVIEW: 0x71,
  BUS_TYPE: 0x76,
  CHANNEL_NO: 0x77,
  STREAM_TYPE: 0x78,
  STREAM_INFO: 0x79,
  START_TIME: 0x7a,
  STOP_TIME: 0x7b,
  STREAM_PARAM: 0x7c,
  DEVICE_SESSION_ALT: 0x7d,
  STREAM_SESSION: 0x7e,
  STREAM_CONTROL: 0x80,
  VOICE_ENCODING: 0x81,
  PORT_COUNT: 0x82,
  STREAM_META: 0x83,
  DEVICE_SESSION: 0x84,
  SEEK_RATE: 0x85,
  DATA_LINK_VAL: 0x87,
  TRANSPARENT_EXT: 0x8d,
  EXT_PARAM1: 0xae,
  EXT_PARAM2: 0xaf,
  TIME_SEGMENT: 0xb0,
  SEEK_META: 0xb1,
  OPT_META1: 0xb2,
  OPT_META2: 0xb3,
  OPT_META3: 0xb4,
  STREAM_FLAG: 0xb5,
  OPT_META4: 0xb6,
  SEARCH_EXT: 0xb8,
  END_MARKER: 0xff,
} as const

// --- Types ---

export type V3Attribute = { tag: number; value: Buffer }

export type V3MaskFlags = {
  encrypt: boolean
  saltVersion: number
  saltIndex: number
  expandHeader: boolean
  is2BLen: boolean
}

export type V3Message = {
  msgType: number
  seqNum: number
  reserved: number
  mask: V3MaskFlags
  attributes: V3Attribute[]
}

// --- CRC-8 (Hikvision custom bitwise algorithm from libezstreamclient.so) ---

export function crc8(data: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) {
    const x = (data[i] ^ crc) & 0xff

    crc = (x & 1) ? 0x23 : 0
    if (x & 2) crc ^= 0x46
    if (x & 4) crc ^= 0x8c

    let tmp = crc >>> 1
    if ((crc ^ (x >>> 3)) & 1) tmp = (crc >>> 1) ^ 0x8c

    crc = tmp >>> 1
    if ((tmp ^ (x >>> 4)) & 1) crc = ((tmp >>> 1) | 0x80) ^ 0x0c

    tmp = crc >>> 1
    if ((crc ^ (x >>> 5)) & 1) tmp = ((crc >>> 1) | 0x80) ^ 0x0c

    crc = tmp >>> 1
    if ((tmp ^ (x >>> 6)) & 1) crc = ((tmp >>> 1) | 0x80) ^ 0x0c

    tmp = crc >>> 1
    if ((crc & 1) !== (x >>> 7)) tmp = ((crc >>> 1) | 0x80) ^ 0x0c

    crc = tmp
  }
  return crc & 0xff
}

// --- Mask byte encode/decode ---

function encodeMask(flags: V3MaskFlags): number {
  return (
    ((flags.encrypt ? 1 : 0) << 7) |
    ((flags.saltVersion & 1) << 6) |
    ((flags.saltIndex & 7) << 3) |
    ((flags.expandHeader ? 1 : 0) << 2) |
    ((flags.is2BLen ? 1 : 0) << 1)
  )
}

function decodeMask(byte: number): V3MaskFlags {
  return {
    encrypt: (byte & 0x80) !== 0,
    saltVersion: (byte >> 6) & 1,
    saltIndex: (byte >> 3) & 7,
    expandHeader: (byte & 0x04) !== 0,
    is2BLen: (byte & 0x02) !== 0,
  }
}

// --- TLV Attribute encode/decode ---

function encodeAttributes(attrs: V3Attribute[], is2BLen: boolean): Buffer {
  const parts: Buffer[] = []
  for (const attr of attrs) {
    if (attr.tag === 0x07 && is2BLen) {
      // Special: 2-byte length for tag 0x07
      const tlv = Buffer.alloc(3 + attr.value.length)
      tlv[0] = attr.tag
      tlv.writeUInt16BE(attr.value.length, 1)
      attr.value.copy(tlv, 3)
      parts.push(tlv)
    } else {
      const tlv = Buffer.alloc(2 + attr.value.length)
      tlv[0] = attr.tag
      tlv[1] = attr.value.length
      attr.value.copy(tlv, 2)
      parts.push(tlv)
    }
  }
  return Buffer.concat(parts)
}

function decodeAttributes(buf: Buffer, is2BLen: boolean): V3Attribute[] {
  const attrs: V3Attribute[] = []
  let offset = 0
  while (offset < buf.length) {
    const tag = buf[offset]
    // Tag 0xFF can be either:
    // - End marker (length 0): just terminates the attribute list
    // - Sub-TLV container (length > 0): contains nested TLVs (e.g., in P2P_SETUP)
    // Check the length byte to distinguish
    if (tag === AttrTag.END_MARKER && offset + 1 < buf.length && buf[offset + 1] === 0) {
      attrs.push({ tag, value: Buffer.alloc(0) })
      offset += 2
      break
    }
    if (tag === 0x07 && is2BLen) {
      if (offset + 3 > buf.length) break
      const len = buf.readUInt16BE(offset + 1)
      const value = Buffer.from(buf.subarray(offset + 3, offset + 3 + len))
      attrs.push({ tag, value })
      offset += 3 + len
    } else {
      if (offset + 2 > buf.length) break
      const len = buf[offset + 1]
      const value = Buffer.from(buf.subarray(offset + 2, offset + 2 + len))
      attrs.push({ tag, value })
      offset += 2 + len
    }
  }
  return attrs
}

// --- Message encode/decode ---

/** AES IV for ALL Hikvision V3 encryption: "01234567" + 8 zero bytes */
const HIK_V3_IV = Buffer.from('30313233343536370000000000000000', 'hex')

/**
 * Encrypt body with AES-128-CBC PKCS5 padding.
 * Key: first 16 bytes of the provided key buffer.
 * IV: "01234567" + 8 zeros (Hikvision V3 standard).
 */
function aes128CbcEncrypt(body: Buffer, key: Buffer): Buffer {
  const aesKey = key.subarray(0, 16)
  const cipher = createCipheriv('aes-128-cbc', aesKey, HIK_V3_IV)
  return Buffer.concat([cipher.update(body), cipher.final()])
}

function aes128CbcDecrypt(body: Buffer, key: Buffer): Buffer {
  const aesKey = key.subarray(0, 16)
  const decipher = createDecipheriv('aes-128-cbc', aesKey, HIK_V3_IV)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

export function encodeV3Message(msg: V3Message, encryptKey?: Buffer): Buffer {
  const is2BLen = msg.mask.is2BLen
  let body = encodeAttributes(msg.attributes, is2BLen)

  const shouldEncrypt = msg.mask.encrypt && encryptKey
  if (shouldEncrypt) {
    body = aes128CbcEncrypt(body, encryptKey)
  }

  const header = Buffer.alloc(V3_HEADER_LEN)
  header[0] = V3_MAGIC
  header[1] = encodeMask(msg.mask)
  header.writeUInt16BE(msg.msgType, 2)
  header.writeUInt32BE(msg.seqNum, 4)
  header.writeUInt16BE(msg.reserved, 8)
  header[10] = V3_HEADER_LEN
  header[11] = 0x00 // placeholder for CRC

  const full = Buffer.concat([header, body])
  full[11] = crc8(full)
  return full
}

export function decodeV3Message(buf: Buffer, decryptKey?: Buffer): V3Message {
  if (buf.length < V3_HEADER_LEN) {
    throw new Error(`V3 message too short: ${buf.length} bytes`)
  }

  const magic = buf[0]
  if ((magic >> 4) !== 0xe) {
    throw new Error(`Invalid V3 magic: 0x${magic.toString(16)}`)
  }

  const maskByte = buf[1]
  const mask = decodeMask(maskByte)
  const msgType = buf.readUInt16BE(2)
  const seqNum = buf.readUInt32BE(4)
  const reserved = buf.readUInt16BE(8)
  const headerLen = buf[10]

  // CRC check
  const storedCrc = buf[11]
  const checkBuf = Buffer.from(buf)
  checkBuf[11] = 0x00
  const computedCrc = crc8(checkBuf)
  if (storedCrc !== computedCrc) {
    throw new Error(`CRC-8 mismatch: stored=0x${storedCrc.toString(16)} computed=0x${computedCrc.toString(16)}`)
  }

  let bodyBuf = buf.subarray(headerLen)
  if (mask.encrypt && decryptKey) {
    bodyBuf = aes128CbcDecrypt(bodyBuf, decryptKey)
  }
  const attributes = decodeAttributes(bodyBuf, mask.is2BLen)

  return { msgType, seqNum, reserved, mask, attributes }
}

// --- Helpers ---

export function getStringAttr(attrs: V3Attribute[], tag: number): string | undefined {
  const attr = attrs.find(a => a.tag === tag)
  return attr ? attr.value.toString() : undefined
}

export function getIntAttr(attrs: V3Attribute[], tag: number): number | undefined {
  const attr = attrs.find(a => a.tag === tag)
  if (!attr) return undefined
  if (attr.value.length === 4) return attr.value.readUInt32BE(0)
  if (attr.value.length === 2) return attr.value.readUInt16BE(0)
  if (attr.value.length === 1) return attr.value[0]
  return undefined
}

/** Create a default mask with all flags off and is2BLen=true (common case) */
export function defaultMask(overrides: Partial<V3MaskFlags> = {}): V3MaskFlags {
  return {
    encrypt: false,
    saltVersion: 0,
    saltIndex: 0,
    expandHeader: false,
    is2BLen: true,
    ...overrides,
  }
}
