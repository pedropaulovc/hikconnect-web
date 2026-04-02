import { describe, it, expect } from 'vitest'
import {
  V3Message,
  encodeV3Message,
  decodeV3Message,
  getStringAttr,
  getIntAttr,
  crc8,
  defaultMask,
  V3_MAGIC,
  V3_HEADER_LEN,
  Opcode,
  AttrTag,
} from '../v3-protocol'

describe('CRC-8', () => {
  it('returns 0 for empty input', () => {
    expect(crc8(new Uint8Array(0))).toBe(0x00)
  })

  it('matches server CRC-8 (poly 0x39)', () => {
    // Verified against real P2P server response:
    // e2020b030000000200000c23020400000003  (CRC at byte 11 = 0x23)
    const response = Buffer.from('e2020b030000000200000c00020400000003', 'hex') // byte 11 zeroed
    expect(crc8(response)).toBe(0x23)
  })
})

describe('V3 protocol header', () => {
  it('encodes magic byte 0xE2 at offset 0', () => {
    const msg: V3Message = {
      msgType: Opcode.PLAY_REQUEST,
      seqNum: 1,
      reserved: 0,
      mask: defaultMask(),
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)
    expect(buf[0]).toBe(V3_MAGIC)
  })

  it('encodes header length as 0x0C at offset 10', () => {
    const msg: V3Message = {
      msgType: Opcode.TEARDOWN,
      seqNum: 42,
      reserved: 0,
      mask: defaultMask(),
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)
    expect(buf[10]).toBe(V3_HEADER_LEN)
  })

  it('encodes msgType big-endian at offset 2-3', () => {
    const msg: V3Message = {
      msgType: 0x0c02,
      seqNum: 0,
      reserved: 0,
      mask: defaultMask(),
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)
    expect(buf.readUInt16BE(2)).toBe(0x0c02)
  })

  it('encodes seqNum big-endian at offset 4-7', () => {
    const msg: V3Message = {
      msgType: 0x0b02,
      seqNum: 0x12345678,
      reserved: 0,
      mask: defaultMask(),
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)
    expect(buf.readUInt32BE(4)).toBe(0x12345678)
  })

  it('computes valid CRC-8 at offset 11', () => {
    const msg: V3Message = {
      msgType: Opcode.P2P_SETUP,
      seqNum: 7,
      reserved: 0,
      mask: defaultMask(),
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)

    // Verify CRC by zeroing byte 11 and recomputing
    const storedCrc = buf[11]
    buf[11] = 0x00
    expect(crc8(buf)).toBe(storedCrc)
  })
})

describe('V3 protocol mask byte', () => {
  it('encodes encrypt flag in bit 7', () => {
    const msg: V3Message = {
      msgType: 0x0c02,
      seqNum: 0,
      reserved: 0,
      mask: defaultMask({ encrypt: true }),
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)
    expect(buf[1] & 0x80).toBe(0x80)
  })

  it('encodes saltIndex in bits 5-3', () => {
    const msg: V3Message = {
      msgType: 0x0c02,
      seqNum: 0,
      reserved: 0,
      mask: defaultMask({ saltIndex: 5 }),
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)
    expect((buf[1] >> 3) & 7).toBe(5)
  })

  it('encodes is2BLen flag in bit 1', () => {
    const msg: V3Message = {
      msgType: 0x0c02,
      seqNum: 0,
      reserved: 0,
      mask: defaultMask({ is2BLen: true }),
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)
    expect(buf[1] & 0x02).toBe(0x02)
  })

  it('round-trips all mask flags', () => {
    const msg: V3Message = {
      msgType: 0x0c02,
      seqNum: 0,
      reserved: 0,
      mask: {
        encrypt: true,
        saltVersion: 1,
        saltIndex: 7,
        expandHeader: true,
        is2BLen: true,
      },
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)
    const decoded = decodeV3Message(buf)
    expect(decoded.mask).toEqual(msg.mask)
  })
})

