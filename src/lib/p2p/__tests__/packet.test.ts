import { describe, it, expect } from 'vitest'
import { encodeHeader, decodeHeader, PacketType } from '../packet'

describe('packet framing', () => {
  it('encodes a data packet header', () => {
    const header = encodeHeader({ type: PacketType.DATA, payloadLength: 256, seqNum: 42 })
    expect(header.length).toBe(11)
    expect(header[0]).toBe(0x24)
    expect(header[1]).toBe(0x02)
    expect(header.readUInt16BE(3)).toBe(256)
    expect(header.readUInt32BE(7)).toBe(42)
  })

  it('round-trips encode/decode', () => {
    const original = { type: PacketType.DATA, payloadLength: 1400, seqNum: 999 }
    const header = encodeHeader(original)
    const decoded = decodeHeader(header)
    expect(decoded.type).toBe(original.type)
    expect(decoded.payloadLength).toBe(original.payloadLength)
    expect(decoded.seqNum).toBe(original.seqNum)
  })
})
