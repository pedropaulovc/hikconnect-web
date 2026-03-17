import { describe, it, expect, beforeEach } from 'vitest'
import {
  CasClient,
  buildPlayRequest,
  buildTeardown,
  resetSeqNum,
  Opcode,
  AttrTag,
} from '../cas-client'
import {
  encodeV3Message,
  decodeV3Message,
  getStringAttr,
  getIntAttr,
  crc8,
  V3_HEADER_LEN,
} from '../v3-protocol'

beforeEach(() => {
  resetSeqNum()
})

describe('buildPlayRequest', () => {
  const params = {
    busType: 1,
    sessionKey: 'abc123',
    streamType: 0,
    channelNo: 1,
    streamSession: 42,
  }
  const msg = buildPlayRequest(params)

  it('sets the correct opcode', () => {
    expect(msg.msgType).toBe(Opcode.PLAY_REQUEST)
  })

  it('includes all five required attributes', () => {
    const tags = msg.attributes.map(a => a.tag)
    expect(tags).toContain(AttrTag.BUS_TYPE)
    expect(tags).toContain(AttrTag.SESSION_KEY)
    expect(tags).toContain(AttrTag.STREAM_TYPE)
    expect(tags).toContain(AttrTag.CHANNEL_NO)
    expect(tags).toContain(AttrTag.STREAM_SESSION)
  })

  it('encodes busType as 1 byte', () => {
    const attr = msg.attributes.find(a => a.tag === AttrTag.BUS_TYPE)!
    expect(attr.value.length).toBe(1)
    expect(attr.value[0]).toBe(1)
  })

  it('encodes channelNo as 2-byte big-endian', () => {
    const attr = msg.attributes.find(a => a.tag === AttrTag.CHANNEL_NO)!
    expect(attr.value.length).toBe(2)
    expect(attr.value.readUInt16BE(0)).toBe(1)
  })

  it('encodes streamSession as 4-byte big-endian', () => {
    const attr = msg.attributes.find(a => a.tag === AttrTag.STREAM_SESSION)!
    expect(attr.value.length).toBe(4)
    expect(attr.value.readUInt32BE(0)).toBe(42)
  })

  it('encodes sessionKey as a string', () => {
    expect(getStringAttr(msg.attributes, AttrTag.SESSION_KEY)).toBe('abc123')
  })
})

describe('buildTeardown', () => {
  const msg = buildTeardown({
    sessionKey: 'sess-xyz',
    busType: 2,
    channelNo: 3,
    streamType: 1,
  })

  it('sets the correct opcode', () => {
    expect(msg.msgType).toBe(Opcode.TEARDOWN)
  })

  it('includes required attributes', () => {
    expect(getStringAttr(msg.attributes, AttrTag.SESSION_KEY)).toBe('sess-xyz')
    expect(getIntAttr(msg.attributes, AttrTag.BUS_TYPE)).toBe(2)
    expect(getIntAttr(msg.attributes, AttrTag.CHANNEL_NO)).toBe(3)
    expect(getIntAttr(msg.attributes, AttrTag.STREAM_TYPE)).toBe(1)
  })
})

describe('V3 frame round-trip', () => {
  it('round-trips a play request through encode and decode', () => {
    const msg = buildPlayRequest({
      busType: 1,
      sessionKey: 'test-key',
      streamType: 0,
      channelNo: 5,
      streamSession: 1000,
    })

    const frame = encodeV3Message(msg)

    // Header checks
    expect(frame[0] >> 4).toBe(0xe) // magic nibble
    expect(frame[10]).toBe(V3_HEADER_LEN) // headerLen = 12
    expect(frame.readUInt16BE(2)).toBe(Opcode.PLAY_REQUEST)

    // CRC-8 should validate
    const decoded = decodeV3Message(frame)
    expect(decoded.msgType).toBe(Opcode.PLAY_REQUEST)
    expect(getStringAttr(decoded.attributes, AttrTag.SESSION_KEY)).toBe('test-key')
    expect(getIntAttr(decoded.attributes, AttrTag.CHANNEL_NO)).toBe(5)
    expect(getIntAttr(decoded.attributes, AttrTag.STREAM_SESSION)).toBe(1000)
  })

  it('round-trips a teardown message', () => {
    const msg = buildTeardown({
      sessionKey: 'tear-key',
      busType: 2,
      channelNo: 7,
      streamType: 1,
    })

    const frame = encodeV3Message(msg)
    const decoded = decodeV3Message(frame)
    expect(decoded.msgType).toBe(Opcode.TEARDOWN)
    expect(getStringAttr(decoded.attributes, AttrTag.SESSION_KEY)).toBe('tear-key')
    expect(getIntAttr(decoded.attributes, AttrTag.BUS_TYPE)).toBe(2)
  })

  it('rejects frames with wrong magic nibble', () => {
    const msg = buildPlayRequest({
      busType: 1, sessionKey: 's', streamType: 0, channelNo: 1, streamSession: 1,
    })
    const frame = encodeV3Message(msg)
    frame[0] = 0x12 // wrong magic
    // Fix CRC so it's the magic check that fires, not CRC
    frame[11] = 0
    frame[11] = crc8(frame)
    expect(() => decodeV3Message(frame)).toThrow('Invalid V3 magic')
  })

  it('rejects frames with CRC-8 mismatch', () => {
    const msg = buildPlayRequest({
      busType: 1, sessionKey: 's', streamType: 0, channelNo: 1, streamSession: 1,
    })
    const frame = encodeV3Message(msg)
    frame[11] ^= 0xff // corrupt CRC
    expect(() => decodeV3Message(frame)).toThrow('CRC-8 mismatch')
  })
})

describe('CasClient construction', () => {
  it('starts in disconnected state', () => {
    const client = new CasClient({ host: '127.0.0.1', port: 6500 })
    expect(client.connected).toBe(false)
  })

  it('throws when sending play request without connection', () => {
    const client = new CasClient({ host: '127.0.0.1', port: 6500 })
    expect(() =>
      client.sendPlayRequest({
        busType: 1,
        sessionKey: 'x',
        streamType: 0,
        channelNo: 1,
        streamSession: 1,
      })
    ).toThrow('Not connected')
  })

  it('throws when sending teardown without connection', () => {
    const client = new CasClient({ host: '127.0.0.1', port: 6500 })
    expect(() =>
      client.sendTeardown({
        sessionKey: 'x',
        busType: 1,
        channelNo: 1,
        streamType: 0,
      })
    ).toThrow('Not connected')
  })
})