describe('V3 TLV attributes', () => {
  it('round-trips standard 1-byte-length attributes', () => {
    const msg: V3Message = {
      msgType: Opcode.PLAY_REQUEST,
      seqNum: 1,
      reserved: 0,
      mask: defaultMask(),
      attributes: [
        { tag: AttrTag.BUS_TYPE, value: Buffer.from([0x01]) },
        { tag: AttrTag.CHANNEL_NO, value: Buffer.from([0x00, 0x01]) },
        { tag: AttrTag.STREAM_TYPE, value: Buffer.from([0x00]) },
        { tag: AttrTag.END_MARKER, value: Buffer.alloc(0) },
      ],
    }
    const buf = encodeV3Message(msg)
    const decoded = decodeV3Message(buf)
    expect(decoded.attributes).toHaveLength(4)
    expect(decoded.attributes[0].tag).toBe(AttrTag.BUS_TYPE)
    expect(decoded.attributes[0].value).toEqual(Buffer.from([0x01]))
    expect(decoded.attributes[1].tag).toBe(AttrTag.CHANNEL_NO)
    expect(decoded.attributes[1].value).toEqual(Buffer.from([0x00, 0x01]))
  })

  it('uses 2-byte length for tag 0x07 when is2BLen is set', () => {
    const largePayload = Buffer.alloc(300, 0xab)
    const msg: V3Message = {
      msgType: Opcode.TRANSFOR_DATA,
      seqNum: 10,
      reserved: 0,
      mask: defaultMask({ is2BLen: true }),
      attributes: [
        { tag: AttrTag.LARGE_DATA, value: largePayload },
        { tag: AttrTag.END_MARKER, value: Buffer.alloc(0) },
      ],
    }
    const buf = encodeV3Message(msg)

    // Tag 0x07 should have 2-byte length at offset 12 (after header)
    expect(buf[V3_HEADER_LEN]).toBe(0x07)
    const encodedLen = buf.readUInt16BE(V3_HEADER_LEN + 1)
    expect(encodedLen).toBe(300)

    const decoded = decodeV3Message(buf)
    expect(decoded.attributes[0].tag).toBe(AttrTag.LARGE_DATA)
    expect(decoded.attributes[0].value.length).toBe(300)
    expect(decoded.attributes[0].value[0]).toBe(0xab)
  })

  it('uses 1-byte length for tag 0x07 when is2BLen is false', () => {
    const payload = Buffer.alloc(100, 0xcd)
    const msg: V3Message = {
      msgType: Opcode.TRANSFOR_DATA,
      seqNum: 10,
      reserved: 0,
      mask: defaultMask({ is2BLen: false }),
      attributes: [
        { tag: AttrTag.LARGE_DATA, value: payload },
        { tag: AttrTag.END_MARKER, value: Buffer.alloc(0) },
      ],
    }
    const buf = encodeV3Message(msg)

    // Tag 0x07 should have 1-byte length when is2BLen is false
    expect(buf[V3_HEADER_LEN]).toBe(0x07)
    expect(buf[V3_HEADER_LEN + 1]).toBe(100)

    const decoded = decodeV3Message(buf)
    expect(decoded.attributes[0].value.length).toBe(100)
  })

  it('round-trips string attributes (session key, start time)', () => {
    const msg: V3Message = {
      msgType: Opcode.PLAY_REQUEST,
      seqNum: 5,
      reserved: 0,
      mask: defaultMask(),
      attributes: [
        { tag: AttrTag.SESSION_KEY, value: Buffer.from('abc123session') },
        { tag: AttrTag.START_TIME, value: Buffer.from('2024-01-15T10:30:00Z') },
        { tag: AttrTag.STOP_TIME, value: Buffer.from('2024-01-15T11:30:00Z') },
        { tag: AttrTag.END_MARKER, value: Buffer.alloc(0) },
      ],
    }
    const decoded = decodeV3Message(encodeV3Message(msg))
    expect(getStringAttr(decoded.attributes, AttrTag.SESSION_KEY)).toBe('abc123session')
    expect(getStringAttr(decoded.attributes, AttrTag.START_TIME)).toBe('2024-01-15T10:30:00Z')
  })

  it('round-trips 4-byte integer attributes', () => {
    const streamSession = Buffer.alloc(4)
    streamSession.writeUInt32BE(0xdeadbeef, 0)
    const msg: V3Message = {
      msgType: Opcode.TEARDOWN,
      seqNum: 99,
      reserved: 0,
      mask: defaultMask(),
      attributes: [
        { tag: AttrTag.STREAM_SESSION, value: streamSession },
        { tag: AttrTag.DEVICE_SESSION, value: Buffer.from([0x00, 0x01, 0x02, 0x03]) },
        { tag: AttrTag.END_MARKER, value: Buffer.alloc(0) },
      ],
    }
    const decoded = decodeV3Message(encodeV3Message(msg))
    expect(getIntAttr(decoded.attributes, AttrTag.STREAM_SESSION)).toBe(0xdeadbeef)
    expect(getIntAttr(decoded.attributes, AttrTag.DEVICE_SESSION)).toBe(0x00010203)
  })
})

