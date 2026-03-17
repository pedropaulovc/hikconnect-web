import { describe, it, expect } from 'vitest'
import { V3Message, encodeV3Message, decodeV3Message } from '../v3-protocol'

describe('V3 protocol', () => {
  it('round-trips a message with string and int attributes', () => {
    const msg: V3Message = {
      msgType: 0x0001,
      attributes: [
        { tag: 0x01, value: Buffer.from('L38239367') },
        { tag: 0x02, value: Buffer.from([0x00, 0x00, 0x23, 0x28]) }, // port 9000
      ],
    }
    const encoded = encodeV3Message(msg)
    const decoded = decodeV3Message(encoded)
    expect(decoded.msgType).toBe(msg.msgType)
    expect(decoded.attributes.length).toBe(2)
    expect(decoded.attributes[0].value.toString()).toBe('L38239367')
  })
})