describe('V3 protocol round-trip', () => {
  it('round-trips a PLAY_REQUEST with all typical attributes', () => {
    const sessionKey = Buffer.from('L38239367')
    const streamSession = Buffer.alloc(4)
    streamSession.writeUInt32BE(9000, 0)

    const msg: V3Message = {
      msgType: Opcode.PLAY_REQUEST,
      seqNum: 42,
      reserved: 0,
      mask: defaultMask(),
      attributes: [
        { tag: AttrTag.BUS_TYPE, value: Buffer.from([0x01]) },
        { tag: AttrTag.SESSION_KEY, value: sessionKey },
        { tag: AttrTag.STREAM_TYPE, value: Buffer.from([0x00]) },
        { tag: AttrTag.CHANNEL_NO, value: Buffer.from([0x00, 0x01]) },
        { tag: AttrTag.STREAM_SESSION, value: streamSession },
        { tag: AttrTag.END_MARKER, value: Buffer.alloc(0) },
      ],
    }

    const encoded = encodeV3Message(msg)
    const decoded = decodeV3Message(encoded)

    expect(decoded.msgType).toBe(Opcode.PLAY_REQUEST)
    expect(decoded.seqNum).toBe(42)
    expect(decoded.attributes).toHaveLength(6)
    expect(getStringAttr(decoded.attributes, AttrTag.SESSION_KEY)).toBe('L38239367')
    expect(getIntAttr(decoded.attributes, AttrTag.STREAM_SESSION)).toBe(9000)
    expect(getIntAttr(decoded.attributes, AttrTag.BUS_TYPE)).toBe(1)
    expect(getIntAttr(decoded.attributes, AttrTag.CHANNEL_NO)).toBe(1)
  })

  it('round-trips a TEARDOWN message', () => {
    const msg: V3Message = {
      msgType: Opcode.TEARDOWN,
      seqNum: 100,
      reserved: 0,
      mask: defaultMask(),
      attributes: [
        { tag: AttrTag.SESSION_KEY, value: Buffer.from('sess_key_123') },
        { tag: AttrTag.BUS_TYPE, value: Buffer.from([0x02]) },
        { tag: AttrTag.CHANNEL_NO, value: Buffer.from([0x00, 0x03]) },
        { tag: AttrTag.STREAM_TYPE, value: Buffer.from([0x01]) },
        { tag: AttrTag.DEVICE_SESSION, value: Buffer.from([0x00, 0x00, 0x00, 0x07]) },
        { tag: AttrTag.END_MARKER, value: Buffer.alloc(0) },
      ],
    }
    const decoded = decodeV3Message(encodeV3Message(msg))
    expect(decoded.msgType).toBe(Opcode.TEARDOWN)
    expect(getIntAttr(decoded.attributes, AttrTag.DEVICE_SESSION)).toBe(7)
  })
})

describe('V3 protocol decode validation', () => {
  it('rejects messages shorter than 12 bytes', () => {
    expect(() => decodeV3Message(Buffer.alloc(5))).toThrow('too short')
  })

  it('rejects invalid magic nibble', () => {
    const buf = Buffer.alloc(14)
    buf[0] = 0xa2 // wrong magic
    buf[10] = 0x0c
    expect(() => decodeV3Message(buf)).toThrow('Invalid V3 magic')
  })

  it('rejects corrupted CRC', () => {
    const msg: V3Message = {
      msgType: Opcode.P2P_SETUP,
      seqNum: 1,
      reserved: 0,
      mask: defaultMask(),
      attributes: [{ tag: AttrTag.END_MARKER, value: Buffer.alloc(0) }],
    }
    const buf = encodeV3Message(msg)
    buf[11] ^= 0xff // corrupt CRC
    expect(() => decodeV3Message(buf)).toThrow('CRC-8 mismatch')
  })
})

describe('helper functions', () => {
  it('getStringAttr returns undefined for missing tag', () => {
    expect(getStringAttr([], 0x05)).toBeUndefined()
  })

  it('getIntAttr handles 1, 2, and 4 byte values', () => {
    const attrs = [
      { tag: 0x01, value: Buffer.from([0x42]) },
      { tag: 0x02, value: Buffer.from([0x01, 0x00]) },
      { tag: 0x03, value: Buffer.from([0x00, 0x00, 0x01, 0x00]) },
    ]
    expect(getIntAttr(attrs, 0x01)).toBe(0x42)
    expect(getIntAttr(attrs, 0x02)).toBe(256)
    expect(getIntAttr(attrs, 0x03)).toBe(256)
  })

  it('getIntAttr returns undefined for non-standard sizes', () => {
    const attrs = [{ tag: 0x01, value: Buffer.from([0x01, 0x02, 0x03]) }]
    expect(getIntAttr(attrs, 0x01)).toBeUndefined()
  })
})

describe('opcode constants', () => {
  it('exports correct opcode values', () => {
    expect(Opcode.PLAY_REQUEST).toBe(0x0c02)
    expect(Opcode.TEARDOWN).toBe(0x0c04)
    expect(Opcode.P2P_SETUP).toBe(0x0b02)
    expect(Opcode.PLAYBACK_PAUSE).toBe(0x0c10)
    expect(Opcode.PLAYBACK_RESUME).toBe(0x0c12)
    expect(Opcode.PLAYBACK_SEEK).toBe(0x0c14)
  })
})
